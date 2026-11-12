/**
 * Self-Improvement Lab: "Suggest fix" on a failed run (an incident or a
 * failed task). One LLM call reads the run's events and outputs and
 * proposes a concrete change to one prompt, skill or role config, stored
 * as a diff against the current text. The user applies it (audited) or
 * dismisses it; nothing is ever applied automatically.
 *
 * The LLM call itself (runSuggestion) lives in improveNode.ts ("use node"):
 * from the default runtime a plain http://<ip>:<port> gateway answered 404.
 */
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { assertAgentAccess, assertProjectAccess, assertRegistryWriteAccess, assertTaskAccess, visibleProjectIds } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { loadProviderPool } from "./lib/llmResolver";
import { eventText } from "./lib/incidents";
import {
  SUGGESTION_EVENTS,
  SUGGESTION_MAX_CANDIDATES,
  type SuggestionCandidate,
  type SuggestionTargetKind,
} from "./lib/improve/suggest";
import { reviewerIdentity } from "./reviewer";

const targetKind = v.union(v.literal("agent_prompt"), v.literal("skill"), v.literal("role_prompt"));

// ─── Request / read ────────────────────────────────────────────────────────

export const requestSuggestion = mutation({
  args: { incidentId: v.optional(v.id("incidents")), taskId: v.optional(v.id("tasks")) },
  handler: async (ctx, args) => {
    let incident: Doc<"incidents"> | null = null;
    let taskId = args.taskId;
    if (args.incidentId) {
      incident = await ctx.db.get(args.incidentId);
      if (!incident) throw new Error("Incident not found");
      taskId = incident.taskId;
    }
    if (!taskId) throw new Error("Pick an incident or a failed task");
    const task = await assertTaskAccess(ctx, taskId);
    if (!incident && task.status !== "failed" && task.status !== "rejected") {
      throw new Error("Suggest fix works on a failed run");
    }
    const existing = await ctx.db
      .query("improvementSuggestions")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .collect();
    const running = existing.find((row) => row.status === "running" && (row.incidentId ?? null) === (incident?._id ?? null));
    if (running) return running._id;
    const suggestionId = await ctx.db.insert("improvementSuggestions", {
      projectId: task.projectId,
      taskId: task._id,
      ...(incident ? { incidentId: incident._id } : {}),
      status: "running",
      createdAt: Date.now(),
    });
    await recordAudit(ctx, {
      tool: "improve",
      action: "improve.suggest",
      target: task.title,
      projectId: task.projectId,
      taskId: task._id,
      details: { suggestionId, ...(incident ? { incidentId: incident._id } : {}) },
    });
    // The LLM call runs in the Node runtime (improveNode.ts).
    await ctx.scheduler.runAfter(0, internal.improveNode.runSuggestion, { suggestionId });
    return suggestionId;
  },
});

