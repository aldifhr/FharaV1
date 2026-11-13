import type { QaVerdict } from "@/types/qa";
import type { DecisionAction, DecisionContext } from "../decision";

/**
 * P1b phase 1 (Decision Engine seam): the objective half of the engine.
 *
 * `evaluateObjective` (moved here from `orchestrator/decision.ts`) answers
 * "is the task objective satisfied?" from the plan and the runner's
 * evidence. `judgeObjective` is the runner's objective override (formerly
 * inline in `services/runner/decision.ts`): it decides whether the
 * objective is judgeable at this settle at all, and if so evaluates it.
 * Everything here is pure.
 */

/**
 * Plan 005 Phase 5 Step 5.1: the objective-evidence inputs the runner feeds
 * `evaluateObjective`. Files are attributed per subtask (the runner records
 * them with the producing subtask key); QA verdicts and the static
 * verification result are the runner's own. `verification` is undefined
 * until it runs — a criterion on evidence that has not been produced yet is
 * skipped, not failed.
 */
export interface ObjectiveEvidence {
  /** Applied file paths per completed subtask key (code_change nodes). */
  appliedFiles?: Record<string, string[]>;
  /** QA verdicts by subtask key. */
  qaVerdicts?: Record<string, QaVerdict>;
  /** Static verification result; undefined when it did not run. */
  verification?: { status: "passed" | "failed" | "skipped" | "skipped_env"; details?: string };
  /** The decision whose expectedOutcome is being checked for satisfaction. */
  lastDecision?: { action: DecisionAction; expectedOutcome?: string };
}

export interface ObjectiveEvaluation {
  satisfied: boolean;
  evidence: string[];
  missing: string[];
}

/** Outcomes that signal the objective is NOT yet met. "policy:budget" is
 *  deliberately absent: in warn mode a budget warning is non-fatal by
 *  design and must not poison the objective forever (that produced
 *  bogus "last decision outcome policy:budget is not met" verdicts in live
 *  runs); in enforce mode exhaustion ends the task via the explicit
 *  budget-exhausted path, not via objective evaluation. */
const UNMET_OUTCOMES = new Set(["retry", "recovery", "decision:step_limit"]);

export function isRecoveryNode(subtask: { origin?: string; key: string }, dynamicKeys?: Set<string> | ReadonlySet<string>): boolean {
  if (subtask.origin === "dynamic") return true;
  if (subtask.origin === "planned") return false;
  if (dynamicKeys?.has(subtask.key)) return true;
  return /^(decision_delegate|fix_qa|delegate_)/.test(subtask.key);
}

/**
 * Plan 005 Phase 5 Step 5.1: is the task objective satisfied? Pure: it reads
 * the plan, completed keys, open issues, and the runner-supplied evidence.
 * `complete` may only be emitted when this returns `satisfied`.
 */
