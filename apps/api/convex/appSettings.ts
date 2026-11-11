/**
 * App-wide settings (Settings modal). One row, upserted.
 *
 * See lib/appSettings.ts for the knob registry and how each side reads an
 * override. Writes are config changes: each records an audit row with the
 * field names only (values can be paths or env values).
 */
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { DataModel, Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { assertRegistryWriteAccess } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { permissionModeValidator } from "./lib/permissionModes";
import { planReviewSetting } from "./schema";
import { normalizeMainBranch } from "./lib/taskBranch";
import {
  isSettingKey,
  normalizeChildEnv,
  normalizeSettingValue,
  SETTING_KNOBS,
  type SettingKey,
} from "./lib/appSettings";
import { AUTOMATION_HELD_CODE, loadAutomationHold } from "./lib/automationHold";
import { effectiveTimeZone, normalizeTimeZone } from "./lib/timeContext";
import { internal } from "./_generated/api";

type Ctx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>;

async function loadRow(ctx: Ctx): Promise<Doc<"appSettings"> | null> {
  return await ctx.db.query("appSettings").first();
}

/** Stored knob overrides as a map (empty when the row was never written). */
export async function loadSettingValues(ctx: Ctx): Promise<Record<string, string>> {
  const row = await loadRow(ctx);
  const out: Record<string, string> = {};
  for (const entry of row?.values ?? []) {
    if (isSettingKey(entry.key) && entry.value !== "") out[entry.key] = entry.value;
  }
  return out;
}

/** The new-project defaults projects.create applies when a field is omitted. */
export async function loadNewProjectDefaults(ctx: Ctx) {
  const row = await loadRow(ctx);
  return {
    mainBranch: row?.defaultBaseBranch,
    approvalMode: row?.newProjectApprovalMode,
    defaultPermissionMode: row?.newProjectPermissionMode,
    planReview: row?.newProjectPlanReview,
    prFeedbackReactions: row?.newProjectPrFeedback,
    shadowAgentDefault: row?.newProjectShadowAgent,
    autoMerge: row?.newProjectAutoMerge,
    issueIntake: row?.newProjectIssueIntake,
  };
}

async function upsert(ctx: GenericMutationCtx<DataModel>, patch: Partial<Doc<"appSettings">>) {
  const row = await loadRow(ctx);
  const updatedAt = Date.now();
  if (row) await ctx.db.patch(row._id, { ...patch, updatedAt });
  else await ctx.db.insert("appSettings", { ...patch, updatedAt });
}

/** Everything the Settings modal shows. */
export const get = query({
  args: {},
  handler: async (ctx) => {
    await assertRegistryWriteAccess(ctx);
    const row = await loadRow(ctx);
    const values = await loadSettingValues(ctx);
    // Worker knobs: the freshest worker's reported env (its .env), since
    // Convex can only see its own env.
    const workers = await ctx.db.query("workers").take(50);
    const freshest = workers
      .filter((w) => w.knobEnv !== undefined)
      .sort((a, b) => b.lastHeartbeatAt - a.lastHeartbeatAt)[0];
    const workerEnv = new Map((freshest?.knobEnv ?? []).map((e) => [e.key, e.value]));
    const knobs = Object.fromEntries(
      (Object.keys(SETTING_KNOBS) as SettingKey[]).map((key) => {
        const knob = SETTING_KNOBS[key];
        const env = knob.reader === "worker" ? workerEnv.get(key) : process.env[key];
        return [key, { override: values[key] ?? null, env: env ?? null, defaultValue: knob.defaultValue }];
      })
    ) as Record<SettingKey, { override: string | null; env: string | null; defaultValue: string }>;
    return {
      knobs,
      childEnv: row?.childEnv ?? [],
      defaultBaseBranch: row?.defaultBaseBranch ?? "",
      newProject: {
        approvalMode: row?.newProjectApprovalMode ?? null,
        defaultPermissionMode: row?.newProjectPermissionMode ?? null,
        planReview: row?.newProjectPlanReview ?? null,
        prFeedbackReactions: row?.newProjectPrFeedback ?? false,
        shadowAgentDefault: row?.newProjectShadowAgent ?? false,
        autoMerge: row?.newProjectAutoMerge ?? false,
        issueIntake: row?.newProjectIssueIntake ?? false,
      },
      automationHold: row?.automationHold ?? null,
      userTimeZone: effectiveTimeZone(row?.userTimeZone),
      updatedAt: row?.updatedAt ?? null,
    };
  },
});

/** The global automation hold (G3), for the status line and Settings. Signed out: null, never a throw. */
export const automationHold = query({
  args: {},
  handler: async (ctx) => {
    try {
      await assertRegistryWriteAccess(ctx);
    } catch {
      return null;
    }
    return await loadAutomationHold(ctx);
  },
});

/**
 * G10: the worst host pressure an online worker reports on its heartbeat
 * ("pressure:<level>:<resources>" capability), for the status line.
 * Signed out or all ok: null.
 */
export const hostPressure = query({
  args: {},
  handler: async (ctx) => {
    try {
      await assertRegistryWriteAccess(ctx);
    } catch {
      return null;
    }
    const online = await ctx.db
      .query("workers")
      .withIndex("by_status_and_heartbeat", (q) => q.eq("status", "online"))
      .take(50);
    let worst: { level: "warn" | "critical"; resources: string[]; hostname: string | null } | null = null;
    for (const w of online) {
      const m = (w.capabilities ?? []).map((c) => /^pressure:(warn|critical):([a-z,]*)$/.exec(c)).find(Boolean);
      if (!m) continue;
      const level = m[1] as "warn" | "critical";
      if (worst && (worst.level === "critical" || level === "warn")) continue;
      worst = { level, resources: m[2].split(",").filter(Boolean), hostname: w.hostname ?? null };
    }
    return worst;
  },
});

/**
 * Hold or resume automation (Settings → Scheduled tasks). Resuming
 * re-evaluates the PRs auto-merge parked as "held", so they continue
 * without waiting for the next GitHub signal.
 */
export const setAutomationHold = mutation({
  args: { held: v.boolean(), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const current = await loadAutomationHold(ctx);
    if (args.held === (current !== null)) return { held: args.held, resumed: 0 };
    const reason = args.reason?.trim().slice(0, 200) || undefined;
    await upsert(ctx, { automationHold: args.held ? { heldAt: Date.now(), ...(reason ? { reason } : {}) } : undefined });
    let resumed = 0;
    if (!args.held) {
      const owners = new Set<Id<"tasks">>();
      for (const row of await ctx.db.query("taskPushes").order("desc").take(300)) {
        if (row.autoMerge?.code === AUTOMATION_HELD_CODE) owners.add(row.ownerTaskId ?? row.taskId);
      }
      for (const ownerTaskId of owners) await ctx.scheduler.runAfter(0, internal.autoMerge.evaluate, { ownerTaskId });
      resumed = owners.size;
    }
    await recordAudit(ctx, {
      action: args.held ? "automation.hold" : "automation.resume",
      target: "automation",
      details: { changed: ["automationHold"], ...(args.held ? {} : { resumedPrs: resumed }) },
    });
    return { held: args.held, resumed };
  },
});

/** Set (or clear, with an empty value) one knob override. */
export const setValue = mutation({
  args: { key: v.string(), value: v.string() },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const value = normalizeSettingValue(args.key, args.value);
    const row = await loadRow(ctx);
    const rest = (row?.values ?? []).filter((entry) => entry.key !== args.key);
    await upsert(ctx, { values: value === "" ? rest : [...rest, { key: args.key, value }] });
    await recordAudit(ctx, { action: "settings.update", target: args.key, details: { changed: [args.key] } });
    return value;
  },
});

