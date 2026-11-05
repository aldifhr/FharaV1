import { Agent, createThread } from "@convex-dev/agent";
import { convexGateway } from "@convex-dev/ai-sdk-provider";
import { action } from "./_generated/server";
import { components } from "./_generated/api";
import { v } from "convex/values";

const orchestrator = new Agent(components.agent, {
  name: "MOAgent Orchestrator",
  languageModel: convexGateway("openai/gpt-5-mini"),
  instructions:
    "You coordinate software agents. Return a concise JSON plan with ordered steps and the roles needed. Do not edit files or claim that work was executed.",
});

export const planTask = action({
  args: {
    taskId: v.id("tasks"),
    command: v.string(),
    roles: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const threadId = await createThread(ctx, components.agent, {
      userId: args.taskId,
    });
    const result = await orchestrator.generateText(
      ctx,
      { threadId },
      {
        prompt: `Task: ${args.command}\nAvailable roles: ${args.roles.join(", ")}\nReturn JSON only: {"steps":[{"role":"...","objective":"..."}]}`,
      }
    );
    return { threadId, plan: result.text };
  },
});