export function evaluateObjective(ctx: DecisionContext): ObjectiveEvaluation {
  const evidence: string[] = [];
  const missing: string[] = [];
  const ev = ctx.objectiveEvidence ?? {};

  // Every executed code_change has an applied file change. Research/audit
  // tasks have no code_change nodes and are exempt.
  const codeChanges = ctx.plan.subtasks.filter(
    (subtask) => subtask.kind === "code_change" && ctx.completedKeys.has(subtask.key)
  );
  if (codeChanges.length === 0) {
    evidence.push("no code_change nodes in the executed graph (research/audit task)");
  } else {
    for (const subtask of codeChanges) {
      const files = ev.appliedFiles?.[subtask.key] ?? [];
      if (files.length > 0) {
        evidence.push(`${subtask.key}: ${files.length} file change(s) applied`);
      } else {
        missing.push(`${subtask.key}: code_change completed with no applied file change`);
      }
    }
  }

  // Static verification ran and did not fail when a code_change was applied.
  if (ev.verification) {
    if (ev.verification.status === "failed") {
      missing.push(`static verification failed: ${ev.verification.details ?? "no details"}`);
    } else if (ev.verification.status === "passed") {
      evidence.push("static verification passed");
    }
  }

  // Scaffold evidence (runTeam, from open-multi-agent): a React/Vite
  // migration must leave a real project structure (package.json + entry +
  // App), not a single CDN index.html.
  // Only when the task's own requirements ask for a framework project: a
  // goal that merely mentions React ("add a React button") must not grow
  // an unrequested scaffold requirement (e2e S4 replanned with "objective
  // unmet" while all 4 requirements were covered).
  const allFiles = Object.values(ev.appliedFiles ?? {}).flat();
  const needsScaffold = requiresScaffold(ctx.plan);
  if (needsScaffold && allFiles.length > 0) {
    const hasPkg = allFiles.some((f) => f === "package.json" || f.endsWith("/package.json"));
    const hasApp = allFiles.some((f) => /(src\/(main|App)\.(jsx|tsx|js|ts))$/.test(f));
    if (!hasPkg || !hasApp) {
      missing.push(
        "React scaffold incomplete: missing " +
          [!hasPkg ? "package.json" : null, !hasApp ? "src/main.jsx or src/App.jsx" : null]
            .filter(Boolean)
            .join(", ")
      );
    } else {
      evidence.push("scaffold complete: package.json + entry App present");
    }
  }

  // Required QA (if present in the plan) has a passed verdict.
  for (const subtask of ctx.plan.subtasks) {
    if (subtask.kind !== "qa") continue;
    // Dynamic delegation/recovery nodes are execution details, not new
    // objective requirements. The runner marks them explicitly; the planned
    // QA node is the only authoritative one, otherwise every retry creates
    // another required verdict and the task can never complete.
    if (isRecoveryNode(subtask, ctx.dynamicKeys)) continue;
    const verdict = ev.qaVerdicts?.[subtask.key];
    if (verdict === "passed") {
      evidence.push(`${subtask.key}: QA passed`);
    } else if (verdict === "blocked") {
      // Environment-blocked QA (no browser, no deps, no dev script) is a
      // reported skip, not missing work: replanning cannot fix the worker.
      // QA_REQUIRED makes the QA loop fail the task before this point.
      evidence.push(`${subtask.key}: QA skipped (environment blocked)`);
    } else {
      missing.push(`${subtask.key}: QA verdict is ${verdict ?? "missing"}`);
    }
  }

  // No open issue with critical/high severity.
  const openSevere = ctx.openIssues.filter(
    (issue) => issue.status === "open" && (issue.severity === "critical" || issue.severity === "high")
  );
  if (openSevere.length > 0) {
    for (const issue of openSevere) {
      missing.push(`open ${issue.severity} issue: ${issue.description}`);
    }
  } else {
    evidence.push("no open critical/high issues");
  }

  // The last decision's expectedOutcome is met.
  if (ev.lastDecision?.expectedOutcome) {
    if (UNMET_OUTCOMES.has(ev.lastDecision.expectedOutcome)) {
      missing.push(`last decision outcome "${ev.lastDecision.expectedOutcome}" is not met`);
    } else {
      evidence.push(`last decision outcome "${ev.lastDecision.expectedOutcome}" met`);
    }
  }

  return { satisfied: missing.length === 0, evidence, missing };
}

const FRAMEWORK = /\b(react|vite|next(?:\.?js)?)\b/i;
const SCAFFOLD_INTENT =
  /\b(scaffold\w*|migrat\w*|migrasi|convert\w*|konversi|port(?:ing)?|rewrite|new (?:react|vite|next)|(?:create|set ?up|init\w*|bootstrap|buat\w*|bikin\w*)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:react|vite|next(?:\.?js)?)\s*(?:app|project|aplikasi|proyek)?|(?:react|vite|next(?:\.?js)?)\s+(?:app|project|aplikasi|proyek)\s+(?:baru|from scratch))\b/i;

/**
 * True when one of the task's requirements (or, for plans without a
 * requirement list, the goal) asks for a framework project: a scaffold,
 * a migration/conversion, or a new React/Vite/Next app. A requirement that
 * only mentions the framework (a React component, a Next page) does not.
 */
