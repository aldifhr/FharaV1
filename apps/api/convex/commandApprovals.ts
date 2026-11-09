/**
 * In-process command approvals (chat UX, Feature 2).
 *
 * `orchestration.requestApproval` parks the whole task in needs_approval and
 * RELEASES its lease; approving re-queues the run. That is right for
 * apply_changes (a stage boundary) but would stall or re-run the DAG for a
 * single command. A run_command approval therefore waits in-process: the
 * worker keeps its lease and heartbeat, writes a pending row here, polls
 * `get` until the user decides, and cancels the row itself on pause, stop
 * or timeout. The task status never changes.
 *
 * Policy (lib/commandRules.ts): dangerous / push-like commands always ask
 * and never offer "Always allow"; a project rule or Full access approves
 * (recorded as decidedBy "auto"); everything else asks.
 */
import { internalMutation, internalQuery, mutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess, getViewerId } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { holdsTaskLease } from "./orchestration";
import { normalizePermissionMode } from "./lib/permissionModes";
import {
  addCommandAllowRule,
  commandApprovalPolicy,
  effectiveCommandDecision,
  formatCommand,
  normalizeRulePrefix,
  type CommandDecision,
} from "./lib/commandRules";

const TERMINAL = new Set(["done", "failed", "rejected"]);
const LEASE_LOST = "Lease lost: this task is no longer owned by this worker";
/** Note recorded when a chat message declines a waiting command (threadbear behaviour). */
export const USER_REPLIED_NOTE = "user replied instead";

export const decisionValidator = v.union(v.literal("allow"), v.literal("always"), v.literal("deny"));

/**
 * Worker → backend: ask for one command. Returns `auto` (approved row
 * already written, run it), or `pending` with the row id to wait on.
 */
export const request = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    subtaskKey: v.optional(v.string()),
    executionId: v.optional(v.id("executions")),
    requestedByAgentId: v.optional(v.id("agents")),
    command: v.string(),
    args: v.array(v.string()),
    workspaceRoot: v.optional(v.string()),
    workerId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ status: "auto" | "pending"; approvalId: Id<"approvals">; reason: string; offerAlways: boolean }> => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.projectId !== args.projectId) throw new Error("Task not found");
    if (TERMINAL.has(task.status)) throw new Error(`Task is already ${task.status}`);
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) throw new Error(LEASE_LOST);
    const project = await ctx.db.get(args.projectId);
    const mode = normalizePermissionMode(task.permissionMode);
    const policy = commandApprovalPolicy({
      mode,
      command: args.command,
      args: args.args,
      rules: project?.commandAllowRules,
      workspaceRoot: args.workspaceRoot,
    });
    const line = formatCommand(args.command, args.args);
    const now = Date.now();
    const base = {
      taskId: args.taskId,
      projectId: args.projectId,
      kind: "run_command" as const,
      summary: `Run ${line}`.slice(0, 300),
      payload: { command: line, head: policy.head, inline: true, ...(policy.danger ? { danger: policy.danger } : {}) },
      toolName: "run_command",
      arguments: { command: args.command, args: args.args },
      ...(args.workspaceRoot ? { workspacePath: args.workspaceRoot } : {}),
      ...(args.requestedByAgentId ? { requestedByAgentId: args.requestedByAgentId } : {}),
      ...(args.executionId ? { executionId: args.executionId } : {}),
      ...(args.subtaskKey ? { subtaskKey: args.subtaskKey } : {}),
      offerAlways: policy.offerAlways,
    };
    if (policy.action === "auto") {
      const approvalId = await ctx.db.insert("approvals", {
        ...base,
        status: "approved",
        resolvedAt: now,
        decidedBy: "auto",
        decision: "allow",
        history: [{ at: now, status: "approved", by: "auto", mode, reason: policy.reason }],
      });
      await ctx.db.insert("taskEvents", {
        taskId: args.taskId,
        projectId: args.projectId,
        type: "approval.auto_approved",
        payload: { kind: "run_command", summary: base.summary, subtaskKey: args.subtaskKey, mode, reason: policy.reason },
        subtaskKey: args.subtaskKey,
        level: "info",
      });
      await recordAudit(ctx, {
        actor: policy.rule ? "command-rule" : "permission-mode",
        tool: "run_command",
        action: "approval.auto_approve",
        decision: "allowed",
        target: line,
        projectId: args.projectId,
        taskId: args.taskId,
        details: { mode, reason: policy.reason, approvalId, ...(policy.rule ? { rule: policy.rule.prefix } : {}) },
      });
      return { status: "auto", approvalId, reason: policy.reason, offerAlways: policy.offerAlways };
    }
    const approvalId = await ctx.db.insert("approvals", {
      ...base,
      status: "pending",
      history: [{ at: now, status: "pending", mode, reason: policy.reason }],
    });
    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "approval.requested",
      payload: { kind: "run_command", summary: base.summary, subtaskKey: args.subtaskKey, inline: true },
      executionId: args.executionId,
      subtaskKey: args.subtaskKey,
      level: "warn",
    });
    return { status: "pending", approvalId, reason: policy.reason, offerAlways: policy.offerAlways };
  },
});

