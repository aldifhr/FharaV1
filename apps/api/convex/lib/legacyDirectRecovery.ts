/**
 * legacy: direct threads removed 2026-11-12. A leftover running one has no
 * plan to resume from and nothing runs it any more: lease recovery closes it.
 */
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { patchTask } from "./threadIndex";

export async function closeLegacyDirect(ctx: MutationCtx, taskId: Id<"tasks">, now: number): Promise<void> {
  await patchTask(ctx, taskId, {
    status: "failed",
    workerId: undefined,
    leaseExpiresAt: undefined,
    errorMessage: "Direct threads were removed; this thread is read-only.",
    completedAt: now,
    updatedAt: now,
  });
}