function projectSuggestion(row: Doc<"improvementSuggestions">, taskTitle: string | null) {
  return {
    _id: row._id,
    projectId: row.projectId,
    taskId: row.taskId,
    taskTitle,
    incidentId: row.incidentId ?? null,
    status: row.status,
    targetKind: row.targetKind ?? null,
    targetId: row.targetId ?? null,
    targetLabel: row.targetLabel ?? null,
    diff: row.diff ?? null,
    rationale: row.rationale ?? null,
    error: row.error ?? null,
    tokens: (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
    createdAt: row.createdAt,
    decidedAt: row.decidedAt ?? null,
  };
}

export const listSuggestions = query({
  args: { incidentId: v.optional(v.id("incidents")), projectId: v.optional(v.id("projects")) },
  handler: async (ctx, args) => {
    let rows: Doc<"improvementSuggestions">[];
    if (args.incidentId) {
      const incident = await ctx.db.get(args.incidentId);
      if (!incident) return [];
      await assertProjectAccess(ctx, incident.projectId);
      rows = await ctx.db
        .query("improvementSuggestions")
        .withIndex("by_incident", (q) => q.eq("incidentId", args.incidentId))
        .collect();
    } else {
      const visible = args.projectId ? new Set([String((await assertProjectAccess(ctx, args.projectId))._id)]) : await visibleProjectIds(ctx);
      rows = (await ctx.db.query("improvementSuggestions").order("desc").take(200)).filter((row) => visible.has(row.projectId));
    }
    rows.sort((a, b) => b.createdAt - a.createdAt);
    const titles = new Map<string, string | null>();
    for (const row of rows) if (!titles.has(row.taskId)) titles.set(row.taskId, (await ctx.db.get(row.taskId))?.title ?? null);
    return rows.map((row) => projectSuggestion(row, titles.get(row.taskId) ?? null));
  },
});

/** Failed runs without an incident record yet (older runs), for /improve. */
export const listFailedRuns = query({
  args: { projectId: v.optional(v.id("projects")) },
  handler: async (ctx, args) => {
    const visible = args.projectId ? new Set([String((await assertProjectAccess(ctx, args.projectId))._id)]) : await visibleProjectIds(ctx);
    const failed = await ctx.db
      .query("tasks")
      .withIndex("by_status_and_updated", (q) => q.eq("status", "failed"))
      .order("desc")
      .take(50);
    return failed
      .filter((task) => visible.has(task.projectId) && task.status !== "cancelled" && task.errorMessage !== "Cancelled by user")
      .slice(0, 20)
      .map((task) => ({
        _id: task._id,
        projectId: task.projectId,
        title: task.title,
        error: task.errorMessage ?? null,
        completedAt: task.completedAt ?? task.updatedAt ?? task._creationTime,
      }));
  },
});

// ─── Apply / dismiss ───────────────────────────────────────────────────────

async function currentTargetText(
  ctx: QueryCtx | MutationCtx,
  kind: SuggestionTargetKind,
  id: string
): Promise<{ text: string; label: string } | null> {
  if (kind === "agent_prompt") {
    const agent = await ctx.db.get(id as Id<"agents">);
    return agent ? { text: agent.systemPrompt ?? "", label: `${agent.role} prompt` } : null;
  }
  if (kind === "skill") {
    const skill = await ctx.db.get(id as Id<"skills">);
    return skill ? { text: skill.instructions, label: `Skill: ${skill.name}` } : null;
  }
  const role = await ctx.db.get(id as Id<"roleDefinitions">);
  return role ? { text: role.systemPrompt ?? "", label: `Role: ${role.name}` } : null;
}

/**
 * Apply a ready suggestion: writes the proposed text to its target with the
 * same access checks and audit shape as the agent / skill / role editors,
 * refusing when the target changed since the suggestion was made.
 */
export const applySuggestion = mutation({
  args: { suggestionId: v.id("improvementSuggestions") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.suggestionId);
    if (!row) throw new Error("Suggestion not found");
    await assertProjectAccess(ctx, row.projectId);
    if (row.status !== "ready" || !row.targetKind || !row.targetId || row.proposedText === undefined) {
      throw new Error(`This suggestion is ${row.status}`);
    }
    const current = await currentTargetText(ctx, row.targetKind, row.targetId);
    if (!current) throw new Error("The target no longer exists");
    if (current.text !== (row.baseText ?? "")) {
      throw new Error("The text changed since this suggestion was made; ask for a new one");
    }
    const now = Date.now();
    const text = row.proposedText;
    if (row.targetKind === "agent_prompt") {
      const agent = await assertAgentAccess(ctx, row.targetId as Id<"agents">);
      await ctx.db.patch(agent._id, { systemPrompt: text.trim() || undefined });
      await recordAudit(ctx, {
        action: "agent.update",
        target: `${agent.name} (${agent.role})`,
        projectId: row.projectId,
        taskId: row.taskId,
        details: { changed: ["systemPrompt"], source: "improve", suggestionId: row._id },
      });
    } else if (row.targetKind === "skill") {
      await assertRegistryWriteAccess(ctx);
      const skill = await ctx.db.get(row.targetId as Id<"skills">);
      if (!skill) throw new Error("Skill not found");
      if (!text.trim()) throw new Error("A skill needs instructions");
      await ctx.db.patch(skill._id, { instructions: text, updatedAt: now });
      await recordAudit(ctx, {
        action: "skill.update",
        target: skill.name,
        projectId: row.projectId,
        taskId: row.taskId,
        details: { changed: ["instructions"], source: "improve", suggestionId: row._id },
      });
    } else {
      await assertRegistryWriteAccess(ctx);
      const role = await ctx.db.get(row.targetId as Id<"roleDefinitions">);
      if (!role) throw new Error("Role not found");
      await ctx.db.patch(role._id, { systemPrompt: text.trim() || undefined, updatedAt: now });
      await recordAudit(ctx, {
        action: "role.update",
        target: role.name,
        projectId: row.projectId,
        taskId: row.taskId,
        details: { changed: ["systemPrompt"], source: "improve", suggestionId: row._id },
      });
    }
    await ctx.db.patch(row._id, { status: "applied", decidedAt: now });
    await recordAudit(ctx, {
      tool: "improve",
      action: "improve.apply",
      target: row.targetLabel ?? row.targetKind,
      projectId: row.projectId,
      taskId: row.taskId,
      details: { suggestionId: row._id, targetKind: row.targetKind, ...(row.incidentId ? { incidentId: row.incidentId } : {}) },
    });
    return true;
  },
});

export const dismissSuggestion = mutation({
  args: { suggestionId: v.id("improvementSuggestions") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.suggestionId);
    if (!row) throw new Error("Suggestion not found");
    await assertProjectAccess(ctx, row.projectId);
    if (row.status === "applied" || row.status === "dismissed") return false;
    await ctx.db.patch(row._id, { status: "dismissed", decidedAt: Date.now() });
    await recordAudit(ctx, {
      tool: "improve",
      action: "improve.dismiss",
      target: row.targetLabel ?? row.targetKind ?? "suggestion",
      projectId: row.projectId,
      taskId: row.taskId,
      details: { suggestionId: row._id },
    });
    return true;
  },
});