/** Worker poll: the row's state plus the task status (pause / stop). */
export const get = internalQuery({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.approvalId);
    if (!row) return null;
    const task = await ctx.db.get(row.taskId);
    return {
      status: row.status,
      decision: row.decision ?? null,
      note: row.note ?? null,
      taskStatus: task?.status ?? null,
    };
  },
});

/** Worker: close a wait it gave up on (pause, stop, timeout). Idempotent. */
export const cancel = internalMutation({
  args: { approvalId: v.id("approvals"), reason: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.approvalId);
    if (!row || row.status !== "pending") return { applied: false };
    const now = Date.now();
    await ctx.db.patch(args.approvalId, {
      status: "cancelled",
      resolvedAt: now,
      note: args.reason.slice(0, 500),
      history: [...(row.history ?? []), { at: now, status: "cancelled", reason: args.reason }],
    });
    await ctx.db.insert("taskEvents", {
      taskId: row.taskId,
      projectId: row.projectId,
      type: "approval.cancelled",
      payload: { kind: row.kind, summary: row.summary, reason: args.reason },
      subtaskKey: row.subtaskKey,
      level: "info",
    });
    return { applied: true };
  },
});

/**
 * Resolve one approval with a decision. Shared by `respond`, the legacy
 * approve/reject mutations (run_command rows) and the chat-reply decline.
 */
export async function resolveCommandApproval(
  ctx: MutationCtx,
  approval: Doc<"approvals">,
  requested: CommandDecision,
  options: { note?: string; actor?: string } = {}
): Promise<CommandDecision> {
  if (approval.status !== "pending") throw new Error(`Approval already ${approval.status}`);
  const decision = effectiveCommandDecision(requested, approval.offerAlways);
  const now = Date.now();
  const note = options.note?.trim().slice(0, 1000) || undefined;
  await ctx.db.patch(approval._id, {
    status: decision === "deny" ? "rejected" : "approved",
    resolvedAt: now,
    decidedBy: "user",
    decision,
    ...(note ? { note } : {}),
    history: [...(approval.history ?? []), { at: now, status: decision === "deny" ? "rejected" : "approved", decision, by: options.actor ?? "user" }],
  });
  const command = String((approval.payload as { command?: unknown } | undefined)?.command ?? approval.summary);
  if (decision === "always") {
    const head = String((approval.payload as { head?: unknown } | undefined)?.head ?? "");
    const prefix = normalizeRulePrefix(head);
    if (prefix) {
      const project = await ctx.db.get(approval.projectId);
      const createdBy = options.actor ?? (await getViewerId(ctx)) ?? "user";
      await ctx.db.patch(approval.projectId, {
        commandAllowRules: addCommandAllowRule(project?.commandAllowRules, prefix, createdBy, now),
      });
      await recordAudit(ctx, {
        tool: "run_command",
        action: "command_rule.add",
        decision: "allowed",
        target: prefix,
        projectId: approval.projectId,
        taskId: approval.taskId,
        details: { approvalId: approval._id, command },
      });
    }
  }
  await ctx.db.insert("taskEvents", {
    taskId: approval.taskId,
    projectId: approval.projectId,
    type: decision === "deny" ? "approval.rejected" : "approval.approved",
    payload: { kind: approval.kind, summary: approval.summary, decision, ...(note ? { note } : {}) },
    subtaskKey: approval.subtaskKey,
    level: decision === "deny" ? "warn" : "info",
  });
  await recordAudit(ctx, {
    tool: "approval",
    action: decision === "deny" ? "approval.reject" : "approval.approve",
    decision: decision === "deny" ? "denied" : "allowed",
    target: approval.summary,
    projectId: approval.projectId,
    taskId: approval.taskId,
    details: {
      kind: approval.kind,
      decision,
      ...(requested !== decision ? { requested } : {}),
      ...(approval.toolName ? { toolName: approval.toolName } : {}),
    },
  });
  return decision;
}

