"use node";

/**
 * Chat actions (public `getRepoSnapshot`, internal `replyToChat`). The
 * decision logic lives in pure helpers under `lib/chat/` and the prompt
 * text in `lib/prompts/chat.ts`; this module wires them to Convex:
 *
 *   lib/chat/intent.ts       deterministic intent shapes + classifier parser
 *   lib/chat/classify.ts     LLM intent classifier + ASK responder chooser
 *   lib/chat/team.ts         responder / mention / assignee selection
 *   lib/chat/llm.ts          streaming LLM client + provider-pool config
 *   lib/chat/strip.ts        tool-call markup stripping
 *   lib/chat/repoSnapshot.ts read-only workspace snapshot
 */

import { action, internalAction, type ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import type { PoolConnectionPayload } from "./lib/llmResolver";
import { permissionModeValidator, type PermissionMode } from "./lib/permissionModes";
import { TASK_INPUT_REFUSAL_COPY, type TaskInputRefusal } from "./lib/taskInputGuard";
import {
  GREETING,
  classifyChatIntent,
  explicitTaskCommand,
  findOfferedTask,
  commandNeedsChatContext,
  hasAskShape,
  isGoReply,
  isPastedContent,
  isOptionPick as isOptionPickText,
  isSelfReviewRequest,
  previousReplyOf,
  targetsOutsideRepo,
  type ChatTaskOffer,
  type IntentResult,
} from "./lib/chat/intent";
import { chooseAskResponder, classifyIntent } from "./lib/chat/classify";
import { type EchoContext, streamEchoSafe, stripLeadingEcho } from "./lib/chat/echo";
import { ROLE_KEYS, ROLES } from "./lib/roles";
import { chatPreRouteAllowed, routedAnswerSubtype, systemRoutingLine } from "./lib/chat/dispatch";
import { buildTaskStatusLine, resolveChatOwner } from "./lib/chat/owner";
import { detectChatRunCommands } from "./lib/chat/runRequest";
import {
  ORCHESTRATOR_ROLE,
  extractAgentMentions,
  pickConversationalAgent,
  pickGreetingResponders,
  resolveAssignees,
  suggestAssigneesByKeywords,
  type ChatAgent,
} from "./lib/chat/team";
import {
  completeWithAgent,
  getGlobalLLMConfig,
  resolveConfigFromProviders,
  type ChatLlmConfig,
  type CompleteResult,
} from "./lib/chat/llm";
import { stripToolCallMarkup } from "./lib/chat/strip";
import { offerForReply, planWriteOffer } from "./lib/chat/writeOffer";
import { firstReasoningSentence, intentLineFor, stripInternalPhrasing, toolStepFor } from "./lib/chat/activity";
import { completeWithSnapshot, type ChatSnapshotScope } from "./lib/chat/snapshot";
import { readRepoSnapshot } from "./lib/chat/repoSnapshot";
import { quoteContextLine, quotedResponderId } from "./lib/chat/quote";
import { replyFailureText } from "./lib/chat/replyLifecycle";
import { chatFailureText, historyBefore, isContinueRequest, keptPartial } from "./lib/chat/continueReply";
import { TRUNCATED_CUT_OFF, keepCutReply, runContinueTurn } from "./lib/chat/continueTurn";
import { personalNoTaskReply, type ChatScope } from "./lib/conversationShape";
import {
  MAX_REPO_TOOL_CALLS,
  MAX_REPO_TOOL_CALLS_PER_CHAT,
  createRepoToolBudget,
  describeRepoToolCall,
  runRepoToolLoop,
  type RepoToolCall,
  type RepoToolResult,
} from "./lib/chat/repoTools";
import { createSkillLoader, wantsLoadSkillTool, type SkillLoader } from "./lib/skillRuntime";
import { chatLocalTools, pastWorkRunner } from "./lib/chat/localTools";
import { LOAD_SKILL_MAX_CALLS } from "./lib/skills";
import {
  NO_TOOLS_RETRY_LINE,
  hasToolCallText,
  noToolsFallback,
  resolveNoToolsReply,
  streamVisibleText,
  toolBudgetFallback,
  noAnswerFallback,
} from "./lib/chat/toolCallText";
import { EMPTY_EVIDENCE, collectRepoEvidence, findUnverifiedRefs, type RepoEvidence } from "./lib/chat/refCheck";
import type { RepoToolsOffReason } from "./repoTools";
import {
  OPTIONS_GUIDANCE,
  buildAnswerGuidance,
  buildChatPersonaLines,
  buildChatMessages,
  buildTurnContextSection,
  buildGreetingSystem,
  buildGroundingGuidance,
  buildHandoffGuidance,
  buildPersonalChatSystem,
  buildPlanningGuidance,
  buildRoutedOwnerNotice,
  buildRepoToolProtocol,
  buildSkillToolProtocol,
  buildSelfReviewGuidance,
} from "./lib/prompts/chat";


/** The user explicitly asked for alternatives to pick from ("kasih 3 opsi layout"). */
function wantsOptions(text: string): boolean {
  return /\b(options?|opsi|pilihan|alternatif|alternatives?|variasi|varian|variants?)\b/i.test(text);
}

export const getRepoSnapshot = action({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<string | null> => {
    // Authorization (core H5): reads files from the project's workspace on
    // the host, so the caller must be allowed to see the project.
    await ctx.runQuery(internal.access.checkProjectAccess, { projectId: args.projectId });
    const project = (await ctx.runQuery(internal.chatContext.getProjectPath, {
      projectId: args.projectId,
    })) as { workspacePath: string } | null;
    if (!project?.workspacePath) return null;
    return (await readRepoSnapshot(project.workspacePath)) || null;
  },
});

type ChatContextData = {
  agents: ChatAgent[];
  team?: ChatAgent[];
  projectName: string;
  history: { authorType: string; content: string; agentId?: string; voice?: string; messageId?: Id<"messages">; taskOffer?: ChatTaskOffer }[];
  contextSummary?: string;
  activeTask?: { title: string; status: string } | null;
  llmProviders?: PoolConnectionPayload[];
};

/** A chat turn as scheduled: a personal chat has no projectId (plan 039). */
type ChatTurnArgs = Omit<ReplyArgs, "projectId"> & { projectId?: Id<"projects"> };

/** Tool result when a personal chat with no project is asked for repo tools. */
const NO_PROJECT_TOOL_TEXT = "No project is attached to this chat, so there is no repository to read.";

type ReplyArgs = {
  projectId: Id<"projects">;
  conversationId?: Id<"conversations">;
  preferredAgentIds?: Id<"agents">[];
  userMessageId: Id<"messages">;
  /** Plan 020: permission mode for the task this message may dispatch. */
  permissionMode?: PermissionMode;
};

const TERMINAL_TASK_STATUSES = ["done", "rejected", "failed", "cancelled"];

/** How long one repo tool call may wait for a worker before it counts as not checked. */
const REPO_TOOL_WAIT_MS = 20_000;
/** A call no worker has claimed by then fails fast: no live worker serves the queue. */
const REPO_TOOL_CLAIM_WAIT_MS = 3_000;
const REPO_TOOL_POLL_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Append one reasoning chunk to the reply's trace. */
function joinTrace(trace: string, next: string | undefined): string {
  const add = (next ?? "").trim();
  if (!add) return trace;
  return trace ? `${trace}\n\n${add}` : add;
}

/** Quiet Thinking-trace line for a CTO reply that runs without repo tools. */
export function repoToolsOffNote(reason: RepoToolsOffReason | "unclaimed" | "budget" | "error" | undefined): string {
  switch (reason) {
    case "no_workspace":
      return "Repo tools off: project folder not set";
    case "no_worker":
      return "Repo tools off: no online worker";
    case "worker_outdated":
      return "Repo tools off: online worker is outdated (restart it to serve repo tools)";
    case "unclaimed":
      return "Repo tools off: worker tidak merespons";
    case "budget":
      return `Repo tools off: this reply's shared budget of ${MAX_REPO_TOOL_CALLS_PER_CHAT} repo tool calls is used up`;
    default:
      return "Repo tools off: availability check failed";
  }
}

const WORKER_UNRESPONSIVE =
  "worker tidak merespons: no worker picked up this tool call within 3s, so repo tools are off for the rest of this reply. Treat it as not checked.";

/**
 * Run one read-only repo tool through the worker queue (repoTools.ts):
 * enqueue, poll for the worker's answer, always delete the row. Never
 * throws; a timeout or failure comes back as ok:false. A call that no worker
 * claims within REPO_TOOL_CLAIM_WAIT_MS fails fast with `unclaimed`.
 */
async function callRepoToolViaWorker(
  ctx: ActionCtx,
  projectId: Id<"projects">,
  call: RepoToolCall
): Promise<RepoToolResult & { unclaimed?: boolean }> {
  let callId: Id<"repoToolCalls">;
  try {
    callId = await ctx.runMutation(internal.repoTools.enqueue, {
      projectId,
      tool: call.tool,
      args: JSON.stringify(call.args ?? {}),
    });
  } catch (error: any) {
    return { ok: false, text: `Tool unavailable (${error?.message ?? "enqueue failed"}); treat as not checked.` };
  }
  try {
    const startedAt = Date.now();
    const deadline = startedAt + REPO_TOOL_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(REPO_TOOL_POLL_MS);
      const row = await ctx.runQuery(internal.repoTools.get, { callId });
      if (!row) break;
      if (row.status === "done") return { ok: true, text: row.result ?? "", files: row.files ?? [] };
      if (row.status === "error") return { ok: false, text: row.error ?? "Tool failed." };
      if (row.status === "pending" && Date.now() - startedAt >= REPO_TOOL_CLAIM_WAIT_MS) {
        return { ok: false, text: WORKER_UNRESPONSIVE, unclaimed: true };
      }
    }
    return { ok: false, text: "No worker answered this tool call in time; treat it as not checked." };
  } finally {
    await ctx.runMutation(internal.repoTools.remove, { callId }).catch(() => undefined);
  }
}

