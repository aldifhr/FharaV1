import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { hashContent, type FileDiff } from "@/tools/gitDiff";
import { resolveSandboxPathAsync } from "@/tools/sandbox";
import { guardedEffect, type Reconciled, type SideEffectApi } from "@/services/sideEffects";

/**
 * L6: the apply of staged changes under the no-replay ledger.
 *
 * The ledger key is the batch itself (task + every file's path and new
 * content hash), so the same approved batch is one effect however many
 * times the run is resumed. A later attempt that finds it armed reconciles
 * each file by hash instead of writing blindly:
 *  - disk = new content hash → already applied;
 *  - disk = old content hash (or a new file still missing) → not applied;
 *  - anything else → somebody else changed it: ambiguous, ask the user.
 * All applied → terminal done. Some not applied, none changed by others →
 * the writes continue (`applyFileChange` skips files already at the new
 * hash). Any foreign change → ambiguous, nothing written.
 */

export type FileApplyState = "applied" | "pending" | "conflict";

export async function fileApplyState(workspaceRoot: string, change: FileDiff): Promise<FileApplyState> {
  const resolved = await resolveSandboxPathAsync(workspaceRoot, change.filePath);
  let current: string | null;
  try {
    current = await fs.readFile(resolved, "utf-8");
  } catch (error) {
    if ((error as { code?: string })?.code !== "ENOENT") throw error;
    current = null;
  }
  const expectedOld = change.oldContentHash ?? (change.oldContent !== undefined ? hashContent(change.oldContent) : undefined);
  const expectedNew = change.newContentHash ?? hashContent(change.newContent ?? "");
  if (change.changeType === "deleted") {
    if (current === null) return "applied";
    return !expectedOld || hashContent(current) === expectedOld ? "pending" : "conflict";
  }
  if (current === null) return change.changeType === "new" ? "pending" : "conflict";
  const hash = hashContent(current);
  if (hash === expectedNew) return "applied";
  if (change.changeType === "modified" && (!expectedOld || hash === expectedOld)) return "pending";
  return "conflict";
}

/** Stable key for one batch of staged changes. */
export function applyEffectKey(taskId: string, changes: readonly FileDiff[]): string {
  const parts = changes
    .map((c) => `${c.filePath}\u0000${c.changeType}\u0000${c.changeType === "deleted" ? "" : c.newContentHash ?? hashContent(c.newContent ?? "")}`)
    .sort();
  const digest = createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 32);
  return `apply:${taskId}:${digest}`;
}

/**
 * Content fingerprint of a set of changes (path, change type, new content
 * hash), order-independent. Static verification records it on the run
 * state so finalize can skip re-verifying content that was already
 * verified (Phase 5 Step 5.1).
 */
export function contentFingerprint(
  changes: ReadonlyArray<Pick<FileDiff, "filePath" | "changeType" | "newContentHash" | "newContent">>
): string {
  const parts = changes
    .map((c) => `${c.filePath}\u0000${c.changeType}\u0000${c.changeType === "deleted" ? "" : c.newContentHash ?? hashContent(c.newContent ?? "")}`)
    .sort();
  return createHash("sha256").update(parts.join("\u0001")).digest("hex");
}

/** The ledger half of an API double, when present. */
export function ledgerOf(api: unknown): SideEffectApi | null {
  const a = api as Partial<SideEffectApi> | null | undefined;
  if (
    a &&
    typeof a.armSideEffect === "function" &&
    typeof a.acceptSideEffect === "function" &&
    typeof a.settleSideEffect === "function" &&
    typeof a.markSideEffectAmbiguous === "function"
  ) {
    return a as SideEffectApi;
  }
  return null;
}

export type LedgerApplyOutcome<R> =
  | { kind: "result"; result: R }
  | { kind: "already_applied" }
  | { kind: "ambiguous"; reason: string };

/**
 * Run `writeAll` (the file writes) under the ledger. `isStop` tells a stop
 * result (cancel / failed write) from success: a stop settles `failed`,
 * which is safe to re-arm because every write is hash-guarded.
 */
export async function applyUnderLedger<R>(input: {
  api: SideEffectApi;
  workerId: string;
  taskId: string;
  projectId: string;
  workspaceRoot: string;
  changes: readonly FileDiff[];
  writeAll: () => Promise<R>;
  isStop: (result: R) => boolean;
}): Promise<LedgerApplyOutcome<R>> {
  class Stopped extends Error {
    constructor(readonly result: R) {
      super("apply stopped");
    }
  }
  const outcome = await guardedEffect<R | null>({
    api: input.api,
    workerId: input.workerId,
    key: applyEffectKey(input.taskId, input.changes),
    kind: "apply",
    taskId: input.taskId,
    projectId: input.projectId,
    label: `the apply of ${input.changes.length} file(s)`,
    perform: async () => {
      const result = await input.writeAll();
      if (input.isStop(result)) throw new Stopped(result);
      return result;
    },
    reconcile: async (): Promise<Reconciled<R | null>> => {
      const states = await Promise.all(input.changes.map((c) => fileApplyState(input.workspaceRoot, c)));
      const conflicts = input.changes.filter((_, i) => states[i] === "conflict").map((c) => c.filePath);
      const evidence = { files: input.changes.map((c, i) => ({ filePath: c.filePath, state: states[i] })) };
      if (conflicts.length > 0) {
        return { status: "unknown", reason: `changed by someone else since the interrupted apply: ${conflicts.join(", ")}`, evidence };
      }
      if (states.every((s) => s === "applied")) return { status: "done", value: null, evidence };
      return { status: "absent", evidence };
    },
    // Partly written is fine to resume: each write checks the file's hash.
    absentIsSafe: true,
    classifyError: () => "failed",
  });
  switch (outcome.status) {
    case "performed":
      return { kind: "result", result: outcome.value as R };
    case "reconciled":
      return { kind: "already_applied" };
    case "already_done": {
      // Done before; the files may have moved since (a reset worktree).
      // The writes are hash-guarded: applied files are skipped, a foreign
      // change stops with a stale-file error instead of being overwritten.
      return { kind: "result", result: await input.writeAll() };
    }
    case "ambiguous":
      return { kind: "ambiguous", reason: outcome.reason };
    case "failed":
      if (outcome.error instanceof Stopped) return { kind: "result", result: outcome.error.result };
      throw outcome.error;
  }
}
