/**
 * L6: never redo a push, PR or apply after a crash when it may already have
 * happened.
 *
 * Every external write runs through `guardedEffect`: the ledger row is
 * `armed` before the write and `accepted` + `terminal` after it. A later
 * attempt (requeued push lease, recovered task) that finds the row armed or
 * accepted does NOT write again: it asks reality (`reconcile`: remote branch
 * SHA via `git ls-remote`, PR by head branch, file hashes) and settles the
 * row `terminal`, or marks it `ambiguous` and the user gets a card
 * (Check / Mark done / Retry). Phase model from embassy's DELIVERY.md
 * (MIT, Copyright (c) 2026 YuanpingSong), ideas only.
 */
import type { WorkerApi } from "@/workerApi";

export type SideEffectKind = "push" | "pr_create" | "apply" | "restore";

export type SideEffectApi = Pick<
  WorkerApi,
  "armSideEffect" | "acceptSideEffect" | "settleSideEffect" | "markSideEffectAmbiguous"
>;

/** What reality says about an armed effect. */
export type Reconciled<T> =
  /** It happened: settle `terminal` done, never write again. */
  | { status: "done"; value: T; evidence?: unknown }
  /** Positive proof it did not happen (only honoured when `absentIsSafe`). */
  | { status: "absent"; evidence?: unknown }
  /** Cannot tell: ambiguous, ask the user. */
  | { status: "unknown"; reason: string; evidence?: unknown };

export type GuardedResult<T> =
  | { status: "performed"; value: T }
  | { status: "reconciled"; value: T }
  | { status: "already_done"; value: T | undefined; evidence: unknown }
  | { status: "ambiguous"; reason: string }
  | { status: "failed"; error: unknown };

export interface GuardedEffectInput<T> {
  api: SideEffectApi;
  workerId: string;
  key: string;
  kind: SideEffectKind;
  taskId?: string;
  projectId?: string;
  pushId?: string;
  /** Plain words for the card ("push of fhara/t/x@abc1234 to acme/app"). */
  label: string;
  /** The external write. */
  perform: () => Promise<T>;
  /** Ask reality what an earlier attempt did. Must not write. */
  reconcile: () => Promise<Reconciled<T>>;
  /** Treat `absent` as positive proof nothing was written (re-perform). */
  absentIsSafe?: boolean;
  /**
   * Whether a failed `perform` proves nothing was written ("failed": the
   * effect may run again) or not ("ambiguous": e.g. a timeout after the
   * request was sent). Default: every error is a clean failure.
   */
  classifyError?: (error: unknown) => "failed" | "ambiguous";
  /** Evidence stored on success (no secrets). */
  evidenceOf?: (value: T) => unknown;
  /** Rebuild the value from stored evidence for `already_done`. */
  fromEvidence?: (evidence: unknown) => T | undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one external write under the ledger. Never throws for the write's own
 * failure (returned as `failed`); a ledger call that fails before the write
 * throws, so nothing is written without an armed row (fail closed).
 */
export async function guardedEffect<T>(input: GuardedEffectInput<T>): Promise<GuardedResult<T>> {
  const armed = await input.api.armSideEffect({
    key: input.key,
    kind: input.kind,
    workerId: input.workerId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.pushId ? { pushId: input.pushId } : {}),
  });
  const effectId = armed.effectId as string;
  const ambiguous = async (reason: string, evidence?: unknown): Promise<GuardedResult<T>> => {
    await input.api
      .markSideEffectAmbiguous({
        effectId,
        workerId: input.workerId,
        reason,
        label: input.label,
        ...(evidence !== undefined ? { evidence } : {}),
      })
      .catch(() => undefined);
    return { status: "ambiguous", reason };
  };

  if (armed.decision === "done") {
    return { status: "already_done", value: input.fromEvidence?.(armed.evidence), evidence: armed.evidence };
  }
  if (armed.decision === "ambiguous") {
    return { status: "ambiguous", reason: "waiting for your decision on the earlier attempt" };
  }
  if (armed.decision === "reconcile") {
    let seen: Reconciled<T>;
    try {
      seen = await input.reconcile();
    } catch (error) {
      seen = { status: "unknown", reason: `could not check: ${message(error)}` };
    }
    if (seen.status === "done") {
      const evidence = seen.evidence ?? input.evidenceOf?.(seen.value);
      await input.api.settleSideEffect({
        effectId,
        workerId: input.workerId,
        outcome: "done",
        ...(evidence !== undefined ? { evidence } : {}),
        reason: "reconciled from reality",
      });
      return { status: "reconciled", value: seen.value };
    }
    if (seen.status === "unknown" || !input.absentIsSafe) {
      const reason =
        seen.status === "unknown" ? seen.reason : "an earlier attempt was interrupted and the result is not visible";
      return await ambiguous(reason, seen.evidence);
    }
    // absent + absentIsSafe: positive proof nothing was written; write now.
  }

  let value: T;
  try {
    value = await input.perform();
  } catch (error) {
    const kind = input.classifyError?.(error) ?? "failed";
    if (kind === "ambiguous") {
      await ambiguous(`the write was interrupted: ${message(error).slice(0, 300)}`);
    } else {
      await input.api
        .settleSideEffect({ effectId, workerId: input.workerId, outcome: "failed", reason: message(error).slice(0, 500) })
        .catch(() => undefined);
    }
    return { status: "failed", error };
  }
  const evidence = input.evidenceOf?.(value);
  // Accepted first (the provider took it), then terminal. If the worker
  // dies between the two, the next attempt reconciles instead of writing.
  await input.api
    .acceptSideEffect({ effectId, workerId: input.workerId, ...(evidence !== undefined ? { evidence } : {}) })
    .catch(() => undefined);
  await input.api
    .settleSideEffect({ effectId, workerId: input.workerId, outcome: "done", ...(evidence !== undefined ? { evidence } : {}) })
    .catch(() => undefined);
  return { status: "performed", value };
}