/** Repo tools are usable for this reply (workspace set + a repo-tool worker online). Never throws. */
async function repoToolsAvailability(
  ctx: ActionCtx,
  projectId: Id<"projects">
): Promise<{ available: boolean; reason?: RepoToolsOffReason | "error" }> {
  try {
    return await ctx.runQuery(internal.repoTools.availability, { projectId });
  } catch {
    return { available: false, reason: "error" };
  }
}


/** Repo snapshot for grounding, or null (best-effort, never throws). */
async function loadRepoSnapshot(ctx: ActionCtx, projectId: Id<"projects">): Promise<string | null> {
  try {
    const projectPath = await ctx.runQuery(internal.chatContext.getProjectPath, { projectId });
    const workspacePath = (projectPath as { workspacePath?: string } | null)?.workspacePath;
    if (!workspacePath) return null;
    return (await readRepoSnapshot(workspacePath)) || null;
  } catch {
    return null;
  }
}

/**
 * Plan 016: LLM Intent Classifier with structured output. Deterministic
 * shapes are a fast path; the classifier decides the ambiguous rest and
 * fails closed to `ask`.
 *
 * The result is a SUGGESTION that shapes the reply only: `task` means "this
 * looks like a work request", so the CTO answers with a short plan and the
 * Create task button. It never dispatches — a task starts only from the
 * button, an explicit command (explicitTaskCommand) or a go reply to a CTO
 * offer (isGoReply + findOfferedTask).
 */
async function resolveIntent(
  ctx: ActionCtx,
  projectId: Id<"projects">,
  text: string,
  optionPick: boolean,
  config: ChatLlmConfig
): Promise<IntentResult> {
  const fast = classifyChatIntent(text);
  const fastIsAsk = hasAskShape(text);
  // Active task for router context: read the project's running/queued task.
  let activeTaskForRouter: { title: string; status: string } | null = null;
  try {
    const rows = await ctx.runQuery(internal.chatContext.getActiveTask, { projectId });
    if (rows) activeTaskForRouter = rows;
  } catch {
    /* best-effort */
  }
  if (optionPick) {
    return {
      intent: "ask",
      subtype: "recommendation",
      requiresWorkspace: false,
      requiresExecution: false,
      confidence: 1,
      reasoning: "option pick",
    };
  }
  // Pasted or relayed text ("kata AI Agent saya …") is discussion material,
  // not a request: answer it, never propose a plan for it.
  if (isPastedContent(text)) {
    return {
      intent: "ask",
      subtype: "explanation",
      requiresWorkspace: false,
      requiresExecution: false,
      confidence: 1,
      reasoning: "pasted or relayed content",
    };
  }
  // "tolong jalankan tes" / "bisa run npm test?" is work, not a question: the
  // CTO offers Create task. (A leading "jalankan …" order never reaches here;
  // explicitTaskCommand already dispatched it.)
  if (detectChatRunCommands(text)) {
    return {
      intent: "task",
      subtype: "testing",
      requiresWorkspace: true,
      requiresExecution: true,
      confidence: 1,
      reasoning: "run-command request (suggestion only; Create task starts it)",
    };
  }
  if (fast.kind === "task" && !fastIsAsk) {
    return {
      intent: "task",
      subtype: "implementation",
      requiresWorkspace: true,
      requiresExecution: true,
      confidence: 1,
      reasoning: "deterministic change request (suggestion only)",
    };
  }
  if (fastIsAsk) {
    return {
      intent: "ask",
      subtype: "explanation",
      requiresWorkspace: false,
      requiresExecution: false,
      confidence: 1,
      reasoning: "deterministic question shape",
    };
  }
  const classified = await classifyIntent(text, config, activeTaskForRouter);
  return (
    classified ??
    ({
      intent: "ask",
      subtype: "explanation",
      requiresWorkspace: false,
      requiresExecution: false,
      confidence: 0.5,
      reasoning: "classifier unavailable; safe ask fallback",
    } as IntentResult)
  );
}

/**
 * Lifecycle intents act on the active task instead of chatting. Returns
 * true when the intent was handled; false falls through to chat.
 */
async function handleLifecycleIntent(
  ctx: ActionCtx,
  args: ReplyArgs,
  intent: IntentResult,
  text: string
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- lazy import of the generated api (avoids an import cycle)
  const { api: apiRef } = await import("./_generated/api.js") as any;
  const activeId = await ctx.runQuery(internal.chatContext.getActiveTaskId, { projectId: args.projectId });
  const activeTask = activeId ? await ctx.runQuery(apiRef.tasks.get, { taskId: activeId as never }) : null;
  const terminal = TERMINAL_TASK_STATUSES.includes(activeTask?.status ?? "");
  if (intent.intent === "cancel" && activeTask && !terminal) {
    await ctx.runMutation(apiRef.tasks.cancel, { taskId: activeId as never });
    return true;
  }
  if (intent.intent === "continue" && activeTask) {
    // The input guard may refuse (approval pending, task finished…): say
    // why in the chat instead of pretending the steer landed.
    const res = (await ctx.runMutation(apiRef.tasks.steerTask, { taskId: activeId as never, instruction: text })) as {
      applied: boolean;
      reason?: string;
    };
    if (!res.applied && res.reason && res.reason in TASK_INPUT_REFUSAL_COPY) {
      await ctx.runMutation(internal.chatContext.insertAgentMessage, {
        projectId: args.projectId,
        conversationId: args.conversationId,
        content: TASK_INPUT_REFUSAL_COPY[res.reason as TaskInputRefusal],
        replyToMessageId: args.userMessageId,
      });
    }
    return true;
  }
  if (intent.intent === "status" && activeTask) {
    await ctx.runMutation(internal.chatContext.insertSystemLine, {
      projectId: args.projectId,
      conversationId: args.conversationId,
      content: `Task "${activeTask.title}" is ${activeTask.status}.`,
      replyToMessageId: args.userMessageId,
    });
    return true;
  }
  if (intent.intent === "approve" || intent.intent === "reject") {
    const pending = await ctx.runQuery(apiRef.approvals.listPendingAll, {});
    const target = (pending as any[]).find((a) => a.status === "pending" && a.projectId === args.projectId);
    if (target) {
      if (intent.intent === "approve") {
        await ctx.runMutation(apiRef.approvals.approve, { approvalId: target._id });
      } else {
        await ctx.runMutation(apiRef.approvals.reject, { approvalId: target._id });
      }
      return true;
    }
  }
  return false;
}

/** System's status line from the project's task state (no LLM). */
async function taskStatusLine(ctx: ActionCtx, projectId: Id<"projects">, team: ChatAgent[]): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- lazy import of the generated api (avoids an import cycle)
  const { api: apiRef } = (await import("./_generated/api.js")) as any;
  const tasks = (await ctx.runQuery(apiRef.tasks.listByProject, { projectId, limit: 50 })) as Array<{ title: string; status: string; assignedAgentIds?: string[] }>;
  const nameOf = (id: string) => team.find((a) => String(a._id) === String(id))?.name;
  return buildTaskStatusLine(
    tasks.map((t) => ({ title: t.title, status: t.status, assigneeNames: (t.assignedAgentIds ?? []).map(nameOf).filter((n): n is string => Boolean(n)) }))
  );
}

