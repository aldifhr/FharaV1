import type { AgentDefinition, PlanSubtask } from "@/types";
import { CAPABILITY } from "@/types";
import type { ReviewFinding } from "@/utils/json";
import { QA_FIX_INTRO, VERIFY_FIX_INTRO } from "@/prompts/fix";
import { normalizeCapability } from "../capabilities";
import { ownerForFix, pickFixOwner, type FixCandidate } from "../ownership";
import { buildFixSubtask, buildReviewFixSubtask } from "../reviewLoop";

/**
 * P1b phase 3 (stage-loop fix owners): the ONLY place that answers
 * "a stage loop found problems — who fixes them, with which node, or does
 * the loop stop?". The QA loop (`services/runner/qaLoop.ts`), the
 * verification loop (`verifyLoop.ts`) and the review loop
 * (`runner/reviewLoop.ts`) each report a `fix_needed` observation after
 * their repeat guard and perform the `FixOwnerDecision` they get:
 *
 *   - `block{exhausted}`  the round bound is spent: the loop fails as before
 *                         (loop_stopped event, feedback, false / "failed")
 *   - `block{unowned}`    no implementer owns the code: the loop stops with
 *                         its reason (fix_unowned), never a guessed owner
 *   - `spawn_fix`         the one fix node, pinned to `agent`
 *
 * Pure: facts in, decision out (`uniqueKey` reads the plan's keys only).
 * The caller keeps every side effect (events, cards, persistence, running
 * the fix, applying it). Owner selection is the shared plan-040 rule
 * (`ownerForFix`), unchanged; tests/decisionEngine.golden.test.ts pins the
 * fix and exhaustion path of every loop, recorded before the move.
 */

export type FixStage = "qa" | "verify" | "review";

export interface FixNeededFacts {
  stage: FixStage;
  /** Fix rounds already spent in this loop (the loop's iteration counter). */
  round: number;
  /** The loop's round bound (qaMaxFixIterations / maxReviewIterations). */
  maxRounds: number;
  /** What must be fixed; `filePath` drives ownership, `severity` rides into the fix prompt. */
  findings: ReviewFinding[];
  /** The plan's subtasks: its code_change nodes are the owner candidates; also orders the fix. */
  nodes: ReadonlyArray<PlanSubtask>;
  /** Who wrote each node this run (the run's assignment). */
  writerByKey: ReadonlyMap<string, AgentDefinition>;
  /** The task's roster. */
  agents: AgentDefinition[];
  /** Verify only: the verification phase (QA fix rounds already in the plan). */
  verifyPhase?: number;
}

export interface FixNeededObservation {
  kind: "fix_needed";
  facts: FixNeededFacts;
}

export type FixOwnerDecision =
  | {
      kind: "spawn_fix";
      ownerAgentId: string;
      /** The owning agent the fix nodes are pinned to (assign() would re-route by capability). */
      agent: AgentDefinition;
      /** The code_change node that owns the findings. */
      ownerNodeKey: string;
      /** The fix nodes to add, in order (today: exactly one). */
      nodes: PlanSubtask[];
    }
  | { kind: "block"; reason: "exhausted" | "unowned" };

/** QA exercises the UI, so UI implementers own QA fixes first. */
export const QA_UI_CAPABILITIES: ReadonlySet<string> = new Set<string>([CAPABILITY.FRONTEND, CAPABILITY.DESIGN]);

const prefersUi = (candidate: FixCandidate) => QA_UI_CAPABILITIES.has(normalizeCapability(candidate.capability));

/** True once a loop has spent its fix rounds. */
export function fixRoundsExhausted(round: number, maxRounds: number): boolean {
  return round >= maxRounds;
}

/** The fix decision for one `fix_needed` observation. */
export function decideFixOwner(
  observation: FixNeededObservation,
  uniqueKey: (base: string) => string
): FixOwnerDecision {
  const facts = observation.facts;
  if (fixRoundsExhausted(facts.round, facts.maxRounds)) return { kind: "block", reason: "exhausted" };
  const owner = ownerForFix({
    subtasks: facts.nodes as PlanSubtask[],
    findings: facts.findings,
    agents: facts.agents,
    writerByKey: facts.writerByKey,
    ...(facts.stage === "qa" ? { prefer: prefersUi } : {}),
  });
  if (!owner) return { kind: "block", reason: "unowned" };
  const n = facts.round + 1;
  const order = facts.nodes.reduce((max, candidate) => Math.max(max, candidate.order), 0) + 1;
  const capability = owner.subtask.capability;
  // Scope the fix to the owner's files (QA findings carry no path; an
  // unscoped verify fix once edited tsconfig.json and README).
  const scope = owner.subtask.allowedPaths && owner.subtask.allowedPaths.length > 0
    ? { allowedPaths: [...owner.subtask.allowedPaths] }
    : {};
  let node: PlanSubtask;
  if (facts.stage === "review") {
    node = buildReviewFixSubtask({ iteration: n, findings: facts.findings, capability, order });
  } else if (facts.stage === "qa") {
    node = {
      ...buildFixSubtask({
        key: uniqueKey(`fix_qa_${n}`),
        title: `Address QA failures (iteration ${n})`,
        intro: QA_FIX_INTRO,
        findings: facts.findings,
        capability,
        order,
      }),
      ...scope,
    };
  } else {
    const phase = facts.verifyPhase ?? 0;
    node = {
      ...buildFixSubtask({
        key: uniqueKey(verifyFixKey(phase, n)),
        title: `Address verification failures (${phase > 0 ? `after QA fix ${phase}, ` : ""}iteration ${n})`,
        intro: VERIFY_FIX_INTRO,
        findings: facts.findings,
        capability,
        order,
      }),
      ...scope,
    };
  }
  return { kind: "spawn_fix", ownerAgentId: owner.agent._id, agent: owner.agent, ownerNodeKey: owner.subtask.key, nodes: [node] };
}

/**
 * Fix owner candidate for QA findings: the UI owner (a frontend/design
 * code_change) is preferred; otherwise the shared pickFixOwner (longest
 * allowedPaths prefix, last code_change). Same rule `decideFixOwner`
 * applies for stage "qa" through `ownerForFix({ prefer })`.
 */
export function pickQaFixOwner(
  subtasks: FixCandidate[],
  findings: Array<{ filePath?: string }>
): FixCandidate | undefined {
  const uiOwners = subtasks.filter((s) => s.kind === "code_change" && prefersUi(s));
  if (uiOwners.length > 0) return pickFixOwner(uiOwners, findings);
  return pickFixOwner(subtasks, findings);
}

/** Fix key for the n-th verification fix of a phase (phase 0 keeps the legacy `fix_verify_<n>`). */
export function verifyFixKey(phase: number, n: number): string {
  return phase > 0 ? `fix_verify_qa${phase}_${n}` : `fix_verify_${n}`;
}

/**
 * The file a failed check is about: a changed file its output names, else
 * the first file it names, else a changed file the details mention. Only
 * when nothing names a file does it fall back to the first changed file
 * (the old rule, which pinned a ThreeColumnLayout.tsx lint error on
 * src/app/search/page.tsx).
 */
export function attributeFinding(check: { details?: string; files?: string[] }, changedPaths: string[]): string {
  const named = check.files ?? [];
  return (
    named.find((file) => changedPaths.includes(file)) ??
    named[0] ??
    changedPaths.find((p) => (check.details ?? "").includes(p)) ??
    changedPaths[0] ??
    ""
  );
}
