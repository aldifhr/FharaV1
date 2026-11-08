"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  pickPrimaryConnection,
  resolveConnectionKey,
  type PoolConnectionPayload,
} from "./llmResolver";

// Mirrored from packages/worker/src/router/route.ts (Convex cannot import
// worker code). The backend chat auto-dispatch must honor the same platform
// rule: questions, advice and analysis never become tasks.
const QUESTION_SHAPE =
  /\b(how do i|how to|how can|how does|why|what is|what are|what's|what does|what do|where is|explain|describe|summari[sz]e|document|understand)\b/i;
const ADVICE_SHAPE =
  /\b(should i|recommend|best (practice|way)|suggest|advice|prefer)\b/i;
const EXPLICIT_NEGATION =
  /\b(do not|don't|dont|never)\b.*\b(create|make|start|run|execute|buat|bikin|jalankan)\b.*\btask\b|\b(jangan|tidak perlu)\b.*\btask\b/i;

/** Bare greetings/small talk — replied to deterministically without the
 *  LLM, so conversation history cannot drag an old topic (and a full
 *  execution plan) into a "hi". */
export const GREETING =
  /^(hi|hello|hey|halo|hai|yo|good (morning|afternoon|evening))[!.,?\s]*$/i;

export function classifyChatIntent(text: string): { kind: string; frontend: boolean; backend: boolean; testing: boolean; security: boolean } {
  const t = text.toLowerCase();
  const frontend = /\b(frontend|ui|react|component|page|button|css|tailwind)\b/.test(t);
  const backend = /\b(backend|api|server|database|auth|endpoint|convex)\b/.test(t);
  const testing = /\b(test|qa|e2e|bug|error)\b/.test(t);
  const security = /\b(security|audit|vulnerab|secret)\b/.test(t);

  // Explicit user instruction always wins: "do not create a task" must be
  // honored as chat even when the text contains change verbs.
  if (EXPLICIT_NEGATION.test(text)) {
    return { kind: "chat", frontend, backend, testing, security };
  }
  // Boundary guard (same as worker router): question/advice shapes never
  // become tasks, even when they contain a change verb.
  if (QUESTION_SHAPE.test(text) || ADVICE_SHAPE.test(text)) {
    return { kind: "chat", frontend, backend, testing, security };
  }
  // Read-only analysis without a change verb is chat (audit/research).
  const hasChangeVerb = /\b(buat|tambah|implement|build|create|fix|perbaiki|refactor|update|change|add|remove)\b/i.test(t);
  const isReadOnly = /\b(audit|review|research|investigate|analyze|analyse)\b/i.test(t);
  if (isReadOnly && !hasChangeVerb) {
    return { kind: "chat", frontend, backend, testing, security };
  }

  // If command contains impl keywords, treat as task regardless
  const impl = /\b(buatin|buat|tambah|implement|build|create|fix|perbaiki|refactor|update|change|add|remove|migrate|convert|scaffold|setup|install|pindah|konversi|pasang|sesuaikan)\b/.test(t);
  return { kind: impl ? "task" : "chat", frontend, backend, testing, security };
}

/**
 * Stage B — Semantic fallback. Called only when Stage A (regex) is uncertain.
 * Uses the shared provider pool (same infra as chat). Invalid output fails
 * closed to chat.
 */
async function classifySemantically(
  text: string,
  config: { apiKey: string; provider: string; model: string; baseUrl: string }
): Promise<{ kind: "task" | "chat"; summary: string } | null> {
  const prompt = [
    "Classify intent: reply ONLY JSON {\"intent\":\"execute_task\"|\"chat\"|\"clarify\",\"confidence\":0..1,\"summary\":\"...\"}",
    "execute_task = user wants AI team to DO work in this project (migrate, refactor, create, setup Docker, add UI, switch stack). chat = pure question/discussion.",
    `Text (${text.length > 500 ? text.slice(0, 500) + "..." : text})`,
  ].join("\n");
  const raw = await completeWithAgent("Classify intent. Return JSON only.", [{ role: "user", content: prompt }], config).catch(() => "");
  const match = raw.trim().match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const o = JSON.parse(match[0]) as { intent?: string; summary?: string };
    if (!o.intent) return null;
    if (o.intent === "execute_task") return { kind: "task", summary: o.summary ?? "" };
    if (o.intent === "chat" || o.intent === "clarify") return { kind: "chat", summary: o.summary ?? "" };
  } catch {}
  return null;
}

function buildPlanningGuidance(agent: { role: string }, opts: { isOrchestrator: boolean; taskIntent: { kind: string; frontend: boolean; backend: boolean; testing: boolean; security: boolean } }): string[] {
  if (opts.isOrchestrator && opts.taskIntent.kind === "task") {
    return [
      "You are the orchestrator/planner (CTO).",
      "Do NOT just chat. Produce a concise execution PLAN for this request:",
      "1) 2-4 concrete subtasks: name + owner agent (role) + files/routes to inspect + expected finding/output.",
      "2) Order & dependencies (what blocks what).",
      "3) Validation per subtask (typecheck, tests, audit checklist).",
      "4) End with exact delegation line: 'Delegasi: [Agent A] untuk X, [Agent B] untuk Y.'",
      "Do NOT offer a shortcut / lazy alternative. Audit the full scope the user asked for.",
      "Then end with: 'To execute this plan, klik Create task — saya akan delegasikan ke agent yang sesuai.'",
      "Do not pretend to have executed code.",
    ];
  }
  if (opts.isOrchestrator) {
    return [
      "You are the orchestrator/planner.",
      "Greetings and small talk get a brief greeting back — never a plan, delegation, or mention list for a bare hello.",
      "Answer briefly. If user asks for work to be done, propose a plan + delegation, then tell them to use Create task. Do not pretend to have executed code. Respond in plain text.",
    ];
  }
  return [
    "Answer the user's chat message helpfully and briefly from your perspective in the same language as the user.",
    "You have NO workspace file access in this chat thread. Do not claim to have read files, run commands, or audited code here.",
    "For anything that needs workspace access (audit, review, read files, run code), tell the user to Create task so the worker (which CAN read the workspace) can do it.",
    "Do not pretend to have executed code. Respond in plain text.",
  ];
}

async function completeWithAgent(
  system: string,
  history: { role: string; content: string }[],
  globalConfig: { provider: string; model: string; baseUrl: string; apiKey: string }
): Promise<string> {
  const { provider, model, baseUrl, apiKey } = globalConfig;
  if (!apiKey) throw new Error("No LLM API key configured. Add a provider in Settings (LLM) or set LLM_API_KEY in Convex env");

  const messages = history.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  const doFetch = async (url: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (!res.ok && res.status >= 500 && timeoutMs > 0) {
        // One lightweight retry for transient 5xx (no backoff explosion).
        const res2 = await fetch(url, { ...init, signal: ctrl.signal });
        if (res2.ok) return res2;
        return res2;
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  };

  if (provider === "openai" || provider === "openai-compatible") {
    const base = baseUrl.replace(/\/$/, "");
    const res = await doFetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });
    if (!res.ok) throw new Error(`LLM request failed: ${res.status}`);
    const text = await res.text();
    const normalized = text.replace(/(?:\r?\n)?data:\s*\[DONE\]\s*$/, "").trim();
    if (!normalized) return "";
    try {
      const data: any = JSON.parse(normalized);
      const c = data.choices?.[0]?.message?.content;
      // Never use reasoning trace as user-facing answer.
      if (typeof c === "string" && c.trim()) return c;
      return c ?? "";
    } catch {
      // SSE fallback: data: {...} lines — only delta.content (not reasoning)
      const parts: string[] = [];
      for (const line of normalized.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const d: any = JSON.parse(payload);
          const delta = d.choices?.[0]?.delta?.content ?? "";
          if (delta) parts.push(delta);
        } catch {}
      }
      if (parts.length) return parts.join("");
      throw new Error(`LLM returned non-JSON response`);
    }
  }

  // anthropic
  const base = baseUrl.replace(/\/$/, "");
  const res = await doFetch(`${base}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: system || undefined,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`LLM request failed: ${res.status}`);
  const data: any = await res.json();
  return (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
}

function getGlobalLLMConfig(): { provider: string; model: string; baseUrl: string; apiKey: string } {
  const env: Record<string, string | undefined> =
    (globalThis as any).process?.env ?? {};
  const provider = (env.LLM_PROVIDER ?? "anthropic").toLowerCase();
  return {
    provider,
    model: env.LLM_MODEL ?? (provider === "openai" ? "gpt-4o-mini" : "claude-sonnet-4-20250514"),
    baseUrl: provider === "openai"
      ? (env.LLM_OPENAI_BASE_URL ?? env.LLM_BASE_URL ?? "https://api.openai.com/v1")
      : (env.LLM_ANTHROPIC_BASE_URL ?? env.LLM_BASE_URL ?? "https://api.anthropic.com/v1"),
    apiKey: env.LLM_API_KEY ?? env.OPENAI_API_KEY ?? "",
  };
}

/**
 * Resolve the chat LLM config from the shared provider pool (llmResolver).
 * Respects per-agent assignment when the agent carries one (llmProviderId +
 * llmModelId): that connection+model wins; otherwise fall back to the primary
 * connection (lowest priority with an available model). The key is decrypted
 * here on the backend for the backend's own call — a decryption failure is a
 * hard error naming the provider — with the connection's `apiKeyEnv` env var
 * as fallback.
 */
async function resolveConfigFromProviders(
  providers: PoolConnectionPayload[] | undefined,
  fallback: { provider: string; model: string; baseUrl: string; apiKey: string },
  agent?: { llmProviderId?: string; llmModelId?: string; llmFallbackProviderId?: string; llmFallbackModelId?: string; llmSelectionPolicy?: string }
): Promise<{ provider: string; model: string; baseUrl: string; apiKey: string }> {
  if (providers && agent?.llmProviderId) {
    const conn = providers.find((p) => String(p._id) === String(agent.llmProviderId));
    if (conn) {
      const model =
        conn.models.find((m) => String(m._id) === String(agent.llmModelId)) ??
        conn.models.find((m) => m.isAvailable) ??
        conn.models[0];
      if (model) {
        const key = await resolveConnectionKey(conn);
        return {
          provider: conn.provider.toLowerCase(),
          model: model.modelId,
          baseUrl: conn.baseUrl,
          apiKey: key || fallback.apiKey,
        };
      }
    }
  }
  const pick = providers ? pickPrimaryConnection(providers) : null;
  if (pick) {
    const key = await resolveConnectionKey(pick.connection);
    return {
      provider: pick.connection.provider.toLowerCase(),
      model: pick.model.modelId,
      baseUrl: pick.connection.baseUrl,
      apiKey: key || fallback.apiKey,
    };
  }
  return fallback;
}

export const replyToChat = internalAction({
  args: {
    projectId: v.id("projects"),
    conversationId: v.optional(v.id("conversations")),
    preferredAgentIds: v.optional(v.array(v.id("agents"))),
    userMessageId: v.id("messages"),
  },
  handler: async (ctx, args) => {
    // Concurrency guard: check if this message was already answered
    const alreadyReplied = await ctx.runQuery(internal.chatContext.checkAlreadyReplied, {
      userMessageId: args.userMessageId,
    });
    if (alreadyReplied) return;

    const data = (await ctx.runQuery(internal.chatContext.getContext, {
      projectId: args.projectId,
      conversationId: args.conversationId,
      preferredAgentIds: args.preferredAgentIds,
    })) as {
      agents: Array<{
        _id: string;
        name: string;
        role: string;
        systemPrompt?: string;
      }>;
      projectName: string;
      history: { authorType: string; content: string }[];
      contextSummary?: string;
      llmProviders?: PoolConnectionPayload[];
    };

    const { agents, projectName, history, llmProviders } = data;
    const globalConfig = await resolveConfigFromProviders(llmProviders, getGlobalLLMConfig());

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

    // Only an agent whose ROLE is cto/lead/orchestrator/planner may act as
    // the orchestrator (legacy "architect" accepted for backward compat).
    // Falling back to agents[0] made any selected agent
    // introduce itself as "the orchestrator/planner" while still naming its own
    // role (e.g. "frontend developer ... I'm the orchestrator/planner").
    const orchestrator =
      agents.find((a) => /cto|architect|lead|orchestrator|planner/i.test(a.role)) ?? null;
    // The dispatcher creates the task row. It may be the orchestrator, or the
    // first agent when the project has no CTO — but a non-orchestrator
    // never receives planning guidance.
    const dispatcher = orchestrator ?? agents[0];

    // Greeting fast-path: a bare "hi" must NOT reach the LLM with the
    // full conversation history — previous task commands in the history
    // (and the planner guidance) otherwise drag an old topic into a
    // full execution plan. Reply briefly without any planning.
    const lastContent = history[history.length - 1]?.content ?? "";
    if (GREETING.test(lastContent.trim())) {
      await ctx.runMutation(internal.chatContext.insertAgentMessage, {
        projectId: args.projectId,
        agentId: dispatcher._id as any,
        content: "Hi! Tell me what you'd like the team to work on.",
        replyToMessageId: args.userMessageId,
      });
      return;
    }

    let taskIntent = classifyChatIntent(history[history.length - 1]?.content ?? "");

    // Stage B: if regex says chat but the text is imperative/indirect
    // (e.g. "Migrate this project to React", "Saya mau…"), let the LLM
    // semantically upgrade to task. Invalid output stays chat (fail closed).
    const lastUserContent = history[history.length - 1]?.content ?? "";
    if (taskIntent.kind !== "task" && lastUserContent.length > 0) {
      try {
        const semantic = await classifySemantically(lastUserContent, globalConfig);
        if (semantic?.kind === "task") {
          taskIntent = { ...taskIntent, kind: "task" };
        }
      } catch {
        // fall through to chat
      }
    }

    // Auto-dispatch: a task intent creates the task row and skips the chat loop.
    if (taskIntent.kind === "task") {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { api } = await import("./_generated/api.js") as any;
        // create task (public mutation) — will be picked up by worker
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const taskId = await (ctx as any).runMutation(api.tasks.createFromCommand, {
          projectId: args.projectId,
          command: lastUserContent,
          title: lastUserContent.slice(0, 80),
        });
        await ctx.runMutation(internal.chatContext.insertAgentMessage, {
          projectId: args.projectId,
          agentId: dispatcher._id as any,
          taskId: taskId as any,
          conversationId: args.conversationId,
          content: `Task created. Open the task thread to follow execution.`,
          replyToMessageId: args.userMessageId,
        });
        return; // skip normal chat reply loop
      } catch (e: any) {
        console.error("Auto-dispatch failed:", e?.message ?? e);
        await ctx.runMutation(internal.chatContext.insertAgentMessage, {
          projectId: args.projectId,
          agentId: dispatcher._id as any,
          conversationId: args.conversationId,
          content: `I couldn't create the task (${e?.message ?? "unknown error"}). Please try again or create the task manually.`,
          replyToMessageId: args.userMessageId,
        });
        return; // do not pretend execution is running
      }
    }
    // Sequential multi-agent replies: each selected agent answers with its persona
    for (const agent of agents) {
      const multiNotice = agents.length > 1
        ? ` You are participating in a multi-agent discussion with: ${agents.map((a) => `${a.name} (${a.role})`).join(", ")}.`
        : "";
      const system = [
        `You are ${agent.name}, a ${agent.role} on the agent team of project "${projectName}".${multiNotice}`,
        agent.systemPrompt ?? "",
        ...buildPlanningGuidance(agent, {
          isOrchestrator: orchestrator !== null && agent._id === orchestrator._id,
          taskIntent,
        }),
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
        content = await completeWithAgent(system, conversation, perAgentConfig);
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
        await ctx.runMutation(internal.chatContext.insertAgentMessage, {
          projectId: args.projectId,
          agentId: agent._id as any,
          conversationId: args.conversationId,
          content: content.trim(),
          replyToMessageId: args.userMessageId,
        });
        // Append response to conversation so subsequent agents have context
        conversation.push({ role: "assistant", content: content.trim() });
      }
    }
  },
});