/**
 * The user's Allow / Always allow / Deny. "always" is downgraded to "allow"
 * when the card did not offer it (server-side; the client cannot force it).
 * For non-command approvals allow/deny map to approve/reject semantics via
 * the existing mutations, so this is run_command only.
 */
export const respond = mutation({
  args: { approvalId: v.id("approvals"), decision: decisionValidator, note: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ decision: CommandDecision }> => {
    const approval = await ctx.db.get(args.approvalId);
    if (!approval) throw new Error("Approval not found");
    await assertProjectAccess(ctx, approval.projectId);
    if (approval.kind !== "run_command") throw new Error("Only command approvals take Allow / Always allow / Deny");
    const decision = await resolveCommandApproval(ctx, approval, args.decision, { note: args.note });
    return { decision };
  },
});

/**
 * A message typed while a command waits declines it (Deny, note "user
 * replied instead: …"), so the agent continues with the user's words
 * instead of blocking. Scoped to one task thread, or to the chat's
 * conversation (tasks dispatched from it, or with no conversation).
 */
export async function declineWaitingCommands(
  ctx: MutationCtx,
  scope: { projectId: Id<"projects">; conversationId?: Id<"conversations">; taskId?: Id<"tasks">; text?: string }
): Promise<number> {
  const pending = await ctx.db
    .query("approvals")
    .withIndex("by_project_and_status", (q) => q.eq("projectId", scope.projectId).eq("status", "pending"))
    .take(50);
  const snippet = (scope.text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const note = snippet ? `${USER_REPLIED_NOTE}: ${snippet}` : USER_REPLIED_NOTE;
  let declined = 0;
  for (const approval of pending) {
    if (approval.kind !== "run_command" || (approval.payload as { inline?: unknown } | undefined)?.inline !== true) continue;
    if (scope.taskId) {
      if (approval.taskId !== scope.taskId) continue;
    } else {
      const task = await ctx.db.get(approval.taskId);
      if (task?.conversationId && scope.conversationId && task.conversationId !== scope.conversationId) continue;
    }
    await resolveCommandApproval(ctx, approval, "deny", { note, actor: "chat-reply" });
    declined += 1;
  }
  return declined;
}

export const declineWaiting = internalMutation({
  args: {
    projectId: v.id("projects"),
    conversationId: v.optional(v.id("conversations")),
    taskId: v.optional(v.id("tasks")),
    text: v.optional(v.string()),
  },
  handler: async (ctx, args) => ({ declined: await declineWaitingCommands(ctx, args) }),
});

/** Manage project: remove one "Always allow" rule (audited). */
export const removeRule = mutation({
  args: { projectId: v.id("projects"), prefix: v.string() },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found");
    const head = normalizeRulePrefix(args.prefix);
    const rules = project.commandAllowRules ?? [];
    const next = rules.filter((rule) => normalizeRulePrefix(rule.prefix) !== head);
    if (next.length === rules.length) return { removed: false };
    await ctx.db.patch(args.projectId, { commandAllowRules: next });
    await recordAudit(ctx, {
      tool: "run_command",
      action: "command_rule.remove",
      decision: "recorded",
      target: head,
      projectId: args.projectId,
    });
    return { removed: true };
  },
});
