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
  hasAskShape,
  isGoReply,
  isPastedContent,
  isOptionPick as isOptionPickText,
  isRefusalReply,
  isSelfReviewRequest,
  previousReplyOf,
  targetsOutsideRepo,
  type IntentResult,
} from "./lib/chat/intent";
import { chooseAskResponder, classifyIntent } from "./lib/chat/classify";
import {
  MAX_CTO_HANDOFFS,
  ORCHESTRATOR_LIKE_ROLE,
  ORCHESTRATOR_ROLE,
  extractAgentMentions,
  selectHandoffs,
  handoffRequestFor,
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
import { readRepoSnapshot } from "./lib/chat/repoSnapshot";
import { quoteContextLine, quotedResponderId } from "./lib/chat/quote";
import {
  MAX_REPO_TOOL_CALLS,
  describeRepoToolCall,
  mayBeToolCall,
  runRepoToolLoop,
  type RepoToolCall,
  type RepoToolResult,
} from "./lib/chat/repoTools";
import {
  OPTIONS_GUIDANCE,
  buildAnswerGuidance,
  buildChatPersonaLines,
  buildConversationContext,
  buildCtoAssignmentSystem,
  buildGreetingSystem,
  buildGroundingGuidance,
  buildHandoffGuidance,
  buildHandoffNotice,
  buildPlanningGuidance,
  buildRepoToolProtocol,
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
  history: { authorType: string; content: string; agentId?: string }[];
  contextSummary?: string;
  activeTask?: { title: string; status: string } | null;
  llmProviders?: PoolConnectionPayload[];
};

type ReplyArgs = {
  projectId: Id<"projects">;
  conversationId?: Id<"conversations">;
  preferredAgentIds?: Id<"agents">[];
  userMessageId: Id<"messages">;
  /** Plan 020: permission mode for the task this message may dispatch. */
  permissionMode?: PermissionMode;
};

const TERMINAL_TASK_STATUSES = ["done", "rejected", "failed"];

/** How long one repo tool call may wait for a worker before it counts as not checked. */
const REPO_TOOL_WAIT_MS = 20_000;
const REPO_TOOL_POLL_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Append one reasoning chunk to the reply's trace. */
function joinTrace(trace: string, next: string | undefined): string {
  const add = (next ?? "").trim();
  if (!add) return trace;
  return trace ? `${trace}\n\n${add}` : add;
}

/**
 * Run one read-only repo tool through the worker queue (repoTools.ts):
 * enqueue, poll for the worker's answer, always delete the row. Never
 * throws; a timeout or failure comes back as ok:false.
 */
async function callRepoToolViaWorker(
  ctx: ActionCtx,
  projectId: Id<"projects">,
  call: RepoToolCall
): Promise<RepoToolResult> {
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
    const deadline = Date.now() + REPO_TOOL_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(REPO_TOOL_POLL_MS);
      const row = await ctx.runQuery(internal.repoTools.get, { callId });
      if (!row) break;
      if (row.status === "done") return { ok: true, text: row.result ?? "", files: row.files ?? [] };
      if (row.status === "error") return { ok: false, text: row.error ?? "Tool failed." };
    }
    return { ok: false, text: "No worker answered this tool call in time; treat it as not checked." };
  } finally {
    await ctx.runMutation(internal.repoTools.remove, { callId }).catch(() => undefined);
  }
}

