"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  pickPrimaryConnection,
  resolveConnectionKey,
  type PoolConnectionPayload,
} from "./llmResolver";

function classifyChatIntent(text: string): { kind: string; frontend: boolean; backend: boolean; testing: boolean; security: boolean } {
  const t = text.toLowerCase();
  const frontend = /\b(frontend|ui|react|component|page|button|css|tailwind)\b/.test(t);
  const backend = /\b(backend|api|server|database|auth|endpoint|convex)\b/.test(t);
  const testing = /\b(test|qa|e2e|bug|error)\b/.test(t);
  const security = /\b(security|audit|vulnerab|secret)\b/.test(t);
  // If command contains impl keywords, treat as task regardless
  const impl = /\b(buatin|buat|tambah|implement|build|create|fix|perbaiki|refactor|update|change|add|remove|git\s+pull|checkout|push|audit|cari\s+bug|bug|review|investigate|research|qa|test|security|desain|design)\b/.test(t);
  return { kind: impl ? "task" : "chat", frontend, backend, testing, security };
}

function buildPlanningGuidance(agent: { role: string }, opts: { isOrchestrator: boolean; taskIntent: { kind: string; frontend: boolean; backend: boolean; testing: boolean; security: boolean } }): string[] {
  if (opts.isOrchestrator && opts.taskIntent.kind === "task") {
    return [
      "You are the orchestrator/planner (architect).",
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
      "Answer briefly. If user asks for work to be done, propose a plan + delegation, then tell them to use Create task. Do not pretend to have executed code. Respond in plain text.",
    ];
  }
  return [
    "Answer the user's chat message helpfully and briefly from your perspective in the same language as the user.",
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

  if (provider === "openai" || provider === "openai-compatible") {
    const base = baseUrl.replace(/\/$/, "");
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
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
      if (typeof c === "string" && c.trim()) return c;
      // Some reasoning models put text in reasoning_content
      const rc = data.choices?.[0]?.message?.reasoning_content;
      if (typeof rc === "string" && rc.trim()) return rc;
      return c ?? "";
    } catch {
      // SSE fallback: data: {...} lines
      const parts: string[] = [];
      for (const line of normalized.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const d: any = JSON.parse(payload);
          const delta = d.choices?.[0]?.delta?.content ?? d.choices?.[0]?.message?.content ?? "";
          if (delta) parts.push(delta);
        } catch {}
      }
      if (parts.length) return parts.join("");
      throw new Error(`LLM returned non-JSON response`);
    }
  }

  // anthropic
  const base = baseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/messages`, {
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
 * Resolve the chat LLM config from the shared provider pool (llmResolver):
 * the primary connection (lowest priority with an available model) and its
 * first available model. The key is decrypted here on the backend for the
 * backend's own call — a decryption failure is a hard error naming the
 * provider — with the connection's `apiKeyEnv` env var as fallback.
 */
async function resolveConfigFromProviders(
  providers: PoolConnectionPayload[] | undefined,
  fallback: { provider: string; model: string; baseUrl: string; apiKey: string }
): Promise<{ provider: string; model: string; baseUrl: string; apiKey: string }> {
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

    // Only an agent whose ROLE is architect/lead/orchestrator/planner may act as
    // the orchestrator. Falling back to agents[0] made any selected agent
    // introduce itself as "the orchestrator/planner" while still naming its own
    // role (e.g. "frontend developer ... I'm the orchestrator/planner").
    const orchestrator =
      agents.find((a) => /architect|lead|orchestrator|planner/i.test(a.role)) ?? null;
    // The dispatcher creates the task row. It may be the orchestrator, or the
    // first agent when the project has no architect — but a non-orchestrator
    // never receives planning guidance.
    const dispatcher = orchestrator ?? agents[0];
    const taskIntent = classifyChatIntent(history[history.length - 1]?.content ?? "");

    // Auto-dispatch: a task intent creates the task row and skips the chat loop.
    const lastUserContent = history[history.length - 1]?.content ?? "";
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
        const targetAgents = agents.filter((a: any) => a._id !== dispatcher._id).map((a: any) => a.name).join(", ");
        const delegationLine = targetAgents ? ` Other agents on this project: ${targetAgents}.` : "";
        await ctx.runMutation(internal.chatContext.insertAgentMessage, {
          projectId: args.projectId,
          agentId: dispatcher._id as any,
          taskId: taskId as any,
          conversationId: args.conversationId,
          content: `Task ${taskId} created for: "${lastUserContent.slice(0, 80)}".${delegationLine} Open the task thread to follow execution.`,
          replyToMessageId: args.userMessageId,
        });
        return; // skip normal chat reply loop
      } catch (e: any) {
        // fall back to chat reply if mutation fails (e.g. no auth in action)
        // continue to normal reply below
        console.error("Auto-dispatch failed:", e?.message ?? e);
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
        content = await completeWithAgent(system, conversation, globalConfig);
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