/** Replace the Environments list (KEY=VALUE pairs for spawned processes). */
export const setChildEnv = mutation({
  args: { entries: v.array(v.object({ name: v.string(), value: v.string() })) },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const entries = normalizeChildEnv(args.entries);
    await upsert(ctx, { childEnv: entries });
    await recordAudit(ctx, {
      action: "settings.update",
      target: "environment",
      details: { changed: ["childEnv"], names: entries.map((e) => e.name) },
    });
    return entries;
  },
});

/** Defaults projects.create applies when the field is not given. */
export const setNewProjectDefaults = mutation({
  args: {
    defaultBaseBranch: v.optional(v.string()),
    approvalMode: v.optional(v.union(v.literal("ask"), v.literal("auto"), v.null())),
    defaultPermissionMode: v.optional(v.union(permissionModeValidator, v.null())),
    planReview: v.optional(v.union(planReviewSetting, v.null())),
    prFeedbackReactions: v.optional(v.boolean()),
    shadowAgentDefault: v.optional(v.boolean()),
    autoMerge: v.optional(v.boolean()),
    issueIntake: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const patch: Partial<Doc<"appSettings">> = {};
    const changed: string[] = [];
    if (args.defaultBaseBranch !== undefined) {
      patch.defaultBaseBranch = normalizeMainBranch(args.defaultBaseBranch) ?? undefined;
      changed.push("defaultBaseBranch");
    }
    if (args.approvalMode !== undefined) {
      patch.newProjectApprovalMode = args.approvalMode ?? undefined;
      changed.push("approvalMode");
    }
    if (args.defaultPermissionMode !== undefined) {
      patch.newProjectPermissionMode = args.defaultPermissionMode ?? undefined;
      changed.push("defaultPermissionMode");
    }
    if (args.planReview !== undefined) {
      patch.newProjectPlanReview = args.planReview ?? undefined;
      changed.push("planReview");
    }
    if (args.prFeedbackReactions !== undefined) {
      patch.newProjectPrFeedback = args.prFeedbackReactions || undefined;
      changed.push("prFeedbackReactions");
    }
    if (args.shadowAgentDefault !== undefined) {
      patch.newProjectShadowAgent = args.shadowAgentDefault || undefined;
      changed.push("shadowAgentDefault");
    }
    if (args.autoMerge !== undefined) {
      patch.newProjectAutoMerge = args.autoMerge || undefined;
      changed.push("autoMerge");
    }
    if (args.issueIntake !== undefined) {
      patch.newProjectIssueIntake = args.issueIntake || undefined;
      changed.push("issueIntake");
    }
    if (changed.length === 0) return;
    await upsert(ctx, patch);
    await recordAudit(ctx, { action: "settings.update", target: "new project defaults", details: { changed } });
  },
});

