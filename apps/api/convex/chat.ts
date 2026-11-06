"use node";

import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

/**
 * Team chat reply: pick the best agent for the project (prefer a
 * lead/orchestrator role, else the assigned agent chip, else the first
 * enabled agent) and ask it to answer in the conversation.
 */

async function completeWithAgent(
  agent: {
    llmProvider?: string;
    llmModel?: string;
    llmBaseUrl?: string;
    llmApiKey?: string;
  },
  system: string,
  history: { role: string; content: string }[],
): Promise<string> {
  const provider = (agent.llmProvider ?? "anthropic").toLowerCase();
  const model = agent.llmModel ?? (provider === "openai" ? "gpt-4o-mini" : "claude-sonnet-4-20250514");
  const apiKey = agent.llmApiKey ?? "";
  if (!apiKey) throw new Error("No LLM API key configured for this agent");

  const messages = history.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  if (provider === "openai") {
    const base = (agent.llmBaseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
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
    const data: any = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  }

  const base = (agent.llmBaseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
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

export const replyToChat = internalAction({
  args: {
    projectId: v.id("projects"),
    preferredAgentId: v.optional(v.id("agents")),
    userMessageId: v.id("messages"),
  },
  handler: async (ctx, args) => {
    const data = (await ctx.runQuery(internal.chatContext.getContext, {
      projectId: args.projectId,
      preferredAgentId: args.preferredAgentId,
    })) as {
      agent: {
        _id: string;
        name: string;
        role: string;
        systemPrompt?: string;
        llmProvider?: string;
        llmModel?: string;
        llmBaseUrl?: string;
        llmApiKey?: string;
      } | null;
      projectName: string;
      history: { authorType: string; content: string }[];
    };

    const agent = data.agent;
    const projectName = data.projectName;
    const history = data.history;

    if (!agent) {
      await ctx.runMutation(internal.chatContext.insertAgentMessage, {
        projectId: args.projectId,
        content: "No agent is configured for this project yet.",
      });
      return;
    }

    const system = [
      `You are ${agent.name}, a ${agent.role} on the agent team of project "${projectName}".`,
      agent.systemPrompt ?? "",
      "Answer the user's chat message helpfully and briefly in the same language as the user. If the user asks for work to be done, tell them to use the Create task button. Do not pretend to have executed code. Respond in plain text.",
    ]
      .filter(Boolean)
      .join("\n");

    const messages = history.map((m) => ({
      role: m.authorType === "agent" ? "assistant" : "user",
      content: m.content,
    }));

    let content: string;
    try {
      content = await completeWithAgent(agent, system, messages);
    } catch (err: any) {
      await ctx.runMutation(internal.chatContext.insertAgentMessage, {
        projectId: args.projectId,
        agentId: agent._id as any,
        content: `I couldn't reply (${err.message}). Check the agent's LLM settings.`,
      });
      return;
    }

    if (content.trim()) {
      await ctx.runMutation(internal.chatContext.insertAgentMessage, {
        projectId: args.projectId,
        agentId: agent._id as any,
        content: content.trim(),
      });
    }
  },
});