export function requiresScaffold(plan: { goal?: string; requirements?: Array<{ text: string }> }): boolean {
  const texts =
    plan.requirements && plan.requirements.length > 0
      ? plan.requirements.map((requirement) => requirement.text)
      : [plan.goal ?? ""];
  return texts.some((text) => FRAMEWORK.test(text) && SCAFFOLD_INTENT.test(text));
}

/** The objective state that travels with an observation into `decide()`. */
export interface ObjectiveState {
  met: boolean;
  missing: string[];
  evidence: string[];
}

/**
 * How the objective was judged at this settle:
 *  - `empty_code_change`: a planned code_change executed THIS run and staged
 *    nothing. Never met (live test 3), whatever else is pending.
 *  - `deferred`: not judgeable (skipped node, stage-loop fix, or a planned
 *    review/QA still in flight); deferred as met with evidence.
 *  - `evaluated`: `evaluateObjective` ran.
 */
export type ObjectiveSource = "empty_code_change" | "deferred" | "evaluated";

export interface ObjectiveJudgment {
  source: ObjectiveSource;
  state: ObjectiveState;
  /** Log `orchestrator.objective_unmet` with this payload before deciding. */
  unmet: { missing: string[]; evidence: string[] } | null;
}

export interface ObjectiveJudgeInput {
  /** The decision context the observation is decided in. */
  context: DecisionContext;
  /** The settled node. */
  nodeKey: string;
  /** The node executed in THIS run (it has an execution id). */
  executed: boolean;
  /** A review / verify / QA stage loop is running its own fix nodes. */
  inStageLoop: boolean;
  completed: boolean;
  dynamicKeys: ReadonlySet<string>;
  appliedFilesBySubtask: ReadonlyMap<string, string[]>;
  qaVerdicts: Record<string, QaVerdict>;
  verification?: ObjectiveEvidence["verification"];
}

/** A planned (not dynamic) review or QA node has not settled yet: the loop owns its findings. */
export function reviewQaInFlight(
  plan: DecisionContext["plan"],
  dynamicKeys: ReadonlySet<string>,
  completedKeys: ReadonlySet<string>
): boolean {
  return plan.subtasks.some(
    (candidate) =>
      (candidate.kind === "review" || candidate.kind === "qa") &&
      !dynamicKeys.has(candidate.key) &&
      !completedKeys.has(candidate.key)
  );
}

/**
 * The runner's objective override (plan 013 step 5). Only a node that
 * EXECUTED in this run may be judged: a node skipped as "Previously
 * completed" on resume / recovery has no execution this run, and judging it
 * against rebuilt in-memory evidence would fabricate a verdict. While a
 * review or QA loop is in flight its open findings are expected, so the
 * objective is not judgeable either.
 */
export function judgeObjective(input: ObjectiveJudgeInput): ObjectiveJudgment {
  const { context, nodeKey } = input;
  const subtask = context.plan.subtasks.find((candidate) => candidate.key === nodeKey);
  const emptyCodeChange =
    input.executed &&
    !input.inStageLoop &&
    input.completed &&
    subtask?.kind === "code_change" &&
    (input.appliedFilesBySubtask.get(nodeKey)?.length ?? 0) === 0;
  if (emptyCodeChange) {
    const missing = [`${nodeKey}: code_change completed with no applied file change`];
    return { source: "empty_code_change", state: { met: false, missing, evidence: [] }, unmet: { missing, evidence: [] } };
  }
  if (!input.executed || input.inStageLoop || reviewQaInFlight(context.plan, input.dynamicKeys, context.completedKeys)) {
    return {
      source: "deferred",
      state: {
        met: true,
        missing: [],
        evidence: ["objective evaluation deferred (skipped node, review/QA loop in flight, or loop fix)"],
      },
      unmet: null,
    };
  }
  const objective = evaluateObjective({
    ...context,
    dynamicKeys: input.dynamicKeys,
    objectiveEvidence: {
      appliedFiles: Object.fromEntries(input.appliedFilesBySubtask),
      qaVerdicts: input.qaVerdicts,
      verification: input.verification,
    },
  });
  return {
    source: "evaluated",
    state: { met: objective.satisfied, missing: objective.missing, evidence: objective.evidence },
    unmet: objective.satisfied ? null : { missing: objective.missing, evidence: objective.evidence },
  };
}