// ─── Internal: the one LLM call ────────────────────────────────────────────

export const getSuggestionContext = internalQuery({
  args: { suggestionId: v.id("improvementSuggestions") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.suggestionId);
    if (!row || row.status !== "running") return null;
    const task = await ctx.db.get(row.taskId);
    if (!task) return null;
    const incident = row.incidentId ? await ctx.db.get(row.incidentId) : null;
    const subtasks = (await ctx.db.query("subtasks").withIndex("by_task", (q) => q.eq("taskId", task._id)).collect()).sort(
      (a, b) => a.order - b.order
    );
    const events = await ctx.db
      .query("taskEvents")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .order("desc")
      .take(SUGGESTION_EVENTS);
    // Candidates: the prompts, skills and roles of the agents that worked on this run.
    const agentIds = new Set<string>([...(task.assignedAgentIds ?? []), ...subtasks.flatMap((s) => (s.assignedAgentId ? [s.assignedAgentId] : []))]);
    const roleOf = new Map<string, string>();
    for (const s of subtasks) if (s.assignedAgentId) roleOf.set(s.assignedAgentId, s.assignedAgentName ?? "");
    const candidates: SuggestionCandidate[] = [];
    const seenSkills = new Set<string>();
    const roleKeys = new Set<string>();
    for (const id of agentIds) {
      const agent = await ctx.db.get(id as Id<"agents">);
      if (!agent) continue;
      candidates.push({ kind: "agent_prompt", id: agent._id, label: `${agent.role} prompt`, text: agent.systemPrompt ?? "" });
      roleKeys.add(agent.role.trim().toLowerCase());
      for (const skillId of agent.skillIds ?? []) {
        if (seenSkills.has(skillId)) continue;
        seenSkills.add(skillId);
        const skill = await ctx.db.get(skillId);
        if (skill) candidates.push({ kind: "skill", id: skill._id, label: `Skill: ${skill.name}`, text: skill.instructions });
      }
    }
    for (const key of roleKeys) {
      const role = await ctx.db
        .query("roleDefinitions")
        .withIndex("by_key", (q) => q.eq("key", key))
        .first();
      if (role) candidates.push({ kind: "role_prompt", id: role._id, label: `Role: ${role.name}`, text: role.systemPrompt ?? "" });
    }
    const identity = await reviewerIdentity(ctx, task.projectId);
    return {
      projectId: task.projectId,
      prefs: identity.prefs,
      providers: await loadProviderPool(ctx, { projectId: task.projectId }),
      run: {
        taskTitle: task.title,
        command: task.command,
        status: task.status,
        error: task.errorMessage,
        incident: incident
          ? {
              trigger: incident.trigger,
              error: incident.error,
              failurePoint: incident.failurePoint?.title ?? incident.failurePoint?.subtaskKey,
              escalation: incident.escalation ? `${incident.escalation.kind}: ${incident.escalation.reason}` : undefined,
            }
          : undefined,
        subtasks: subtasks.map((s) => ({
          key: s.key,
          title: s.title,
          role: s.assignedAgentName,
          status: s.status,
          output: s.output,
          error: s.error,
          acceptanceReason: s.acceptanceReason,
        })),
        events: events.reverse().map((e) => ({ type: e.type, level: e.level, subtaskKey: e.subtaskKey, text: eventText(e) })),
        // Context snapshots (context-snapshot package) are added here once that table exists.
        snapshots: [] as string[],
      },
      candidates: candidates.slice(0, SUGGESTION_MAX_CANDIDATES),
    };
  },
});

export const finishSuggestion = internalMutation({
  args: {
    suggestionId: v.id("improvementSuggestions"),
    status: v.union(v.literal("ready"), v.literal("no_change"), v.literal("error")),
    targetKind: v.optional(targetKind),
    targetId: v.optional(v.string()),
    targetLabel: v.optional(v.string()),
    baseText: v.optional(v.string()),
    proposedText: v.optional(v.string()),
    diff: v.optional(v.string()),
    rationale: v.optional(v.string()),
    error: v.optional(v.string()),
    model: v.optional(v.string()),
    inputTokens: v.number(),
    outputTokens: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.suggestionId);
    if (!row || row.status !== "running") return false;
    const { suggestionId, ...fields } = args;
    await ctx.db.patch(row._id, fields);
    if (args.inputTokens + args.outputTokens > 0) {
      await ctx.db.insert("tokenUsage", {
        projectId: row.projectId,
        taskId: row.taskId,
        agentName: "Self-Improvement Lab",
        model: args.model ?? "unknown",
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        estimated: true,
        createdAt: Date.now(),
      });
    }
    return true;
  },
});