/** D4: the zone of the agents' time line (Settings → General). Empty resets to Asia/Jakarta. */
export const setUserTimeZone = mutation({
  args: { timeZone: v.string() },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const trimmed = args.timeZone.trim();
    const zone = trimmed === "" ? undefined : normalizeTimeZone(trimmed);
    if (zone === null) throw new Error(`Unknown time zone: ${trimmed.slice(0, 64)}`);
    await upsert(ctx, { userTimeZone: zone });
    await recordAudit(ctx, { action: "settings.update", target: "time zone", details: { changed: ["userTimeZone"] } });
    return effectiveTimeZone(zone);
  },
});

/** D4: the zone chat replies stamp their time line with. */
export const userTimeZone = internalQuery({
  args: {},
  handler: async (ctx) => effectiveTimeZone((await loadRow(ctx))?.userTimeZone),
});

/** What the worker applies: knob overrides + the child env. */
export const forWorker = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await loadRow(ctx);
    const values = await loadSettingValues(ctx);
    const childEnv: Record<string, string> = {};
    for (const entry of row?.childEnv ?? []) childEnv[entry.name] = entry.value;
    return { values, childEnv, updatedAt: row?.updatedAt ?? 0, userTimeZone: effectiveTimeZone(row?.userTimeZone) };
  },
});

/** The worker reports its own env for worker-read knobs (at start). */
export const reportKnobEnv = internalMutation({
  args: { workerId: v.string(), values: v.array(v.object({ key: v.string(), value: v.string() })) },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("workers")
      .withIndex("by_worker_id", (q) => q.eq("workerId", args.workerId))
      .unique();
    if (!row) return;
    const values = args.values
      .filter((e) => isSettingKey(e.key) && SETTING_KNOBS[e.key as SettingKey].reader !== "api")
      .map((e) => ({ key: e.key, value: e.value.slice(0, 500) }));
    await ctx.db.patch(row._id, { knobEnv: values });
  },
});

/** Worker processes seen by the backend (Devices / Maintenance). */
export const workers = query({
  args: {},
  handler: async (ctx) => {
    await assertRegistryWriteAccess(ctx);
    const rows = await ctx.db.query("workers").take(50);
    return rows
      .map((w) => ({
        _id: w._id,
        workerId: w.workerId,
        hostname: w.hostname ?? null,
        status: w.status,
        capacity: w.capacity,
        activeTasks: w.activeTasks,
        lastHeartbeatAt: w.lastHeartbeatAt,
        capabilities: w.capabilities ?? [],
      }))
      .sort((a, b) => b.lastHeartbeatAt - a.lastHeartbeatAt);
  },
});

/** Remove offline worker rows (Devices → Forget offline devices). */
export const forgetOfflineWorkers = mutation({
  args: {},
  handler: async (ctx) => {
    await assertRegistryWriteAccess(ctx);
    const rows = await ctx.db
      .query("workers")
      .withIndex("by_status_and_heartbeat", (q) => q.eq("status", "offline"))
      .take(100);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length > 0) {
      await recordAudit(ctx, { action: "settings.forget_devices", target: "workers", details: { removed: rows.length } });
    }
    return rows.length;
  },
});