/** Repo tools are usable for this reply (workspace set + worker online). Never throws. */
async function repoToolsAvailable(ctx: ActionCtx, projectId: Id<"projects">): Promise<boolean> {
  try {
    const res = await ctx.runQuery(internal.repoTools.availability, { projectId });
    return res.available;
  } catch {
    return false;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    await ctx.runMutation(internal.chatContext.insertAgentMessage, {
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

/** Refusal copy for a request that targets a path outside the repository. */
function outsideRepoReply(text: string, outsidePath: string): string {
  const indonesian = /\b(hapus|ubah|edit|tambah\w*|buat\w*|dan|yang|tolong|jangan)\b/i.test(text) && /\b(dan|yang|tolong|hapus|buat\w*)\b/i.test(text);
  return indonesian
    ? `Saya tidak membuat task untuk ini: \`${outsidePath}\` ada di luar repository project. Tim hanya mengubah file di dalam folder project.`
    : `I won't create a task for this: \`${outsidePath}\` is outside the project repository. The team only changes files inside the project folder.`;
}

type StreamReply = (
  agentId: Id<"agents">,
  config: ChatLlmConfig,
  system: string,
  msgs: { role: string; content: string }[],
) => Promise<CompleteResult>;

/**
 * Explicit dispatch: an explicit command ("/task …", "kerjakan …") creates
 * the task row and skips the chat loop. Never reached from the classifier.
 * Idempotent per message: the same command can only create one live task.
 */
async function dispatchTaskFromChat(
  ctx: ActionCtx,
  args: ReplyArgs,
  opts: {
    text: string;
    agents: ChatAgent[];
    team: ChatAgent[];
    orchestrator: ChatAgent | null;
    dispatcher: ChatAgent;
    projectName: string;
    conversation: { role: string; content: string }[];
    llmProviders?: PoolConnectionPayload[];
    globalConfig: ChatLlmConfig;
    streamReplyToAgent: StreamReply;
  }
): Promise<void> {
  const { text, team, orchestrator, dispatcher } = opts;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { api: idemApi } = await import("./_generated/api.js") as any;
  const existing = await (ctx as any).runQuery(idemApi.tasks.listByProject, { projectId: args.projectId });
  const dupe = (existing as any[]).find(
    (t: any) =>
      t.command === text &&
      !TERMINAL_TASK_STATUSES.includes(t.status)
  );
  if (dupe) {
    return; // already dispatched; UI shows the task
  }
  // Safety: a request aimed at paths outside the repository is never
  // turned into a task — the worker would only refuse it later, after
  // planning and approvals (e2e safety probe).
  const outsidePath = targetsOutsideRepo(text);
  if (outsidePath) {
    await ctx.runMutation(internal.chatContext.insertAgentMessage, {
      projectId: args.projectId,
      agentId: dispatcher._id as any,
      conversationId: args.conversationId,
      replyToMessageId: args.userMessageId,
      content: outsideRepoReply(text, outsidePath),
    });
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { api } = await import("./_generated/api.js") as any;
    // Explicit @mentions from the user are assignees too.
    const userAssignees = (args.preferredAgentIds ?? [])
      .map((id) => team.find((a) => a._id === String(id)))
      .filter((a): a is ChatAgent => Boolean(a) && a!._id !== orchestrator?._id);
    // CTO assignment: the CTO answers with a short plan and @mentions the
    // teammates who own each part; those become the task's assignees.
    let ctoAssignees: ChatAgent[] = [];
    if (orchestrator) {
      try {
        const ctoConfig = await resolveConfigFromProviders(opts.llmProviders, opts.globalConfig, orchestrator as any);
        const plan = await opts.streamReplyToAgent(
          orchestrator._id as any,
          ctoConfig,
          buildCtoAssignmentSystem(orchestrator, opts.projectName, team, userAssignees),
          opts.conversation,
        );
        ctoAssignees = extractAgentMentions(plan.content, team, String(orchestrator._id));
        // The CTO declined the request: its reply stands as the
        // answer and no task is created or dispatched.
        if (isRefusalReply(plan.content, ctoAssignees.length)) {
          return;
        }
      } catch (err: any) {
        console.error("CTO assignment reply failed:", err?.message ?? err);
      }
    }
    // The CTO's reply may name nobody (empty reply, no @mentions); pick
    // owners from the request itself instead of handing it to everyone.
    const keywordAssignees =
      userAssignees.length || ctoAssignees.length
        ? []
        : suggestAssigneesByKeywords(text, team.filter((a) => a._id !== orchestrator?._id));
    const assignees = resolveAssignees(team, orchestrator, [...userAssignees, ...ctoAssignees, ...keywordAssignees]);
    const taskId = await (ctx as any).runMutation(api.tasks.createFromCommand, {
      projectId: args.projectId,
      command: text,
      title: text.slice(0, 80),
      conversationId: args.conversationId,
      ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
      ...(assignees.length ? { assignedAgentIds: assignees.map((a) => a._id) } : {}),
    });
    if (orchestrator) {
      await ctx.runMutation(internal.chatContext.insertAgentMessage, {
        projectId: args.projectId,
        agentId: orchestrator._id as any,
        conversationId: args.conversationId,
        replyToMessageId: args.userMessageId,
        taskId: taskId as any,
        content: "",
        card: {
          kind: "assignment",
          data: {
            taskId: String(taskId),
            title: text.slice(0, 80),
            assignees: (assignees.length ? assignees : team)
              .filter((a) => a._id !== orchestrator._id)
              .map((a) => ({ agentId: String(a._id), name: a.name, role: a.role })),
            assignedBy: orchestrator.name,
          },
        },
      });
    }
  } catch (e: any) {
    console.error("Auto-dispatch failed:", e?.message ?? e);
    await ctx.runMutation(internal.chatContext.insertAgentMessage, {
      projectId: args.projectId,
      agentId: dispatcher._id as any,
      conversationId: args.conversationId,
      content: `I couldn't create the task (${e?.message ?? "unknown error"}). Please try again or create the task manually.`,
      replyToMessageId: args.userMessageId,
    });
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
  opts: { offer: { command: string; title?: string; reply: string }; team: ChatAgent[]; orchestrator: ChatAgent | null; dispatcher: ChatAgent }
): Promise<void> {
  const { offer, team, orchestrator, dispatcher } = opts;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { api } = (await import("./_generated/api.js")) as any;
  const existing = (await ctx.runQuery(api.tasks.listByProject, { projectId: args.projectId })) as any[];
  if (existing.some((t: any) => t.command === offer.command && !TERMINAL_TASK_STATUSES.includes(t.status))) return;
  const assignees = extractAgentMentions(offer.reply, team, String(orchestrator?._id ?? ""));
  const title = offer.title ?? offer.command.split("\n")[0].slice(0, 80);
  try {
    const taskId = await ctx.runMutation(api.tasks.createFromCommand, {
      projectId: args.projectId,
      command: offer.command,
      title,
      conversationId: args.conversationId,
      ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
      ...(assignees.length ? { assignedAgentIds: assignees.map((a) => a._id) } : {}),
    });
    if (orchestrator) {
      await ctx.runMutation(internal.chatContext.insertAgentMessage, {
        projectId: args.projectId,
        agentId: orchestrator._id as any,
        conversationId: args.conversationId,
        replyToMessageId: args.userMessageId,
        taskId: taskId as any,
        content: "",
        card: {
          kind: "assignment",
          data: {
            taskId: String(taskId),
            title,
            assignees: (assignees.length ? assignees : team)
              .filter((a) => a._id !== orchestrator._id)
              .map((a) => ({ agentId: String(a._id), name: a.name, role: a.role })),
            assignedBy: orchestrator.name,
          },
        },
      });
    }
  } catch (e: any) {
    console.error("Offered task start failed:", e?.message ?? e);
    await ctx.runMutation(internal.chatContext.insertAgentMessage, {
      projectId: args.projectId,
      agentId: dispatcher._id as any,
      conversationId: args.conversationId,
      content: `I couldn't create the task (${e?.message ?? "unknown error"}). Use the Create task button under the plan instead.`,
      replyToMessageId: args.userMessageId,
    });
  }
}

export const replyToChat = internalAction({
  args: {
    projectId: v.id("projects"),
    conversationId: v.optional(v.id("conversations")),
    preferredAgentIds: v.optional(v.array(v.id("agents"))),
    userMessageId: v.id("messages"),
    permissionMode: v.optional(permissionModeValidator),
  },
  handler: async (ctx, rawArgs) => {
    // Concurrency guard: check if this message was already answered
    const alreadyReplied = await ctx.runQuery(internal.chatContext.checkAlreadyReplied, {
      userMessageId: rawArgs.userMessageId,
    });
    if (alreadyReplied) return;

    // Reply quote: replying to a teammate's message (no @mention) routes the
    // answer to that teammate, as if the user had @mentioned it. The CTO and
    // the user's own messages route as usual; either way the quoted text
    // rides into the context below.
    const quoteInfo = await ctx.runQuery(internal.chatContext.getQuoteForReply, {
      userMessageId: rawArgs.userMessageId,
    });
    const quotedResponder = quoteInfo ? quotedResponderId(quoteInfo.quote, quoteInfo.userMentionCount) : null;
    const args: ReplyArgs = quotedResponder
      ? { ...rawArgs, preferredAgentIds: [quotedResponder as Id<"agents">] }
      : rawArgs;

    const data = (await ctx.runQuery(internal.chatContext.getContext, {
      projectId: args.projectId,
      conversationId: args.conversationId,
      preferredAgentIds: args.preferredAgentIds,
      userMessageId: args.userMessageId,
    })) as ChatContextData;

    const { agents, team: teamAgents, projectName, history, llmProviders } = data;
    const globalConfig = await resolveConfigFromProviders(llmProviders, getGlobalLLMConfig());

    // Repo snapshot (read-only, workspace-confined) so structural chat
    // questions ("how is this repo structured?") can be answered from
    // evidence instead of guesses.
    const repoSnapshot = await loadRepoSnapshot(ctx, args.projectId);

    if (agents.length === 0) {
      await ctx.runMutation(internal.chatContext.insertAgentMessage, {
        projectId: args.projectId,
        conversationId: args.conversationId,
        content: "No enabled agents are participating in this conversation. Add agents to the project team and select them for chat.",
        replyToMessageId: args.userMessageId,
      });
      return;
    }

    const conversation = history.map((m) => ({
      role: m.authorType === "agent" ? "assistant" : "user",
      content: m.content,
    }));
    // Plan 006 Phase 3: prompt builder uses summary + last 12. The summary
    // carries the compacted tail so the LLM keeps bounded context.
    if (data.contextSummary) {
      conversation.unshift({
        role: "system",
        content: `Conversation summary: ${data.contextSummary}`,
      });
    }
    // The quoted message sits right before the user's reply so the agent
    // knows what "this"/"ini" refers to, even when it is older than the
    // history window.
    if (quoteInfo) {
      const line = { role: "system", content: quoteContextLine(quoteInfo.quote) };
      const last = conversation.length - 1;
      if (last >= 0 && conversation[last].role === "user") conversation.splice(last, 0, line);
      else conversation.push(line);
    }

    // Only an agent whose ROLE is exactly "cto" may act as the orchestrator
    // (legacy "architect" accepted for backward compat). Anchored: an
    // unanchored match also hit "director", "doctor", …
    // Falling back to agents[0] made any selected agent
    // introduce itself as "the orchestrator/planner" while still naming its own
    // role (e.g. "frontend developer ... I'm the orchestrator/planner").
    const orchestrator =
      agents.find((a) => ORCHESTRATOR_ROLE.test(a.role.trim())) ??
      null;
    // The dispatcher creates the task row. It may be the orchestrator, or the
    // first agent when the project has no CTO — but a non-orchestrator
    // never receives planning guidance.
    const dispatcher = orchestrator ?? agents[0];
    const team = teamAgents ?? agents;

    // Streaming persist helper: create the agent message row first, then
    // patch content/reasoning as SSE chunks arrive so the UI shows the
    // bubble + "Thinking" trace live. Patches are throttled to avoid a
    // mutation per token.
    const streamReplyToAgent: StreamReply = async (agentId, config, system, msgs) => {
      const messageId = await ctx.runMutation(internal.chatContext.createStreamingAgentMessage, {
        projectId: args.projectId,
        agentId: agentId as any,
        conversationId: args.conversationId,
        replyToMessageId: args.userMessageId,
      });
      let lastPatchAt = 0;
      // Partial patches run one at a time; the final patch waits for the
      // last one. Fire-and-forget patches could land AFTER the final write
      // and overwrite the full reply with a truncated snapshot.
      let patchChain: Promise<unknown> = Promise.resolve();
      let raw: Awaited<ReturnType<typeof completeWithAgent>>;
      try {
      raw = await completeWithAgent(system, msgs, config, ({ content: rawContent, reasoning }) => {
        const content = stripToolCallMarkup(rawContent);
        const now = Date.now();
        if (now - lastPatchAt < 250 || (!content.trim() && !reasoning.trim())) return;
        lastPatchAt = now;
        patchChain = patchChain
          .then(() =>
            ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, {
              messageId: messageId as any,
              content,
              reasoning: reasoning || undefined,
            })
          )
          .catch(() => {});
      });
      } catch (error) {
        // Never leave the bubble animating after a failed call.
        await patchChain;
        await ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, {
          messageId: messageId as any,
          streaming: false,
        });
        await ctx.runMutation(internal.chatContext.removeEmptyAgentMessage, { messageId: messageId as any });
        throw error;
      }
      await patchChain;
      // Chat agents have no tools; drop tool-call text some models emit anyway.
      const result = { ...raw, content: stripToolCallMarkup(raw.content) };
      await ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, {
        messageId: messageId as any,
        content: result.content,
        reasoning: result.reasoning || undefined,
        reasoningDurationMs: result.reasoningDurationMs || undefined,
        streaming: false,
      });
      // A reply that produced only reasoning (e.g. the model ran out of
      // tokens while thinking) would render as an empty bubble.
      if (!result.content.trim()) {
        await ctx.runMutation(internal.chatContext.removeEmptyAgentMessage, { messageId: messageId as any });
      }
      return result;
    };

    // Grounded reply (CTO with repo tools): the same streaming bubble, but
    // each LLM step may be a JSON tool call instead of the answer. Tool-call
    // text is never shown; the trace notes each check, and the files read
    // are stored as `checkedFiles` for the quiet "Checked: …" line.
    const streamGroundedReply: StreamReply = async (agentId, config, system, msgs) => {
      const messageId = await ctx.runMutation(internal.chatContext.createStreamingAgentMessage, {
        projectId: args.projectId,
        agentId: agentId as any,
        conversationId: args.conversationId,
        replyToMessageId: args.userMessageId,
      });
      const startedAt = Date.now();
      let trace = "";
      let lastPatchAt = 0;
      let patchChain: Promise<unknown> = Promise.resolve();
      const patch = (fields: { content?: string; reasoning?: string }) => {
        patchChain = patchChain
          .then(() =>
            ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, { messageId: messageId as any, ...fields })
          )
          .catch(() => {});
      };
      let loop: Awaited<ReturnType<typeof runRepoToolLoop>>;
      try {
        loop = await runRepoToolLoop({
          messages: msgs,
          maxCalls: MAX_REPO_TOOL_CALLS,
          step: async (stepMsgs) => {
            const raw = await completeWithAgent(system, stepMsgs, config, ({ content: rawContent, reasoning }) => {
              const now = Date.now();
              if (now - lastPatchAt < 250) return;
              const content = mayBeToolCall(rawContent) ? "" : stripToolCallMarkup(rawContent);
              const liveTrace = joinTrace(trace, reasoning);
              if (!content.trim() && !liveTrace.trim()) return;
              lastPatchAt = now;
              patch({ content, reasoning: liveTrace || undefined });
            });
            trace = joinTrace(trace, raw.reasoning);
            return { content: raw.content };
          },
          callTool: (call) => callRepoToolViaWorker(ctx, args.projectId, call),
          onToolCall: (call, result) => {
            trace = joinTrace(trace, `Checked ${describeRepoToolCall(call)}${result.ok ? "" : " (failed)"}`);
            lastPatchAt = Date.now();
            patch({ content: "", reasoning: trace });
          },
        });
      } catch (error) {
        await patchChain;
        await ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, {
          messageId: messageId as any,
          streaming: false,
        });
        await ctx.runMutation(internal.chatContext.removeEmptyAgentMessage, { messageId: messageId as any });
        throw error;
      }
      await patchChain;
      const content = stripToolCallMarkup(loop.answer);
      const reasoningDurationMs = Date.now() - startedAt;
      await ctx.runMutation(internal.chatContext.updateStreamingAgentMessage, {
        messageId: messageId as any,
        content,
        reasoning: trace || undefined,
        reasoningDurationMs,
        streaming: false,
        ...(loop.checkedFiles.length ? { checkedFiles: loop.checkedFiles.slice(0, 20) } : {}),
      });
      if (!content.trim()) {
        await ctx.runMutation(internal.chatContext.removeEmptyAgentMessage, { messageId: messageId as any });
      }
      return { content, reasoning: trace, reasoningDurationMs };
    };

    // Greeting fast-path: a bare "hi" gets a brief LLM persona reply on
    // minimal context (no history, no planning guidance) — previous task
    // commands must not drag an old topic into a full execution plan.
    // ONE conversational agent answers, not the whole team: fanning out to
    // every agent made 12 sequential LLM calls and blew the action timeout,
    // leaving the first bubble stuck on "Thinking" forever.
    const lastContent = history[history.length - 1]?.content ?? "";
    if (GREETING.test(lastContent.trim())) {
      const greetingHistory = [{ role: "user", content: lastContent.trim() }];
      // Same speaker rule as ASK: an @mention wins, else the CTO (the
      // default chat participant), else the deterministic fallback.
      const greetingMentions = (args.preferredAgentIds ?? [])
        .map((id) => agents.find((a) => a._id === String(id)))
        .filter((a): a is ChatAgent => Boolean(a));
      const greeters = pickGreetingResponders(greetingMentions, orchestrator, team);
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

    // Option picks are conversation, not orders: a bare design question
    // followed by a choice must NOT auto-create execution tasks (the user
    // was just asking). The pick is answered in chat; the user asks for
    // work explicitly when they want it built.
    const isOptionPick = isOptionPickText(lastContent);

    const lastUserContent = lastContent;

    // Chat never starts a task by itself. Only an explicit command
    // ("/task …", "kerjakan …") or a bare go reply to the CTO's Create task
    // offer starts one here; the Create task button is the other way in.
    const explicitCommand = isOptionPick ? null : explicitTaskCommand(lastUserContent);
    if (explicitCommand) {
      await dispatchTaskFromChat(ctx, args, {
        text: explicitCommand,
        agents,
        team,
        orchestrator,
        dispatcher,
        projectName,
        conversation,
        llmProviders,
        globalConfig,
        streamReplyToAgent,
      });
      return;
    }
    if (!isOptionPick && isGoReply(lastUserContent)) {
      const roleOf = (id: string | undefined) => [...team, ...agents].find((a) => String(a._id) === String(id ?? ""))?.role;
      const offer = findOfferedTask(history, roleOf);
      if (offer) {
        await startOfferedTask(ctx, args, { offer, team, orchestrator, dispatcher });
        return;
      }
      // No offer to start: a bare "gas" is just chat.
    }

    // The intent below is a suggestion that shapes the reply (answer vs a
    // plan proposal with the Create task button); it never dispatches.
    const intent = await resolveIntent(ctx, args.projectId, lastUserContent, isOptionPick, globalConfig);
    // `taskIntent.kind === "task"` makes the CTO propose a short plan and
    // end with the Create task sentence the web button keys on.
    const taskIntent = {
      ...classifyChatIntent(lastUserContent),
      kind: intent.intent === "task" ? "task" : "chat",
      subtype: intent.subtype,
      requiresWorkspace: intent.requiresWorkspace,
      requiresExecution: intent.requiresExecution,
    };

    // Lifecycle intents act on the active task instead of chatting.
    if (["continue", "pause", "cancel", "status", "approve", "reject"].includes(intent.intent)) {
      if (await handleLifecycleIntent(ctx, args, intent, lastUserContent)) return;
      // Fall through to chat for anything unmatched.
    }

    // Intelligent Router (Fast Router):
    // - Multiple @mentions → sequential multi-agent replies in the user's
    //   order (FIFO per agent). The conversation context is appended to the
    //   SAME array, so later mentions answer after the earlier replies.
    // - A single mention or no mention → the conversational agent (ASK) /
    //   orchestrator (TASK). Pure questions get the cheapest adequate agent.
    const mentionedAgents = (args.preferredAgentIds ?? [])
      .map((id) => agents.find((a) => a._id === String(id)))
      .filter((a): a is ChatAgent => Boolean(a));
    let responders: ChatAgent[];
    // A suggested work request ("task") is answered like a question: the
    // CTO (or the @mentioned agent) replies, with a plan proposal.
    if ((intent.intent === "ask" || intent.intent === "task") && !isOptionPick) {
      if (mentionedAgents.length > 0) {
        responders = mentionedAgents;
      } else if (orchestrator !== null) {
        // The CTO is in the chat (the default participant): it answers and
        // pulls teammates in by @mention when their expertise is needed.
        responders = [orchestrator];
      } else {
        const pool = team.filter((a) => !ORCHESTRATOR_LIKE_ROLE.test(a.role.trim()));
        const pickedId = await chooseAskResponder(
          pool,
          lastUserContent,
          await resolveConfigFromProviders(llmProviders, getGlobalLLMConfig())
        );
        const picked = pickedId ? pool.filter((a) => String(a._id) === pickedId) : [];
        responders = picked.length ? picked : pickConversationalAgent(team);
      }
    } else if (isOptionPick) {
      // A pick is answered by the one agent that offered the options (the
      // CTO by default), not by the whole team.
      responders = mentionedAgents.length > 0 ? mentionedAgents.slice(0, 1) : orchestrator ? [orchestrator] : pickConversationalAgent(team);
    } else {
      responders = agents;
    }
    // Sequential multi-agent replies: each selected agent answers with its persona.
    // The queue grows when the CTO @mentions teammates in its reply (handoff).
    const queue = [...responders];
    // Repo tools for the CTO's reply: only when a worker can serve them
    // (the repo lives on the worker's host). Otherwise no tools, and the
    // grounding rule makes the CTO say it has not checked.
    const ctoHasRepoTools =
      orchestrator !== null && !isOptionPick && queue.some((a) => a._id === orchestrator._id)
        ? await repoToolsAvailable(ctx, args.projectId)
        : false;
    const selfReview = isSelfReviewRequest(lastUserContent);
    const answered = new Set<string>();
    const handoffFrom = new Map<string, { by: string; request: string }>();
    let handoffs = 0;
    for (let turn = 0; turn < queue.length; turn += 1) {
      const agent = queue[turn];
      if (answered.has(String(agent._id))) continue;
      answered.add(String(agent._id));
      const isCto = orchestrator !== null && agent._id === orchestrator._id;
      const handoffBy = handoffFrom.get(String(agent._id));
      const useRepoTools = isCto && ctoHasRepoTools;
      const system = [
        ...buildChatPersonaLines(agent, projectName, queue, repoSnapshot, useRepoTools),
        ...(intent.intent === "ask" ? buildAnswerGuidance(intent.subtype) : []),
        ...buildPlanningGuidance(agent, { isOrchestrator: isCto, taskIntent }),
        ...(isCto && !isOptionPick ? buildHandoffGuidance(team, String(agent._id)) : []),
        ...(isOptionPick
          ? ["The user's last message is a button pick ('I choose …'), not their language: reply in the language of their earlier messages, in 2-3 sentences, and do not bring teammates in. Say which roles would do the work (as @Role) and that the Create task button under your reply starts it; never ask them to type a command."]
          : []),
        ...(handoffBy !== undefined ? [buildHandoffNotice(handoffBy.by, handoffBy.request)] : []),
        ...buildGroundingGuidance(useRepoTools),
        selfReview && handoffBy === undefined
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
        useRepoTools ? buildRepoToolProtocol(MAX_REPO_TOOL_CALLS) : "",
        buildConversationContext(conversation),
      ]
        .filter(Boolean)
        .join("\n");

      let content: string;
      try {
        const perAgentConfig = await resolveConfigFromProviders(
          llmProviders,
          getGlobalLLMConfig(),
          agent as any
        );
        const result = await (useRepoTools ? streamGroundedReply : streamReplyToAgent)(
          agent._id as any,
          perAgentConfig,
          systemWithContext,
          conversation,
        );
        content = result.content;
      } catch (err: any) {
        await ctx.runMutation(internal.chatContext.insertAgentMessage, {
          projectId: args.projectId,
          agentId: agent._id as any,
          conversationId: args.conversationId,
          content: `I couldn't reply (${err.message}). Check global LLM settings.`,
          replyToMessageId: args.userMessageId,
        });
        continue;
      }

      if (content.trim()) {
        // Append response to conversation so subsequent agents have context
        conversation.push({ role: "assistant", content: `${agent.name}: ${content.trim()}` });
        // CTO handoff: teammates it @mentioned answer next, in order.
        if (isCto && !isOptionPick) {
          for (const mentioned of selectHandoffs(content, team, String(agent._id))) {
            if (handoffs >= MAX_CTO_HANDOFFS) break;
            if (answered.has(String(mentioned._id))) continue;
            if (queue.some((queued, index) => index > turn && queued._id === mentioned._id)) continue;
            queue.push(mentioned);
            handoffFrom.set(String(mentioned._id), { by: agent.name, request: handoffRequestFor(content, mentioned) });
            handoffs += 1;
          }
        }
      }
    }
  },
});
