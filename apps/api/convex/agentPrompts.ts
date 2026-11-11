/**
 * Role prompt templates on stored agents: reset one agent to its role
 * template (agent edit panel), and the deploy step that brings the fixed
 * team to the current templates.
 *
 *   npx convex run agentPrompts:applyRoleTemplates            # unedited seeds only
 *   npx convex run agentPrompts:applyRoleTemplates '{"force":true}'  # every fixed-role agent
 */
import { internalMutation, mutation } from "./_generated/server";
import { v } from "convex/values";
import { assertAgentAccess, assertRegistryWriteAccess } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { isRetiredRole } from "./lib/roles";
import { isUneditedSeed, roleTemplateFor } from "./lib/prompts/roleTemplate";
import { syncFixedTeam } from "./agents";

/** Overwrite one agent's instructions with its role's template. */
export const resetToRoleTemplate = mutation({
  args: { agentId: v.id("agents") },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const agent = await assertAgentAccess(ctx, args.agentId);
    const template = roleTemplateFor(agent.role);
    if (!template) throw new Error(`The role "${agent.role}" has no template`);
    if (agent.systemPrompt !== template) {
      await ctx.db.patch(agent._id, { systemPrompt: template });
      await recordAudit(ctx, {
        action: "agent.update",
        target: agent.name,
        details: { changed: ["systemPrompt"], reason: "reset to role template" },
      });
    }
    return { systemPrompt: template };
  },
});

/**
 * Deploy step for new role templates. Runs the fixed-team sync (an
 * unedited seed follows the new template), then reports which agents keep
 * customised instructions. `force` resets those too.
 */
export const applyRoleTemplates = internalMutation({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await syncFixedTeam(ctx);
    const reset: string[] = [];
    const customised: string[] = [];
    for (const agent of await ctx.db.query("agents").collect()) {
      if (isRetiredRole(agent.role)) continue;
      const template = roleTemplateFor(agent.role);
      if (!template || agent.systemPrompt === template) continue;
      if (!args.force && !isUneditedSeed(agent.role, agent.systemPrompt)) {
        customised.push(agent.name);
        continue;
      }
      await ctx.db.patch(agent._id, { systemPrompt: template });
      await recordAudit(ctx, {
        action: "agent.sync",
        actor: "system",
        target: agent.name,
        details: { changed: ["systemPrompt"], reason: args.force ? "role template (forced)" : "role template" },
      });
      reset.push(agent.name);
    }
    return { reset, customised };
  },
});
