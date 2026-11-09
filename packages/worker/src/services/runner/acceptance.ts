import { promises as fs } from "node:fs";
import {
  acceptanceFromGates,
  defaultGatesForKind,
  evaluateGates,
  type GateResult,
} from "@/api/convex/lib/subtaskContract";
import { resolveSandboxPath } from "@/tools/sandbox";
import type { PlanSubtask } from "@/types";
import type { RunContext } from "./types";

/** Kinds whose delivery is judged by gates (QA / shell carry their own verdicts). */
const GATED_KINDS = new Set(["code_change", "research", "audit", "analysis", "review"]);

export interface AcceptanceOutcome {
  /** Planned subtasks whose gates were evaluated. */
  evaluated: string[];
  rejected: Array<{ key: string; reason: string }>;
}

/** The review verdict covering a subtask: a review node depending on it, else the latest one. */
function reviewFor(ctx: RunContext, subtask: PlanSubtask): { verdict: string; reviewKey: string } | null {
  const verdicts = ctx.state.reviewVerdicts;
  if (subtask.kind === "review") {
    const own = verdicts[subtask.key];
    return own ? { verdict: own.verdict, reviewKey: subtask.key } : null;
  }
  const reviews = ctx.plan.subtasks.filter((candidate) => candidate.kind === "review" && verdicts[candidate.key]);
  const covering = reviews.filter((review) => review.dependencies.includes(subtask.key));
  const pick = (covering.length > 0 ? covering : reviews).at(-1);
  return pick ? { verdict: verdicts[pick.key].verdict, reviewKey: pick.key } : null;
}

async function existsOnDisk(workspacePath: string, target: string): Promise<boolean | undefined> {
  try {
    await fs.access(resolveSandboxPath(workspacePath, target));
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    return undefined;
  }
}

/**
 * Plan 022 acceptance stage, after apply / verification / QA: executor
 * "done" is only `delivered`; each planned subtask's gates are evaluated
 * from evidence the run already has (verification checks → typecheck /
 * test / command gates, the reviewer verdict → review gates, the workspace
 * → file_exists, the subtask's own answer → output gates) and stored as
 * gateResults. A subtask is `accepted` only when no required gate failed.
 * Runner-added nodes (fixes, delegations) are covered by their parent's
 * gates and are not evaluated on their own.
 */
export async function runAcceptanceStage(ctx: RunContext): Promise<AcceptanceOutcome> {
  const { plan, state, deps, taskId, project, input, dynamicKeys, runCompleted } = ctx;
  const subjects = plan.subtasks.filter(
    (subtask) => GATED_KINDS.has(subtask.kind) && !dynamicKeys.has(subtask.key) && runCompleted.has(subtask.key)
  );
  const outcome: AcceptanceOutcome = { evaluated: [], rejected: [] };
  if (subjects.length === 0) return outcome;

  // file_exists targets are resolved up front (evaluateGates is sync).
  const existence = new Map<string, boolean | undefined>();
  for (const subtask of subjects) {
    for (const gate of subtask.acceptance ?? []) {
      if (gate.check !== "file_exists" || !gate.target || existence.has(gate.target)) continue;
      const staged = state.fileChanges.get(gate.target);
      existence.set(
        gate.target,
        staged ? staged.changeType !== "deleted" : await existsOnDisk(input.workspacePath, gate.target)
      );
    }
  }

  const verification = state.verificationChecks
    ? { ran: true, checks: state.verificationChecks }
    : { ran: false, checks: [] };
  const summary: Array<{ key: string; status: string; gates: Array<{ id: string; status: GateResult["status"] }> }> = [];
  for (const subtask of subjects) {
    const gates = subtask.acceptance ?? defaultGatesForKind(subtask.kind);
    const results = evaluateGates({
      kind: subtask.kind,
      gates,
      verification,
      review: reviewFor(ctx, subtask),
      output: state.deliveredOutputs?.get(subtask.key) ?? state.priorOutputs.get(subtask.key),
      fileExists: (target) => existence.get(target),
    });
    const verdict = acceptanceFromGates(gates, results);
    outcome.evaluated.push(subtask.key);
    if (verdict.status === "rejected") outcome.rejected.push({ key: subtask.key, reason: verdict.reason ?? "gate failed" });
    summary.push({ key: subtask.key, status: verdict.status, gates: results.map((r) => ({ id: r.gateId, status: r.status })) });
    await deps.api
      .recordSubtaskAcceptance?.({
        taskId,
        key: subtask.key,
        acceptanceStatus: verdict.status,
        ...(verdict.reason ? { acceptanceReason: verdict.reason } : {}),
        gateResults: results,
      })
      ?.catch(() => undefined);
  }
  await deps.api
    .logEvent({
      taskId,
      projectId: project._id,
      type: "acceptance.evaluated",
      payload: {
        accepted: summary.filter((s) => s.status === "accepted").map((s) => s.key),
        rejected: outcome.rejected,
        subtasks: summary,
      },
      level: outcome.rejected.length > 0 ? "warn" : "info",
    })
    .catch(() => undefined);
  return outcome;
}

/** Mark rejected subtasks blocked once no fix iteration is left. */
export async function blockRejected(ctx: RunContext, rejected: AcceptanceOutcome["rejected"]): Promise<void> {
  for (const entry of rejected) {
    await ctx.deps.api
      .recordSubtaskAcceptance?.({
        taskId: ctx.taskId,
        key: entry.key,
        acceptanceStatus: "blocked",
        acceptanceReason: `Acceptance gates still failing and no fix iteration is left: ${entry.reason}`.slice(0, 500),
      })
      ?.catch(() => undefined);
  }
}
