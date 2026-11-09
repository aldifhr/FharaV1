import { query } from "./_generated/server";
import { v } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { assertProjectAccess, getVisibleTask } from "./authz";

/**
 * Plan 015 — central authorization broker.
 *
 * One server-side decision point for risky agent actions:
 *  - "allow": a live approval covers this task + workspace action.
 *  - "ask": no approval exists yet; the runner must request one.
 *  - "deny": the action targets outside the workspace, or a prior denial
 *    stands, or the task is terminal.
 *
 * This is a read-only verdict function — recording the approval itself
 * still flows through `orchestration.requestApproval` (token-gated) and
 * resolvers in `approvals.ts`.
 */

export type PermissionDecision = "allow" | "deny" | "ask";

const RISKY_KINDS = new Set(["apply_changes", "git_push", "run_command", "merge_pr"]);

function mainWorkspaceEscape(workspaceRoot: string, target: string): boolean {
  const normalizedRoot = workspaceRoot.replace(/[\\/]+$/, "").toLowerCase();
  const normalizedTarget = target.replace(/[\\/]+$/, "").toLowerCase();
  if (!normalizedRoot) return true;
  if (normalizedTarget === normalizedRoot) return false;
  return !(normalizedTarget.startsWith(normalizedRoot + "/") || normalizedTarget.startsWith(normalizedRoot + "\\"));
}

export interface DecidePermissionArgs {
  taskId: Id<"tasks">;
  projectId: Id<"projects">;
  kind: "apply_changes" | "git_push" | "run_command" | "merge_pr";
  targetPath: string;
}

export async function decidePermissionCore(
  ctx: QueryCtx,
  args: DecidePermissionArgs
): Promise<{ decision: PermissionDecision; reason: string; approvalId?: string }> {
  let project: Awaited<ReturnType<typeof assertProjectAccess>>;
  try {
    project = await assertProjectAccess(ctx, args.projectId);
  } catch {
    return { decision: "deny", reason: "Project not visible" };
  }
  const task = await getVisibleTask(ctx, args.taskId);
  if (!task) return { decision: "deny", reason: "Task not visible" };
  if (!RISKY_KINDS.has(args.kind)) {
    return { decision: "allow", reason: `Kind "${args.kind}" is not gated by the broker` };
  }
  const workspaceRoot = project.workspacePath;
  if (workspaceRoot && mainWorkspaceEscape(workspaceRoot, args.targetPath)) {
    return {
      decision: "deny",
      reason: `Target path escapes the workspace root`,
    };
  }
  const now = Date.now();
  const rows = await ctx.db
    .query("approvals")
    .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
    .collect();
  const relevant = rows.filter((row) => row.kind === args.kind);
  const live = relevant.filter(
    (row) => row.expiresAt === undefined || row.expiresAt > now
  );
  const approved = live.find((row) => row.status === "approved");
  if (approved) {
    return {
      decision: "allow",
      reason: "Covered by approved approval",
      approvalId: approved._id as string,
    };
  }
  const pending = live.find((row) => row.status === "pending");
  if (pending) {
    return {
      decision: "ask",
      reason: "Approval already pending for this action",
      approvalId: pending._id as string,
    };
  }
  const rejected = live.find((row) => row.status === "rejected");
  if (rejected) {
    return {
      decision: "deny",
      reason: "Previously rejected; a new request is required",
      approvalId: rejected._id as string,
    };
  }
  return { decision: "ask", reason: "No approval exists yet" };
}

export const decidePermission = query({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    kind: v.union(
      v.literal("apply_changes"),
      v.literal("git_push"),
      v.literal("run_command"),
      v.literal("merge_pr")
    ),
    targetPath: v.string(),
  },
  handler: decidePermissionCore,
});
