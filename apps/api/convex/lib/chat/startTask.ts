/**
 * Task creation from a project chat (moved out of chat.ts, P1a): an explicit
 * command ("/task …", "kerjakan …", "kerjakan itu" after an offer) and a bare
 * go reply ("gas", "lanjut") after a Create task offer. Every path picks its
 * pool through lib/chat/taskAssignees.ts and stores the routing hint on the
 * task (tasks.routingHint), so the worker planner starts from chat's routing.
 */
import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import type { PermissionMode } from "../permissionModes";
import type { RoutingHint } from "../routingHint";
import { targetsOutsideRepo } from "./intent";
import { extractAgentMentions, type ChatAgent } from "./team";
import { hintForCommand, resolveTaskAssignees, routedOwners } from "./taskAssignees";

export type ChatTaskArgs = {
  projectId: Id<"projects">;
  conversationId?: Id<"conversations">;
  preferredAgentIds?: Id<"agents">[];
  userMessageId: Id<"messages">;
  permissionMode?: PermissionMode;
};

export const TERMINAL_TASK_STATUSES = ["done", "rejected", "failed", "cancelled"];

/** Refusal copy for a request that targets a path outside the repository. */
export function outsideRepoReply(text: string, outsidePath: string): string {
  const indonesian = /\b(hapus|ubah|edit|tambah\w*|buat\w*|dan|yang|tolong|jangan)\b/i.test(text) && /\b(dan|yang|tolong|hapus|buat\w*)\b/i.test(text);
  return indonesian
    ? `Saya tidak membuat task untuk ini: \`${outsidePath}\` ada di luar repository project. Tim hanya mengubah file di dalam folder project.`
    : `I won't create a task for this: \`${outsidePath}\` is outside the project repository. The team only changes files inside the project folder.`;
}

/** The offer a task is started from (findOfferedTask). */
export type StartOffer = {
  command: string;
  title?: string;
  reply: string;
  messageId?: Id<"messages">;
  assigneeAgentId?: string;
  hint?: RoutingHint;
};

/**
 * Creates the task (idempotent per live command) and posts System's
 * "Task created · planning" line with the assignment card.
 */
async function createChatTask(
  ctx: ActionCtx,
  args: ChatTaskArgs,
  opts: {
    command: string;
    title: string;
    team: ChatAgent[];
    assignees: ChatAgent[];
    hint: RoutingHint;
    conversationContext?: boolean;
    offerMessageId?: Id<"messages">;
    failureHint: string;
  }
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- lazy import of the generated api (avoids an import cycle)
  const { api } = (await import("../../_generated/api.js")) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- listByProject rows
  const existing = (await ctx.runQuery(api.tasks.listByProject, { projectId: args.projectId })) as any[];
  if (existing.some((t) => t.command === opts.command && !TERMINAL_TASK_STATUSES.includes(t.status))) return; // already dispatched
  const scope = { projectId: args.projectId, conversationId: args.conversationId, replyToMessageId: args.userMessageId };
  const { assignees, team } = opts;
  try {
    const taskId = await ctx.runMutation(api.tasks.createFromCommand, {
      projectId: args.projectId,
      command: opts.command,
      title: opts.title,
      conversationId: args.conversationId,
      ...(opts.conversationContext === false ? { conversationContext: false } : {}),
      ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
      ...(assignees.length ? { assignedAgentIds: assignees.map((a) => a._id) } : {}),
      routingHint: opts.hint,
      // Marks the offer used: its button shows "Task created".
      ...(opts.offerMessageId ? { offerMessageId: opts.offerMessageId } : {}),
    });
    const cto = /^(?:cto|architect)$/i;
    await ctx.runMutation(internal.chatContext.insertSystemLine, {
      ...scope,
      taskId,
      content: "Task created · planning",
      card: {
        kind: "assignment",
        data: {
          taskId: String(taskId),
          title: opts.title,
          assignees: (assignees.length ? assignees : team)
            .filter((a) => !cto.test(a.role.trim()))
            .map((a) => ({ agentId: String(a._id), name: a.name, role: a.role })),
          assignedBy: "System",
        },
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    console.error("Chat task creation failed:", message);
    // Never pretend execution is running.
    await ctx.runMutation(internal.chatContext.insertSystemLine, { ...scope, content: `Task not created: ${message}. ${opts.failureHint}` });
  }
}

/**
 * Explicit dispatch: "/task …" or "kerjakan …" creates the task row and skips
 * the chat loop. Owners: the user's @mentions, else the routed topic owner
 * (lib/chat/taskAssignees.ts, no Backend default). "kerjakan itu" after an
 * offer (`offer` set) keeps that offer's assignee and hint.
 */
export async function dispatchTaskFromChat(
  ctx: ActionCtx,
  args: ChatTaskArgs,
  opts: {
    text: string;
    team: ChatAgent[];
    orchestrator: ChatAgent | null;
    title?: string;
    conversationContext?: boolean;
    offer?: { assigneeAgentId?: string; hint?: RoutingHint } | null;
  }
): Promise<void> {
  const { text, team, orchestrator } = opts;
  // Safety: a request aimed at paths outside the repository is never turned
  // into a task (the worker would only refuse it after planning and approvals).
  const outsidePath = targetsOutsideRepo(text);
  if (outsidePath) {
    await ctx.runMutation(internal.chatContext.insertSystemLine, {
      projectId: args.projectId,
      conversationId: args.conversationId,
      replyToMessageId: args.userMessageId,
      content: outsideRepoReply(text, outsidePath),
    });
    return;
  }
  const mentioned = (args.preferredAgentIds ?? [])
    .map((id) => team.find((a) => a._id === String(id)))
    .filter((a): a is ChatAgent => Boolean(a) && a!._id !== orchestrator?._id);
  const routed = opts.offer || mentioned.length ? undefined : routedOwners(text, team);
  const hint = opts.offer?.hint ?? hintForCommand(text, team, { mentioned, ...(routed ? { routed } : {}) });
  const assignees = resolveTaskAssignees({
    team,
    mentionedIds: mentioned.map((a) => a._id),
    offerAssigneeId: opts.offer?.assigneeAgentId,
    hint,
    routed: routed?.owners,
  });
  await createChatTask(ctx, args, {
    command: text,
    title: opts.title ?? text.slice(0, 80),
    team,
    assignees,
    hint,
    conversationContext: opts.conversationContext,
    failureHint: "Try again or create it manually.",
  });
}

/**
 * A bare go reply ("gas", "lanjut") right after a reply that offered Create
 * task starts that offered task: the same command, pool and hint as clicking
 * the button (apps/web ChatPanel createTaskFromMessage).
 */
export async function startOfferedTask(
  ctx: ActionCtx,
  args: ChatTaskArgs,
  opts: { offer: StartOffer; team: ChatAgent[]; orchestrator: ChatAgent | null }
): Promise<void> {
  const { offer, team, orchestrator } = opts;
  const mentioned = extractAgentMentions(offer.reply, team, String(orchestrator?._id ?? ""));
  const hint = offer.hint ?? hintForCommand(offer.command, team);
  const assignees = resolveTaskAssignees({ team, mentionedIds: mentioned.map((a) => a._id), offerAssigneeId: offer.assigneeAgentId, hint });
  await createChatTask(ctx, args, {
    command: offer.command,
    title: offer.title ?? offer.command.split("\n")[0].slice(0, 80),
    team,
    assignees,
    hint,
    // Built from the offer and the request it answered: no other turns.
    conversationContext: false,
    ...(offer.messageId ? { offerMessageId: offer.messageId } : {}),
    failureHint: "Use the Create task button instead.",
  });
}