/** Refusal copy for a request that targets a path outside the repository. */
function outsideRepoReply(text: string, outsidePath: string): string {
  const indonesian = /\b(hapus|ubah|edit|tambah\w*|buat\w*|dan|yang|tolong|jangan)\b/i.test(text) && /\b(dan|yang|tolong|hapus|buat\w*)\b/i.test(text);
  return indonesian
    ? `Saya tidak membuat task untuk ini: \`${outsidePath}\` ada di luar repository project. Tim hanya mengubah file di dalam folder project.`
    : `I won't create a task for this: \`${outsidePath}\` is outside the project repository. The team only changes files inside the project folder.`;
}

type StreamReplyResult = CompleteResult & {
  /** The persisted bubble (absent when it was removed as empty). */
  messageId?: Id<"messages">;
  /** Grounded replies: what the repo tools showed (for the reference check). */
  evidence?: RepoEvidence;
  /** Grounded replies: repo tool calls this reply made (for the shared budget). */
  toolCalls?: number;
};

type StreamReply = (
  agentId: Id<"agents">,
  config: ChatLlmConfig,
  system: string,
  msgs: { role: string; content: string }[],
  opts?: {
    traceNote?: string;
    maxCalls?: number;
    /** Skill v2: on_demand agent — load_skill runs locally in this action. */
    skillLoader?: SkillLoader;
    /** Activity timeline: the classifier's one-line intent ("Bekerja" line). */
    intentLine?: string;
  },
) => Promise<StreamReplyResult>;

/**
 * Explicit dispatch: an explicit command ("/task …", "kerjakan …") creates
 * the task row and skips the chat loop. Never reached from the classifier.
 * Idempotent per message: the same command can only create one live task.
 * O3: no CTO assignment reply. Assignees come from the user's @mentions and
 * the request's keywords (the planner decides the rest); System posts
 * "Task created · planning" with the assignment card.
 */
async function dispatchTaskFromChat(
  ctx: ActionCtx,
  args: ReplyArgs,
  opts: {
    text: string;
    team: ChatAgent[];
    orchestrator: ChatAgent | null;
    /** Set when the command was composed from an offer ("kerjakan itu"). */
    title?: string;
    conversationContext?: boolean;
  }
): Promise<void> {
  const { text, team, orchestrator } = opts;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- lazy import of the generated api (avoids an import cycle)
  const { api } = await import("./_generated/api.js") as any;
  const existing = await (ctx as any).runQuery(api.tasks.listByProject, { projectId: args.projectId });
  const dupe = (existing as any[]).find(
    (t: any) =>
      t.command === text &&
      !TERMINAL_TASK_STATUSES.includes(t.status)
  );
  if (dupe) {
    return; // already dispatched; UI shows the task
  }
  const systemLine = (content: string, extra: { taskId?: Id<"tasks">; card?: { kind: "assignment"; data: unknown } } = {}) =>
    ctx.runMutation(internal.chatContext.insertSystemLine, {
      projectId: args.projectId,
      conversationId: args.conversationId,
      replyToMessageId: args.userMessageId,
      content,
      ...extra,
    });
  // Safety: a request aimed at paths outside the repository is never
  // turned into a task — the worker would only refuse it later, after
  // planning and approvals (e2e safety probe).
  const outsidePath = targetsOutsideRepo(text);
  if (outsidePath) {
    await systemLine(outsideRepoReply(text, outsidePath));
    return;
  }
  try {
    // Explicit @mentions from the user are assignees too.
    const userAssignees = (args.preferredAgentIds ?? [])
      .map((id) => team.find((a) => a._id === String(id)))
      .filter((a): a is ChatAgent => Boolean(a) && a!._id !== orchestrator?._id);
    // Nobody named: pick owners from the request itself instead of handing
    // it to everyone.
    const keywordAssignees = userAssignees.length
      ? []
      : suggestAssigneesByKeywords(text, team.filter((a) => a._id !== orchestrator?._id));
    const assignees = resolveAssignees(team, orchestrator, [...userAssignees, ...keywordAssignees]);
    const title = opts.title ?? text.slice(0, 80);
    const taskId = await (ctx as any).runMutation(api.tasks.createFromCommand, {
      projectId: args.projectId,
      command: text,
      title,
      conversationId: args.conversationId,
      ...(opts.conversationContext === false ? { conversationContext: false } : {}),
      ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
      ...(assignees.length ? { assignedAgentIds: assignees.map((a) => a._id) } : {}),
    });
    await systemLine("Task created · planning", {
      taskId: taskId as any,
      card: {
        kind: "assignment",
        data: {
          taskId: String(taskId),
          title,
          assignees: (assignees.length ? assignees : team)
            .filter((a) => a._id !== orchestrator?._id)
            .map((a) => ({ agentId: String(a._id), name: a.name, role: a.role })),
          assignedBy: "System",
        },
      },
    });
  } catch (e: any) {
    console.error("Auto-dispatch failed:", e?.message ?? e);
    await systemLine(`Task not created: ${e?.message ?? "unknown error"}. Try again or create it manually.`);
    // do not pretend execution is running
  }
}

/**
 * A bare go reply ("gas", "lanjut") right after a CTO reply that offered
 * Create task starts that offered task — the same command and assignees as
 * clicking the button (apps/web ChatPanel createTaskFromMessage).
 */
async function startOfferedTask(
  ctx: ActionCtx,
  args: ReplyArgs,
  opts: {
    offer: { command: string; title?: string; reply: string; messageId?: Id<"messages">; assigneeAgentId?: string };
    team: ChatAgent[];
    orchestrator: ChatAgent | null;
  }
): Promise<void> {
  const { offer, team, orchestrator } = opts;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- lazy import of the generated api (avoids an import cycle)
  const { api } = (await import("./_generated/api.js")) as any;
  const existing = (await ctx.runQuery(api.tasks.listByProject, { projectId: args.projectId })) as any[];
  if (existing.some((t: any) => t.command === offer.command && !TERMINAL_TASK_STATUSES.includes(t.status))) return;
  const mentioned = extractAgentMentions(offer.reply, team, String(orchestrator?._id ?? ""));
  const assignees = mentioned.length ? mentioned : team.filter((a) => String(a._id) === offer.assigneeAgentId);
  const title = offer.title ?? offer.command.split("\n")[0].slice(0, 80);
  const scope = { projectId: args.projectId, conversationId: args.conversationId, replyToMessageId: args.userMessageId };
  try {
    const taskId = await ctx.runMutation(api.tasks.createFromCommand, {
      projectId: args.projectId,
      command: offer.command,
      title,
      conversationId: args.conversationId,
      // Built from the offer and the request it answered: no other turns.
      conversationContext: false,
      ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
      ...(assignees.length ? { assignedAgentIds: assignees.map((a) => a._id) } : {}),
      // Marks the offer used: its button shows "Task created".
      ...(offer.messageId ? { offerMessageId: offer.messageId } : {}),
    });
    await ctx.runMutation(internal.chatContext.insertSystemLine, {
      ...scope,
      taskId: taskId as any,
      content: "Task created · planning",
      card: {
        kind: "assignment",
        data: {
          taskId: String(taskId),
          title,
          assignees: (assignees.length ? assignees : team)
            .filter((a) => a._id !== orchestrator?._id)
            .map((a) => ({ agentId: String(a._id), name: a.name, role: a.role })),
          assignedBy: "System",
        },
      },
    });
  } catch (e: any) {
    console.error("Offered task start failed:", e?.message ?? e);
    await ctx.runMutation(internal.chatContext.insertSystemLine, {
      ...scope,
      content: `Task not created: ${e?.message ?? "unknown error"}. Use the Create task button instead.`,
    });
  }
}

/**
 * Explicit task from an ATTACHED personal chat (plan 039 D5): the task is
 * created in the conversation's project with this conversation as its
 * source, and the assignment card is posted without projectId (D1). No CTO
 * assignment round: the chat is one agent; the planner picks owners.
 */
