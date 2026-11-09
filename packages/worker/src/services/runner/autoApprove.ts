import {
  autoApprovalDecision,
  normalizePermissionMode,
  type ApprovalKind,
  type PermissionMode,
} from "@/api/convex/lib/permissionModes";
import type { FileDiff } from "@/tools/gitDiff";
import type { RunContext } from "./types";

/** The task's permission mode (plan 020). Pre-020 tasks are supervised. */
export function taskPermissionMode(ctx: Pick<RunContext, "input">): PermissionMode {
  return normalizePermissionMode((ctx.input.task as { permissionMode?: unknown }).permissionMode);
}

/**
 * Whether the plan-level "ask before apply" gate can be handed to the
 * broker path, where the auto-approval is attempted. Only a mode that may
 * auto-approve file changes skips the plan gate; the broker path still
 * asks when the auto-approval is refused.
 */
export function mayAutoApproveEdits(ctx: Pick<RunContext, "input">): boolean {
  return autoApprovalDecision(taskPermissionMode(ctx), "apply_changes").auto;
}

export interface AutoApproveRequest {
  kind: ApprovalKind;
  summary: string;
  /** Approval payload; `filePaths` must cover every file the apply writes. */
  payload: Record<string, unknown>;
  /** The changes the apply writes (for the delete threshold). */
  changes: FileDiff[];
  subtaskKey?: string;
  requestedByAgentId?: string;
  planVersion?: number;
  /** The policy dry-run did not come back clean. */
  policyFlagged?: boolean;
}

/**
 * Try to approve automatically under the task's permission mode. Returns
 * true when an `approved` row (decidedBy "auto") was recorded and the
 * caller may apply right away, without pausing the task. Returns false in
 * supervised mode, for push / PR, for risky batches, and on any backend
 * error (fail closed: the caller requests a normal approval).
 */
export async function tryAutoApprove(ctx: RunContext, request: AutoApproveRequest): Promise<boolean> {
  const { deps, project, taskId } = ctx;
  const mode = taskPermissionMode(ctx);
  const risk = {
    deletes: request.changes.filter((change) => change.changeType === "deleted").length,
    ...(request.policyFlagged ? { policyFlagged: true } : {}),
  };
  // Local pre-check: no backend call in supervised mode or for push / PR.
  if (!autoApprovalDecision(mode, request.kind, risk).auto) return false;
  try {
    const result = await deps.api.autoApprove({
      taskId,
      projectId: project._id,
      kind: request.kind,
      summary: request.summary,
      payload: request.payload,
      risk,
      ...(request.subtaskKey ? { subtaskKey: request.subtaskKey } : {}),
      ...(request.requestedByAgentId ? { requestedByAgentId: request.requestedByAgentId as any } : {}),
      ...(request.planVersion !== undefined ? { planVersion: request.planVersion } : {}),
    });
    return result.autoApproved === true;
  } catch (error) {
    // Lease lost or backend down: never apply without a recorded approval.
    await deps.api
      .logEvent({
        taskId,
        projectId: project._id,
        type: "approval.auto_failed",
        payload: { kind: request.kind, message: error instanceof Error ? error.message : String(error) },
        level: "warn",
      })
      .catch(() => undefined);
    return false;
  }
}
