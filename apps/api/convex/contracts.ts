import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { holdsTaskLease } from "./orchestration";
import { assertProjectAccess } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { openIncident } from "./lib/incidents";
import { MODEL_TIER_KEYS, normalizeModelTiers } from "./lib/modelTiers";
import {
  acceptanceStatusValidator,
  escalationValidator,
  gateResultValidator,
  modelTiersValidator,
} from "./lib/contractValidators";

/**
 * Plan 022: record a subtask's acceptance — separate from its execution
 * status. The acceptance stage writes gate results and accepted /
 * rejected / blocked; an executor escalation writes "escalated" with the
 * escalation (the row is also moved to `blocked`, it stopped for a
 * decision). Lease-fenced like every worker write.
 */
export const recordSubtaskAcceptance = internalMutation({
  args: {
    taskId: v.id("tasks"),
    key: v.string(),
    acceptanceStatus: acceptanceStatusValidator,
    acceptanceReason: v.optional(v.string()),
    gateResults: v.optional(v.array(gateResultValidator)),
    escalation: v.optional(escalationValidator),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) {
      return { applied: false as const, reason: "lease_lost" as const };
    }
    const subtask = await ctx.db
      .query("subtasks")
      .withIndex("by_task_and_key", (q) => q.eq("taskId", args.taskId).eq("key", args.key))
      .unique();
    if (!subtask) return { applied: false as const, reason: "unknown_subtask" as const };
    await ctx.db.patch(subtask._id, {
      acceptanceStatus: args.acceptanceStatus,
      acceptanceReason: args.acceptanceReason?.slice(0, 500),
      ...(args.gateResults !== undefined ? { gateResults: args.gateResults } : {}),
      ...(args.acceptanceStatus === "escalated"
        ? {
            escalation: args.escalation,
            ...(subtask.status === "completed" ? {} : { status: "blocked" as const, error: args.acceptanceReason?.slice(0, 500) }),
          }
        : {}),
    });
    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      projectId: subtask.projectId,
      type: `subtask.acceptance`,
      payload: {
        subtaskKey: args.key,
        status: args.acceptanceStatus,
        ...(args.acceptanceReason ? { reason: args.acceptanceReason.slice(0, 300) } : {}),
        ...(args.gateResults
          ? { gates: args.gateResults.map((gate) => ({ id: gate.gateId, status: gate.status })) }
          : {}),
      },
      subtaskKey: args.key,
      level: args.acceptanceStatus === "accepted" || args.acceptanceStatus === "delivered" ? "info" : "warn",
    });
    // Incident Room: an escalation or a blocked acceptance opens an incident.
    if (args.acceptanceStatus === "escalated" || args.acceptanceStatus === "blocked") {
      await openIncident(ctx, {
        taskId: args.taskId,
        trigger: args.acceptanceStatus === "escalated" ? "subtask_escalated" : "subtask_blocked",
        subtaskKey: args.key,
        error: args.acceptanceReason,
        escalation: args.escalation,
        stage: "acceptance",
      });
    }
    return { applied: true as const };
  },
});

// ─── Model tier per role (project setting) ─────────────────────────────────

/**
 * Plan 022: the project's model tiers and the configured models a tier
 * may point at (available registry rows, with their connection's name).
 */
export const getProjectModelTiers = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    const models = await ctx.db.query("llmModels").collect();
    const providers = new Map(
      (await ctx.db.query("llmProviders").collect()).map((provider) => [provider._id as string, provider])
    );
    return {
      tiers: normalizeModelTiers(project.modelTiers),
      options: models
        .filter((model) => model.isAvailable && providers.get(model.providerId as string)?.isEnabled !== false)
        .map((model) => ({
          _id: model._id,
          modelId: model.modelId,
          label: model.displayName ?? model.modelId,
          providerName: providers.get(model.providerId as string)?.name ?? "Provider",
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    };
  },
});

export const setProjectModelTiers = mutation({
  args: { projectId: v.id("projects"), modelTiers: modelTiersValidator },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    for (const key of MODEL_TIER_KEYS) {
      const id = args.modelTiers[key];
      if (id && !(await ctx.db.get(id))) throw new Error(`Unknown model for the ${key} tier`);
    }
    const next = Object.fromEntries(
      MODEL_TIER_KEYS.filter((key) => args.modelTiers[key]).map((key) => [key, args.modelTiers[key]])
    );
    await ctx.db.patch(args.projectId, { modelTiers: Object.keys(next).length > 0 ? next : undefined });
    await recordAudit(ctx, {
      action: "project.update",
      target: project.name,
      projectId: args.projectId,
      details: { changed: ["modelTiers"], modelTiers: next },
    });
    return normalizeModelTiers(next);
  },
});