async function startPersonalTask(
  ctx: ActionCtx,
  opts: {
    projectId: Id<"projects">;
    conversationId: Id<"conversations">;
    userMessageId: Id<"messages">;
    agent: ChatAgent;
    command: string;
    title?: string;
    fromOffer: boolean;
    /** The reply whose offer this is (marked used on create). */
    offerMessageId?: Id<"messages">;
  }
): Promise<void> {
  const { agent } = opts;
  const outsidePath = targetsOutsideRepo(opts.command);
  if (outsidePath) {
    await ctx.runMutation(internal.chatContext.insertAgentMessage, {
      agentId: agent._id as any,
      conversationId: opts.conversationId,
      replyToMessageId: opts.userMessageId,
      content: outsideRepoReply(opts.command, outsidePath),
    });
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- lazy import of the generated api (avoids an import cycle)
  const { api } = (await import("./_generated/api.js")) as any;
  const existing = (await ctx.runQuery(api.tasks.listByProject, { projectId: opts.projectId })) as any[];
  if (existing.some((t: any) => t.command === opts.command && !TERMINAL_TASK_STATUSES.includes(t.status))) return;
  const title = opts.title ?? opts.command.split("\n")[0].slice(0, 80);
  try {
    const taskId = await ctx.runMutation(api.tasks.createFromCommand, {
      projectId: opts.projectId,
      command: opts.command,
      title,
      conversationId: opts.conversationId,
      ...(opts.fromOffer ? { conversationContext: false } : {}),
      ...(opts.offerMessageId ? { offerMessageId: opts.offerMessageId } : {}),
    });
    await ctx.runMutation(internal.chatContext.insertAgentMessage, {
      agentId: agent._id as any,
      conversationId: opts.conversationId,
      replyToMessageId: opts.userMessageId,
      taskId: taskId as any,
      content: "",
      card: {
        kind: "assignment",
        data: { taskId: String(taskId), title, assignees: [], assignedBy: agent.name },
      },
    });
  } catch (e: any) {
    await ctx.runMutation(internal.chatContext.insertAgentMessage, {
      agentId: agent._id as any,
      conversationId: opts.conversationId,
      content: `I couldn't create the task (${e?.message ?? "unknown error"}).`,
      replyToMessageId: opts.userMessageId,
    });
  }
}

export const replyToChat = internalAction({
  args: {
    // Optional since plan 039: the reply derives its scope from the
    // conversation row (getChatScope); a personal chat has no project.
    projectId: v.optional(v.id("projects")),
    conversationId: v.optional(v.id("conversations")),
    preferredAgentIds: v.optional(v.array(v.id("agents"))),
    userMessageId: v.id("messages"),
    permissionMode: v.optional(permissionModeValidator),
  },
  handler: async (ctx, rawArgs) => {
    // Durable reply (t3code idea #1): the "already replied?" check and the claim are one mutation, so a
    // double-scheduled run returns here before it creates a bubble. The claim is settled answered/failed below; a run
    // killed by the 10-minute Node cap is settled by chatReplies.sweepStale.
    const claim = await ctx.runMutation(internal.chatReplies.claimReply, { userMessageId: rawArgs.userMessageId });
    if (!claim.claimed) return;
    try {
      const scope = await ctx.runQuery(internal.chatContext.getChatScope, {
        userMessageId: rawArgs.userMessageId,
        ...(rawArgs.conversationId ? { conversationId: rawArgs.conversationId } : {}),
      });
      if (!scope) throw new Error("This message no longer exists");
      if (scope.kind !== "personal" && !scope.projectId) throw new Error("Conversation has no project");
      // The project comes from the conversation row (rule PC-S1), never
      // from the scheduler argument alone.
      await answerChat(ctx, rawArgs, scope);
    } catch (error) {
      await ctx.runMutation(internal.chatReplies.settleReply, {
        userMessageId: rawArgs.userMessageId,
        runId: claim.runId,
        outcome: "failed",
        error: replyFailureText(error),
      });
      throw error;
    }
    await ctx.runMutation(internal.chatReplies.settleReply, {
      userMessageId: rawArgs.userMessageId,
      runId: claim.runId,
      outcome: "answered",
    });
  },
});

/**
 * One chat turn: route, stream and persist the replies to `rawArgs.userMessageId`.
 * (Body kept at its original indentation to keep the durable-reply diff small.)
 */
async function answerChat(ctx: ActionCtx, rawArgs: ChatTurnArgs, scope: ChatScope): Promise<void> {

    // Plan 039 (rule PC-S1): one scope, read from the conversation row. A personal chat answers with its own agent
    // only, writes its messages without projectId (D1) and gets project features only once a project is attached
    // (scopeProjectId). There is no default project.
    const personal = scope.kind === "personal";
    const scopeProjectId: Id<"projects"> | null = scope.projectId;
    const messageProjectId = personal ? undefined : (scopeProjectId ?? undefined);
    const msgScope = messageProjectId ? { projectId: messageProjectId } : {};
    const requireProjectId = (): Id<"projects"> => {
      if (!scopeProjectId) throw new Error("No project is attached to this chat");
      return scopeProjectId;
    };

    // Reply quote: replying to a teammate's message (no @mention) routes the answer to that teammate, as if the user
    // had @mentioned it (the CTO included, O3). The user's own messages route as usual; either way the quoted text rides
    // into the context below.
    const quoteInfo = await ctx.runQuery(internal.chatContext.getQuoteForReply, {
      userMessageId: rawArgs.userMessageId,
    });
    // A personal chat has one responder whatever is quoted.
    const quotedResponder = !personal && quoteInfo ? quotedResponderId(quoteInfo.quote, quoteInfo.userMentionCount) : null;
    const args: ChatTurnArgs = quotedResponder
      ? { ...rawArgs, preferredAgentIds: [quotedResponder as Id<"agents">] }
      : rawArgs;

    const personalConversationId = args.conversationId;
    if (personal && !personalConversationId) throw new Error("A personal chat reply needs its conversation");
    const data = (personal && personalConversationId
      ? await ctx.runQuery(internal.chatContext.getPersonalContext, {
          conversationId: personalConversationId,
          userMessageId: args.userMessageId,
        })
      : await ctx.runQuery(internal.chatContext.getContext, {
          projectId: requireProjectId(),
          conversationId: args.conversationId,
          preferredAgentIds: args.preferredAgentIds,
          userMessageId: args.userMessageId,
        })) as ChatContextData;

    const { agents, team: teamAgents, projectName, history, llmProviders } = data;
    const globalConfig = await resolveConfigFromProviders(llmProviders, getGlobalLLMConfig());

    // Repo snapshot (read-only, workspace-confined) so structural chat questions ("how is this repo structured?") can
    // be answered from evidence instead of guesses. No project (personal chat not attached): no snapshot, no workspace
    // read.
    const repoSnapshot = scopeProjectId ? await loadRepoSnapshot(ctx, scopeProjectId) : null;

    if (agents.length === 0) {
      await ctx.runMutation(internal.chatContext.insertAgentMessage, {
        ...msgScope,
        conversationId: args.conversationId,
        content: personal
          ? "This agent is disabled or retired, so it can't reply here."
          : "No enabled agents are participating in this conversation. Add agents to the project team and select them for chat.",
        replyToMessageId: args.userMessageId,
      });
      return;
    }

    // Prompt shape: the history goes in as real chat messages with the user's latest message LAST (buildChatMessages);
    // the compacted summary, the quoted message and teammates' replies from this turn go in a system section
    // (buildTurnContextSection). The latest message is never followed by anything, so a pasted multi-line request is
    // what gets answered (night e2e A5).
    const agentNameOf = (id: string | undefined) =>
      [...agents, ...(teamAgents ?? [])].find((a) => String(a._id) === String(id ?? ""))?.name;
    const messagesFor = (agentId: string | undefined) =>
      buildChatMessages(history, { selfAgentId: agentId, nameOf: agentNameOf });
    // The quoted message is named so the agent knows what "this"/"ini"
    // refers to, even when it is older than the history window.
    const quoteLine = quoteInfo ? quoteContextLine(quoteInfo.quote) : undefined;
    const turnReplies: Array<{ name: string; content: string }> = [];
    const turnContext = () =>
      buildTurnContextSection({ summary: data.contextSummary, quoteLine, turnReplies });
    // System routing lines posted this turn (kept out of the owner's context).
    const handoffLines: string[] = [];
    // Leading speaker-echo cleanup (lib/chat/echo.ts): what a reply by this
    // agent may have copied, and the speaker labels it would copy it under.
    const echoContextFor = (agentId: string): EchoContext => {
      const everyone = [...agents, ...(teamAgents ?? [])];
      const self = everyone.find((a) => String(a._id) === String(agentId));
      return {
        selfNames: self ? [self.name, self.role] : [],
        speakerNames: [
          ...everyone.filter((a) => String(a._id) !== String(agentId)).flatMap((a) => [a.name, a.role]),
          // Every fixed role label too: a personal chat has no teammates in
          // context, yet replies still opened with "CTO:" (live test 4).
          ...ROLE_KEYS.flatMap((k) => [ROLES[k].label, k]),
          "User",
          "You",
        ].filter((n) => !self || (n.toLowerCase() !== self.name.toLowerCase() && n.toLowerCase() !== self.role.toLowerCase())),
        priorMessages: [
          ...handoffLines,
          ...turnReplies.map((r) => r.content),
          ...history.slice(-6).map((row) => row.content ?? ""),
        ],
      };
    };

    // Only an agent whose ROLE is exactly "cto" may act as the orchestrator (legacy "architect" accepted for backward
    // compat). Anchored: an unanchored match also hit "director", "doctor", … Falling back to agents[0] made any
    // selected agent introduce itself as "the orchestrator/planner" while still naming its own role (e.g. "frontend
    // developer ... I'm the orchestrator/planner").
    // O3: the CTO is a teammate that owns architecture and planning, not the
    // chat default. Read from the team (not the conversation's participants)
    // so routing can reach it.
    const team = teamAgents ?? agents;
    const orchestrator =
      team.find((a) => ORCHESTRATOR_ROLE.test(a.role.trim())) ??
      agents.find((a) => ORCHESTRATOR_ROLE.test(a.role.trim())) ??
      null;

    // The user's message this run answers (fixed fallback copy follows its language).
    const userText = history[history.length - 1]?.content ?? "";

    // Streaming persist helper: create the agent message row first, then patch content/reasoning as SSE chunks arrive
    // so the UI shows the bubble + "Thinking" trace live. Patches are throttled to avoid a mutation per token.
    //
    // This path has NO tools. A model that emits a tool call anyway (JSON or <longcat_tool_call> markup) never gets it
    // shown: it is held back while streaming, the reply is retried once with an explicit "no tools" line, and a reply
    // that is still a call becomes a short fallback. Context Snapshot scope for one chat LLM call (Inspect context).
    const snapScope = (
      agentId: Id<"agents">,
      messageId: unknown,
      callRole: ChatSnapshotScope["callRole"]
    ): ChatSnapshotScope => ({
      ...(scopeProjectId ? { projectId: scopeProjectId } : {}),
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
      agentId,
      agentRole: [...agents, ...(teamAgents ?? [])].find((a) => String(a._id) === String(agentId))?.role,
      messageId: messageId as Id<"messages">,
      callRole,
    });
    // Activity timeline: once the model's first reasoning sentence is
    // complete (and clean, in the user's language) it replaces the
    // classifier's intent line. Patched at most once per reply.
    const intentUpgrader = () => {
      let done = false;
      return (reasoning: string): { intentLine?: string } => {
        if (done) return {};
        const line = firstReasoningSentence(reasoning, userText);
        if (!line) return {};
        done = true;
        return { intentLine: line };
      };
    };
    const streamReplyToAgent: StreamReply = async (agentId, config, system, msgs, opts) => {
      const messageId = await ctx.runMutation(internal.chatContext.createStreamingAgentMessage, {
        ...msgScope,
        agentId: agentId as any,
        conversationId: args.conversationId,
        replyToMessageId: args.userMessageId,
        ...(opts?.intentLine ? { intentLine: opts.intentLine } : {}),
      });
      const upgradeIntent = intentUpgrader();
      const echoCtx = echoContextFor(String(agentId));
      const note = opts?.traceNote ?? "";
      let lastPatchAt = 0;
      // Partial patches run one at a time; the final patch waits for the
      // last one. Fire-and-forget patches could land AFTER the final write
      // and overwrite the full reply with a truncated snapshot.
      let patchChain: Promise<unknown> = Promise.resolve();
      let traceBase = note;
      const onChunk = ({ content: rawContent, reasoning }: { content: string; reasoning: string }) => {
        const content = streamEchoSafe(stripInternalPhrasing(streamVisibleText(rawContent)), echoCtx);
        const liveTrace = joinTrace(traceBase, reasoning);
        const now = Date.now();
        if (now - lastPatchAt < 250 || (!content.trim() && !liveTrace.trim())) return;
        lastPatchAt = now;
        const intentPatch = upgradeIntent(reasoning);
        patchChain = patchChain
          .then(() =>
            ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, {
              messageId: messageId as any,
              content,
              reasoning: liveTrace || undefined,
              ...intentPatch,
            })
          )
          .catch(() => {});
      };
      let raw: Awaited<ReturnType<typeof completeWithAgent>>;
      let content: string;
      let reasoning: string;
      try {
        raw = await completeWithSnapshot(ctx, snapScope(agentId, messageId, "chat"), system, msgs, config, onChunk);
        reasoning = joinTrace(note, raw.reasoning);
        if (hasToolCallText(raw.content)) {
          // A tool call with no tools: never shown. Retry once, told plainly.
          traceBase = joinTrace(reasoning, "Reply was a tool call, but this reply has no tools; asked again for a prose answer.");
          lastPatchAt = Date.now();
          patchChain = patchChain
            .then(() =>
              ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, {
                messageId: messageId as any,
                content: "",
                reasoning: traceBase,
              })
            )
            .catch(() => {});
          const retry = await completeWithSnapshot(ctx, snapScope(agentId, messageId, "chat"), `${system}\n${NO_TOOLS_RETRY_LINE}`, msgs, config, onChunk);
          content = stripLeadingEcho(stripInternalPhrasing(resolveNoToolsReply(retry.content, userText)), echoCtx);
          reasoning = joinTrace(traceBase, retry.reasoning);
          raw = { ...retry, reasoningDurationMs: raw.reasoningDurationMs + retry.reasoningDurationMs };
        } else {
          content = stripLeadingEcho(stripInternalPhrasing(stripToolCallMarkup(raw.content)), echoCtx);
        }
      } catch (error) {
        // Never leave the bubble animating after a failed call. Text that
        // already arrived is kept, marked cut off, with Continue (continueTurn.ts).
        await patchChain;
        const kept = keptPartial(error, (t) => stripLeadingEcho(stripInternalPhrasing(stripToolCallMarkup(streamVisibleText(t))), echoCtx));
        if (kept) return await keepCutReply(ctx, messageId as any, error, { ...kept, reasoning: joinTrace(traceBase, kept.reasoning) });
        await ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, {
          messageId: messageId as any,
          streaming: false,
        });
        await ctx.runMutation(internal.chatContext.removeEmptyAgentMessage, { messageId: messageId as any });
        throw error;
      }
      await patchChain;
      const result: StreamReplyResult = { ...raw, content, reasoning, messageId: messageId as any };
      await ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, {
        messageId: messageId as any,
        content: result.content,
        reasoning: result.reasoning || undefined,
        reasoningDurationMs: result.reasoningDurationMs || undefined,
        streaming: false,
        ...(raw.truncated && result.content.trim() ? { cutOff: TRUNCATED_CUT_OFF } : {}),
      });
      // A reply that produced only reasoning (e.g. the model ran out of
      // tokens while thinking) would render as an empty bubble.
      if (!result.content.trim()) {
        await ctx.runMutation(internal.chatContext.removeEmptyAgentMessage, { messageId: messageId as any });
        result.messageId = undefined;
      }
      return result;
    };

    // Once a repo tool call goes unclaimed, no live worker serves the queue:
    // every later call in this chat turn (any agent) fails at once, and the
    // agents still to answer get no tools.
    let workerGone = false;

    // Grounded reply (an agent with repo tools — the CTO, a handoff teammate or an @mentioned agent): the same
    // streaming bubble, but each LLM step may be a tool call instead of the answer. Tool-call text is never shown
    // (several calls in one step: the first runs, the rest is discarded); the trace notes each check, and the files
    // read are stored as `checkedFiles` for the quiet "Checked: …" line.
    const streamGroundedReply: StreamReply = async (agentId, config, system, msgs, opts) => {
      const messageId = await ctx.runMutation(internal.chatContext.createStreamingAgentMessage, {
        ...msgScope,
        agentId: agentId as any,
        conversationId: args.conversationId,
        replyToMessageId: args.userMessageId,
        ...(opts?.intentLine ? { intentLine: opts.intentLine } : {}),
      });
      const upgradeIntent = intentUpgrader();
      const echoCtx = echoContextFor(String(agentId));
      const startedAt = Date.now();
      let trace = opts?.traceNote ?? "";
      let lastPatchAt = 0;
      let patchChain: Promise<unknown> = Promise.resolve();
      const patch = (fields: { content?: string; reasoning?: string; intentLine?: string }) => {
        patchChain = patchChain
          .then(() =>
            ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, { messageId: messageId as any, ...fields })
          )
          .catch(() => {});
      };
      let loop: Awaited<ReturnType<typeof runRepoToolLoop>>;
      let lastTruncated = false;
      try {
        const skillLoader = opts?.skillLoader;
        loop = await runRepoToolLoop({
          messages: msgs,
          maxCalls: opts?.maxCalls ?? MAX_REPO_TOOL_CALLS,
          // Local tools (not the worker queue): the agent's own skills, and past work of this chat's project (D11).
          ...chatLocalTools({ skillLoader, pastWork: scopeProjectId ? pastWorkRunner(ctx, scopeProjectId) : null }),
          step: async (stepMsgs) => {
            const raw = await completeWithSnapshot(ctx, snapScope(agentId, messageId, "chat_tool_step"), system, stepMsgs, config, ({ content: rawContent, reasoning }) => {
              const now = Date.now();
              if (now - lastPatchAt < 250) return;
              const content = streamEchoSafe(stripInternalPhrasing(streamVisibleText(rawContent)), echoCtx);
              const liveTrace = joinTrace(trace, reasoning);
              if (!content.trim() && !liveTrace.trim()) return;
              lastPatchAt = now;
              patch({ content, reasoning: liveTrace || undefined, ...upgradeIntent(reasoning) });
            });
            trace = joinTrace(trace, raw.reasoning);
            lastTruncated = raw.truncated === true;
            return { content: raw.content };
          },
          callTool: async (call) => {
            if (workerGone) return { ok: false, text: WORKER_UNRESPONSIVE };
            // Never a repo call without a project (no worker-root fallback).
            if (!scopeProjectId) return { ok: false, text: NO_PROJECT_TOOL_TEXT };
            const result = await callRepoToolViaWorker(ctx, scopeProjectId, call);
            if (result.unclaimed && !workerGone) {
              workerGone = true;
              trace = joinTrace(trace, repoToolsOffNote("unclaimed"));
            }
            return result;
          },
          onToolCall: (call, result) => {
            trace = joinTrace(trace, `Checked ${describeRepoToolCall(call)}${result.ok ? "" : " (failed)"}`);
            lastPatchAt = Date.now();
            patch({ content: "", reasoning: trace });
            // Activity timeline: one row per completed call, streamed live.
            const step = toolStepFor(call, result.ok, Date.now());
            patchChain = patchChain
              .then(() => ctx.runMutation(internal.chatContext.appendToolStep, { messageId: messageId as any, step }))
              .catch(() => {});
          },
        });
      } catch (error) {
        await patchChain;
        const kept = keptPartial(error, (t) => stripLeadingEcho(stripInternalPhrasing(stripToolCallMarkup(streamVisibleText(t))), echoCtx));
        if (kept) return { ...(await keepCutReply(ctx, messageId as any, error, { ...kept, reasoning: joinTrace(trace, kept.reasoning) })), evidence: EMPTY_EVIDENCE };
        await ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, {
          messageId: messageId as any,
          streaming: false,
        });
        await ctx.runMutation(internal.chatContext.removeEmptyAgentMessage, { messageId: messageId as any });
        throw error;
      }
      await patchChain;
      // The loop's answer is already free of tool-call text; a reply that
      // never got past tool calls gets the fallback instead of vanishing.
      let content = stripLeadingEcho(stripInternalPhrasing(stripToolCallMarkup(loop.answer)), echoCtx);
      if (!content.trim()) {
        // A grounded reply never vanishes: with no checks made (the model only
        // announced one), say so plainly instead of removing the bubble.
        content = workerGone
          ? noToolsFallback(userText)
          : loop.calls.length > 0
            ? toolBudgetFallback(userText)
            : noAnswerFallback(userText);
      }
      const reasoningDurationMs = Date.now() - startedAt;
      await ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, {
        messageId: messageId as any,
        content,
        reasoning: trace || undefined,
        reasoningDurationMs,
        streaming: false,
        ...(loop.checkedFiles.length ? { checkedFiles: loop.checkedFiles.slice(0, 20) } : {}),
        ...(lastTruncated && loop.answer.trim() ? { cutOff: TRUNCATED_CUT_OFF } : {}),
      });
      let keptId: Id<"messages"> | undefined = messageId as any;
      if (!content.trim()) {
        await ctx.runMutation(internal.chatContext.removeEmptyAgentMessage, { messageId: messageId as any });
        keptId = undefined;
      }
      return {
        content,
        reasoning: trace,
        reasoningDurationMs,
        messageId: keptId,
        evidence: collectRepoEvidence(loop.results),
        toolCalls: loop.repoCalls,
      };
    };

    // "continue" after a cut reply: finish that reply in place (lib/chat/continueTurn.ts).
    const cut = isContinueRequest(userText) ? await ctx.runQuery(internal.chatContext.getContinueTarget, { userMessageId: args.userMessageId }) : null;
    const cutAgent = cut ? [...agents, ...(teamAgents ?? [])].find((a) => String(a._id) === String(cut.agentId)) : undefined;
    if (cut && cutAgent) {
      return await runContinueTurn(ctx, {
        target: cut, agent: cutAgent, projectName,
        prior: buildChatMessages(historyBefore(history, String(cut.messageId)), { selfAgentId: String(cutAgent._id), nameOf: agentNameOf }),
        config: await resolveConfigFromProviders(llmProviders, getGlobalLLMConfig(), cutAgent as any),
        scope: snapScope(cutAgent._id as any, cut.messageId, "chat"),
        clean: (t) => stripInternalPhrasing(stripToolCallMarkup(streamVisibleText(t))),
      });
    }

    // Personal chat (plan 039 PC3): the conversation's own agent answers, alone. No CTO pre-route, no handoff, no
    // @mention queue, no intent classifier. Tasks only with a project attached and only when asked explicitly (D5);
    // without one a fixed sentence explains why.
    if (personal) {
      const agent = agents[0];
      const lastText = history[history.length - 1]?.content ?? "";
      const optionPick = isOptionPickText(lastText);
      const explicit = optionPick ? null : explicitTaskCommand(lastText);
      const roleOfPersonal = (id: string | undefined) => (String(id ?? "") === String(agent._id) ? agent.role : undefined);
      const goOffer = !explicit && !optionPick && isGoReply(lastText) && scopeProjectId ? findOfferedTask(history, roleOfPersonal) : null;
      if (explicit || goOffer) {
        if (!scopeProjectId || !personalConversationId) {
          await ctx.runMutation(internal.chatContext.insertAgentMessage, {
            agentId: agent._id as any,
            conversationId: args.conversationId,
            replyToMessageId: args.userMessageId,
            content: personalNoTaskReply(lastText),
          });
          return;
        }
        await startPersonalTask(ctx, {
          projectId: scopeProjectId,
          conversationId: personalConversationId,
          userMessageId: args.userMessageId,
          agent,
          command: explicit ?? goOffer?.command ?? lastText,
          title: goOffer?.title,
          fromOffer: goOffer !== null,
          ...(goOffer && history[goOffer.index]?.messageId ? { offerMessageId: history[goOffer.index].messageId } : {}),
        });
        return;
      }

      const personalWrite = planWriteOffer({ speaker: agent, isCto: ORCHESTRATOR_ROLE.test(agent.role.trim()), addressed: true, team: [agent], text: lastText, taskIntent: { kind: !hasAskShape(lastText) ? classifyChatIntent(lastText).kind : "chat", runCommands: detectChatRunCommands(lastText) ?? undefined }, optionPick, repoSnapshot });
      const repoTools = scopeProjectId ? await repoToolsAvailability(ctx, scopeProjectId) : null;
      const useRepoTools = repoTools?.available === true;
      const skillLoader = wantsLoadSkillTool(agent.onDemandSkills, "on_demand")
        ? createSkillLoader(agent.onDemandSkills, { maxCalls: LOAD_SKILL_MAX_CALLS })
        : undefined;
      const useToolLoop = useRepoTools || skillLoader !== undefined;
      const offNote = repoTools && !repoTools.available ? repoToolsOffNote(repoTools.reason) : undefined;
      const system = [
        ...buildPersonalChatSystem(agent, {
          projectName: scopeProjectId ? projectName : null,
          repoSnapshot,
          repoTools: useRepoTools,
          skillTool: skillLoader !== undefined,
        }),
        // Repo grounding only with a project attached (snapshot/tools);
        // without one it made every answer open with "belum saya cek repo".
        ...(scopeProjectId ? buildGroundingGuidance(useRepoTools, skillLoader !== undefined) : []),
        ...(scopeProjectId && personalWrite.offer ? buildPlanningGuidance(agent, { isOrchestrator: false, taskIntent: { ...classifyChatIntent(lastText), kind: "task" }, assigneeName: personalWrite.assignee?.name, codeInChat: personalWrite.codeInChat, plan: personalWrite.plan }) : []),
        wantsOptions(lastText) ? OPTIONS_GUIDANCE : "Answer in prose. Do not output an [options] block.",
        useRepoTools
          ? buildRepoToolProtocol(MAX_REPO_TOOL_CALLS, { loadSkill: skillLoader !== undefined, pastWork: true })
          : skillLoader
            ? buildSkillToolProtocol()
            : "",
        turnContext(),
      ]
        .filter(Boolean)
        .join("\n");
      try {
        const config = await resolveConfigFromProviders(llmProviders, getGlobalLLMConfig(), agent as any);
        const result = await (useToolLoop ? streamGroundedReply : streamReplyToAgent)(
          agent._id as any,
          config,
          system,
          messagesFor(String(agent._id)),
          useToolLoop
            ? {
                maxCalls: useRepoTools ? MAX_REPO_TOOL_CALLS : 0,
                ...(skillLoader ? { skillLoader } : {}),
                ...(offNote ? { traceNote: offNote } : {}),
              }
            : offNote
              ? { traceNote: offNote }
              : undefined,
        );
        // Attached chat: a work-shaped request gets the Create task button
        // (explicit only: the user still presses it, D5), from the CTO or a code role.
        const personalOffer = scopeProjectId ? offerForReply(personalWrite, result.content) : null;
        if (result.messageId && personalOffer) await ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, { messageId: result.messageId, taskOffer: personalOffer }).catch(() => undefined);
        if (scopeProjectId && result.messageId && result.content.trim() && !personalOffer) {
          const unverified = findUnverifiedRefs(result.content, result.evidence ?? EMPTY_EVIDENCE, repoSnapshot, 8, lastText);
          if (unverified.length > 0) {
            await ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, {
              messageId: result.messageId,
              unverifiedRefs: unverified,
            });
          }
        }
      } catch (err: any) {
        await ctx.runMutation(internal.chatContext.insertAgentMessage, {
          agentId: agent._id as any,
          conversationId: args.conversationId,
          content: chatFailureText(err),
          replyToMessageId: args.userMessageId,
        });
      }
      return;
    }


    // Project chat from here on: the project is required.
    const projectId = requireProjectId();
    const projectArgs: ReplyArgs = { ...args, projectId };

    // Greeting fast-path: a bare "hi" gets a brief LLM persona reply on minimal context (no history, no planning
    // guidance) — previous task commands must not drag an old topic into a full execution plan. ONE conversational
    // agent answers, not the whole team: fanning out to every agent made 12 sequential LLM calls and blew the action
    // timeout, leaving the first bubble stuck on "Thinking" forever.
    const lastContent = history[history.length - 1]?.content ?? "";
    // Who the user addressed: the @mentioned agents (or the To pick). The
    // web's old default receiver, the CTO without "@CTO" typed, counts as
    // To: Team (O3: no CTO default), so System routes the message.
    const pickedAgents = (args.preferredAgentIds ?? [])
      .map((id) => agents.find((a) => a._id === String(id)))
      .filter((a): a is ChatAgent => Boolean(a));
    const ctoTyped =
      orchestrator !== null &&
      new RegExp(`@(?:cto|${orchestrator.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\w-])`, "i").test(lastContent);
    // "@CTO" typed always addresses the CTO, picked or not.
    const mentionedAgents =
      orchestrator !== null && !ctoTyped && !quotedResponder && pickedAgents.length === 1 && String(pickedAgents[0]._id) === String(orchestrator._id)
        ? []
        : orchestrator !== null && ctoTyped && pickedAgents.length === 0
          ? [orchestrator]
          : pickedAgents;
    if (GREETING.test(lastContent.trim())) {
      const greetingHistory = [{ role: "user", content: lastContent.trim() }];
      // An @mention wins, else Support (the guidance role), else the
      // deterministic fallback. Never the CTO by default.
      const greeters = pickGreetingResponders(mentionedAgents, team);
      for (const agent of greeters) {
        try {
          const perAgentConfig = await resolveConfigFromProviders(
            llmProviders,
            globalConfig,
            agent as any
          );
          await streamReplyToAgent(
            agent._id as any,
            perAgentConfig,
            buildGreetingSystem(agent, projectName),
            greetingHistory,
          );
        } catch (err: any) {
          console.error("Greeting reply failed:", err?.message ?? err);
          continue;
        }
      }
      return;
    }

    // Option picks are conversation, not orders: a bare design question followed by a choice must NOT auto-create
    // execution tasks (the user was just asking). The pick is answered in chat; the user asks for work explicitly when
    // they want it built.
    const isOptionPick = isOptionPickText(lastContent);

    const lastUserContent = lastContent;

    // Chat never starts a task by itself. Only an explicit command
    // ("/task …", "kerjakan …") or a bare go reply to the CTO's Create task
    // offer starts one here; the Create task button is the other way in.
    const explicitCommand = isOptionPick ? null : explicitTaskCommand(lastUserContent);
    const roleOf = (id: string | undefined) => [...team, ...agents].find((a) => String(a._id) === String(id ?? ""))?.role;
    if (explicitCommand) {
      // "kerjakan itu" right after a CTO offer: the task is that offer and
      // the request it answered, not the bare words plus random turns.
      const backOffer = commandNeedsChatContext(explicitCommand) ? findOfferedTask(history, roleOf) : null;
      await dispatchTaskFromChat(ctx, projectArgs, {
        text: backOffer ? `${explicitCommand}\n\n${backOffer.command}` : explicitCommand,
        ...(backOffer ? { title: backOffer.title, conversationContext: false } : {}),
        team,
        orchestrator,
      });
      return;
    }
    if (!isOptionPick && isGoReply(lastUserContent)) {
      const offer = findOfferedTask(history, roleOf);
      if (offer) {
        await startOfferedTask(ctx, projectArgs, { offer: { ...offer, messageId: history[offer.index]?.messageId }, team, orchestrator });
        return;
      }
      // No offer to start: a bare "gas" is just chat.
    }

    // The intent below is a suggestion that shapes the reply (answer vs a
    // plan proposal with the Create task button); it never dispatches.
    let intent = await resolveIntent(ctx, projectId, lastUserContent, isOptionPick, globalConfig);
    // `taskIntent.kind === "task"` makes the CTO propose a short plan and
    // end with the Create task sentence the web button keys on.
    let taskIntent = {
      ...classifyChatIntent(lastUserContent),
      kind: intent.intent === "task" ? "task" : "chat",
      subtype: intent.subtype,
      requiresWorkspace: intent.requiresWorkspace,
      requiresExecution: intent.requiresExecution,
      // "tolong jalankan tes" → ["npm run test"]: the CTO offers Create task
      // for exactly these lines instead of claiming it has no shell.
      runCommands: detectChatRunCommands(lastUserContent) ?? undefined,
    };

    // Lifecycle intents act on the active task instead of chatting.
    if (["continue", "pause", "cancel", "status", "approve", "reject"].includes(intent.intent)) {
      if (await handleLifecycleIntent(ctx, projectArgs, intent, lastUserContent)) return;
      // Fall through to chat for anything unmatched.
    }

    // Intelligent Router (Fast Router):
    // - Multiple @mentions → sequential multi-agent replies in the user's
    //   order (FIFO per agent). Each answers only as itself; earlier replies
    //   of this turn reach later speakers through their system section.
    // - A single mention or no mention → the conversational agent (ASK) /
    //   orchestrator (TASK). Pure questions get the cheapest adequate agent.
    // Repo tools for every agent answering in this turn (the routed owner, agents the user @mentioned): only when a
    // worker can serve them (the repo lives on the worker's host). Checked once per turn. Otherwise no tools, and the
    // grounding rule makes each agent say it has not checked.
    const repoTools = !isOptionPick ? await repoToolsAvailability(ctx, projectId) : null;

    // O3 routing (lib/chat/owner.ts): a message nobody was @mentioned in is routed by System to the role that owns
    // its topic; System posts "Sent to <Role>" and the owner answers. No CTO default and no CTO wrap-up.
    let routed: ChatAgent | null = null;
    if (mentionedAgents.length === 0) {
      const owner = await resolveChatOwner<ChatAgent>({
        text: lastUserContent,
        team,
        history,
        repoToolsAvailable: repoTools?.available === true,
        optionPick: isOptionPick,
        choose: async (pool) => chooseAskResponder(pool, lastUserContent, await resolveConfigFromProviders(llmProviders, getGlobalLLMConfig())),
      });
      if (owner?.kind === "status") {
        await ctx.runMutation(internal.chatContext.insertSystemLine, {
          projectId,
          conversationId: args.conversationId,
          replyToMessageId: args.userMessageId,
          content: await taskStatusLine(ctx, projectId, team),
        });
        return;
      }
      if (owner?.kind === "agent") {
        routed = owner.agent;
        // A one-agent team has no routing decision to show.
        const line = team.length > 1 ? systemRoutingLine([owner.agent]) : "";
        const handoffMessageId = line && await ctx.runMutation(internal.chatContext.insertSystemLine, {
          projectId,
          conversationId: args.conversationId,
          replyToMessageId: args.userMessageId,
          content: line,
        });
        // Not a reply, but a prior message for echo cleanup ("System: Sent to …").
        if (line) handoffLines.push(line);
        if (handoffMessageId) {
          await ctx
            .runMutation(internal.chatContext.appendToolStep, {
              messageId: handoffMessageId,
              step: { tool: "handoff", target: owner.agent.role, ok: true, at: Date.now() },
            })
            .catch(() => undefined);
        }
        // A routed question is answered (no plan, no Create task offer). A code audit / security review routed to the
        // Reviewer is an audit, whatever the LLM labelled it (live test 4). Work-shaped messages (a change request,
        // a paste, a run request) keep their intent: the owner replies with the Create task offer.
        const preRoute = chatPreRouteAllowed({
          text: lastUserContent,
          intent,
          optionPick: isOptionPick,
          pasted: isPastedContent(lastUserContent),
          workShaped: classifyChatIntent(lastUserContent).kind === "task" && !hasAskShape(lastUserContent),
          runRequest: detectChatRunCommands(lastUserContent) !== null,
        });
        if (preRoute && owner.domain) {
          const routedSubtype = routedAnswerSubtype(owner.domain, intent.subtype);
          if (intent.intent !== "ask" || intent.subtype !== routedSubtype) {
            intent = { ...intent, intent: "ask", subtype: routedSubtype };
            taskIntent = { ...taskIntent, kind: "chat", subtype: intent.subtype };
          }
        }
      }
    }

    // The routed owner answers; otherwise the @mentioned agents, in the user's order.
    const responders: ChatAgent[] = routed ? [routed] : mentionedAgents.length > 0 ? mentionedAgents : pickConversationalAgent(team);
    // Sequential multi-agent replies: each selected agent answers with its persona.
    // The queue grows when the CTO @mentions teammates in its reply (handoff).
    const queue = [...responders];
    // One shared budget: each reply up to MAX_REPO_TOOL_CALLS, the whole
    // turn up to MAX_REPO_TOOL_CALLS_PER_CHAT.
    const toolBudget = createRepoToolBudget();
    // "Bekerja" line until the model's own first reasoning sentence lands.
    const intentLine = intentLineFor(intent, lastUserContent);
    const selfReview = isSelfReviewRequest(lastUserContent);
    const answered = new Set<string>();
    for (let turn = 0; turn < queue.length; turn += 1) {
      const agent = queue[turn];
      if (answered.has(String(agent._id))) continue;
      answered.add(String(agent._id));
      const isCto = orchestrator !== null && agent._id === orchestrator._id;
      // Write request: a short reply plus the Create task offer (lib/chat/writeOffer.ts).
      // O3: routed = addressed, so the owner System routed to can offer Create task.
      const isRouted = routed !== null && String(routed._id) === String(agent._id);
      const write = planWriteOffer({ speaker: agent, isCto, addressed: isRouted || mentionedAgents.some((a) => String(a._id) === String(agent._id)), team, text: lastUserContent, taskIntent, optionPick: isOptionPick, repoSnapshot });
      const callCap = toolBudget.capForNextReply();
      const useRepoTools = repoTools?.available === true && !workerGone && callCap > 0;
      // Skill v2: an on_demand agent reads its skills through load_skill,
      // served here (no worker needed), with or without repo tools.
      const skillLoader = wantsLoadSkillTool(agent.onDemandSkills, "on_demand")
        ? createSkillLoader(agent.onDemandSkills, { maxCalls: LOAD_SKILL_MAX_CALLS })
        : undefined;
      const useToolLoop = useRepoTools || skillLoader !== undefined;
      // Why this agent answers without repo tools, quietly in its trace.
      // "Off for the whole turn" is noted once, on the agents the user
      // addressed (not on each handoff teammate).
      const offNote = !repoTools
        ? undefined
        : !repoTools.available
          ? repoToolsOffNote(repoTools.reason)
          : workerGone
            ? repoToolsOffNote("unclaimed")
            : callCap <= 0
              ? repoToolsOffNote("budget")
              : undefined;
      const system = [
        ...buildChatPersonaLines(agent, projectName, queue, repoSnapshot, useRepoTools),
        ...buildGroundingGuidance(useRepoTools, skillLoader !== undefined), // D5: stable lines first, per-turn after
        ...(intent.intent === "ask" ? buildAnswerGuidance(intent.subtype) : []),
        ...buildPlanningGuidance(agent, { isOrchestrator: isCto, hasRepoTools: useRepoTools, taskIntent, assigneeName: write.assignee?.name, codeInChat: write.codeInChat, plan: write.plan }),
        ...(isCto && !isOptionPick
          ? buildHandoffGuidance(team, String(agent._id), {
              hasRepoTools: useRepoTools,
              offReason: useRepoTools ? undefined : (offNote ?? repoToolsOffNote(repoTools?.reason)).replace(/^Repo tools off: /, ""),
            })
          : []),
        ...(isOptionPick
          ? ["The user's last message is a button pick ('I choose …'), not their language: reply in the language of their earlier messages, in 2-3 sentences, and do not bring teammates in. Say which roles would do the work (as @Role) and that the Create task button under your reply starts it; never ask them to type a command."]
          : []),
        ...(isRouted ? [buildRoutedOwnerNotice(useRepoTools)] : []),
        selfReview
          ? buildSelfReviewGuidance(previousReplyOf(history, String(agent._id)), useRepoTools)
          : "",
        // Questions (compare, explain, recommend) get a prose answer; the
        // options picker is for choosing what to build, not for a verdict.
        intent.intent === "ask" && !wantsOptions(lastUserContent)
          ? "Answer in prose. Do not output an [options] block."
          : OPTIONS_GUIDANCE,
      ]
        .filter(Boolean)
        .join("\n");

      const systemWithContext = [
        system,
        useRepoTools
          ? buildRepoToolProtocol(callCap, { loadSkill: skillLoader !== undefined, pastWork: true })
          : skillLoader
            ? buildSkillToolProtocol()
            : "",
        turnContext(),
      ]
        .filter(Boolean)
        .join("\n");

      let content: string;
      let result: StreamReplyResult;
      try {
        const perAgentConfig = await resolveConfigFromProviders(
          llmProviders,
          getGlobalLLMConfig(),
          agent as any
        );
        result = await (useToolLoop ? streamGroundedReply : streamReplyToAgent)(
          agent._id as any,
          perAgentConfig,
          systemWithContext,
          messagesFor(String(agent._id)),
          useToolLoop
            ? {
                maxCalls: useRepoTools ? callCap : 0,
                ...(skillLoader ? { skillLoader } : {}),
                ...(offNote && !useRepoTools ? { traceNote: offNote } : {}),
                intentLine,
              }
            : { ...(offNote ? { traceNote: offNote } : {}), intentLine },
        );
        toolBudget.spend(result.toolCalls ?? 0);
        content = result.content;
        // Create task offer: the server's own reading of the request, stored on
        // the reply (the routed owner, or an @mentioned agent) so the button and "gas" never depend on wording.
        const replyOffer = offerForReply(write, content);
        if (replyOffer && result.messageId) await ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, { messageId: result.messageId, taskOffer: replyOffer }).catch(() => undefined);
        // Post-answer check: file paths and file:line references the
        // answer cites but no tool result (or the snapshot) showed. A file the
        // reply only plans to create (write offer, or named by the user) is no claim.
        if (result.messageId && content.trim() && !replyOffer) {
          const unverified = findUnverifiedRefs(content, result.evidence ?? EMPTY_EVIDENCE, repoSnapshot, 8, lastUserContent);
          if (unverified.length > 0) {
            await ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, {
              messageId: result.messageId,
              unverifiedRefs: unverified,
            });
          }
        }
      } catch (err: any) {
        await ctx.runMutation(internal.chatContext.insertAgentMessage, {
          projectId: projectId,
          agentId: agent._id as any,
          conversationId: args.conversationId,
          content: chatFailureText(err),
          replyToMessageId: args.userMessageId,
        });
        continue;
      }

      if (content.trim()) {
        // Later speakers in this turn see this reply in their system
        // section; the user's message stays the last chat message.
        turnReplies.push({ name: agent.name, content: content.trim() });
        // An @Name inside a reply never pulls a teammate in: "izinkan @QA atau @Reviewer lanjut?" is a question to
        // the user, not a handoff. Only the user's typed @mentions and System's routing bring an agent in.
      }
    }

}
