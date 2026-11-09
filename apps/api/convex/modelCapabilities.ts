import { v } from "convex/values";
import { action, internalMutation, mutation, query, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess, assertRegistryWriteAccess, assertServiceToken } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { capabilityPatchFields, capabilityProbeValidator } from "./lib/capabilityValidators";
import {
  CAPABILITY_FIELDS,
  resolveModelCapabilities,
  sanitizeCapabilityPatch,
  type CapabilityOverrideRow,
  type CapabilityProbeResult,
} from "./lib/modelCapabilities";
import {
  PROBE_TIMEOUT_MS,
  evaluateJsonProbe,
  evaluateToolProbe,
  jsonProbeRequest,
  probeFlavor,
  rejectedToolsParam,
  toolProbeRequest,
} from "./lib/capabilityProbe";
import { resolveConnectionKey, type PoolConnectionPayload } from "./lib/llmResolver";

/**
 * Model Capability Registry (plan 027): override rows (global or per
 * project) and the manual capability probe. The resolution itself is pure
 * (lib/modelCapabilities.ts) and shared with the worker, which receives the
 * rows in its run context. Overrides hold no secrets, so they are ordinary
 * authorized mutations; the probe decrypts a provider key, so it is
 * token-gated and reached only through the server route
 * (apps/web/app/api/llm-providers, op "probeModel"). Nothing here runs
 * automatically.
 */

const OVERRIDE_LIMIT = 500;

function toRow(doc: Doc<"modelCapabilityOverrides">): CapabilityOverrideRow {
  const { _id, _creationTime, updatedAt, projectId, probe, ...fields } = doc;
  return { ...sanitizeCapabilityPatch(fields), modelId: doc.modelId, projectId: projectId ?? null, probe: probe ?? null };
}

/** Global rows plus one project's rows (worker run context, settings view). */
export async function loadCapabilityOverrides(
  ctx: QueryCtx,
  projectId: Id<"projects"> | null | undefined
): Promise<CapabilityOverrideRow[]> {
  const global = await ctx.db
    .query("modelCapabilityOverrides")
    .withIndex("by_project", (q) => q.eq("projectId", undefined))
    .take(OVERRIDE_LIMIT);
  const project = projectId
    ? await ctx.db
        .query("modelCapabilityOverrides")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .take(OVERRIDE_LIMIT)
    : [];
  return [...global, ...project].map(toRow);
}

async function findRow(ctx: QueryCtx, modelId: string, projectId: Id<"projects"> | undefined) {
  return await ctx.db
    .query("modelCapabilityOverrides")
    .withIndex("by_model_and_project", (q) => q.eq("modelId", modelId).eq("projectId", projectId))
    .first();
}

/**
 * Every registered model with its resolved capabilities, the source of
 * each field, the global and project override rows, and the last probe.
 */
export const list = query({
  args: { projectId: v.optional(v.id("projects")) },
  handler: async (ctx, args) => {
    if (args.projectId) await assertProjectAccess(ctx, args.projectId);
    const overrides = await loadCapabilityOverrides(ctx, args.projectId);
    const providers = new Map((await ctx.db.query("llmProviders").take(200)).map((p) => [p._id as string, p]));
    const models = await ctx.db.query("llmModels").take(1000);
    const seen = new Set<string>();
    const rows = [];
    for (const m of models) {
      const provider = providers.get(m.providerId as string);
      const resolved = resolveModelCapabilities(m.modelId, {
        overrides,
        projectId: args.projectId ?? null,
        registry: m,
      });
      seen.add(m.modelId);
      rows.push({
        key: `${m.providerId}::${m.modelId}`,
        providerId: m.providerId,
        connectionName: provider?.name ?? "(removed connection)",
        displayName: m.displayName ?? null,
        isAvailable: m.isAvailable,
        ...resolved,
        global: overrides.find((o) => o.modelId === m.modelId && !o.projectId) ?? null,
        project: args.projectId ? overrides.find((o) => o.modelId === m.modelId && o.projectId === args.projectId) ?? null : null,
      });
    }
    // Override rows for models no longer registered stay visible so they
    // can be cleared.
    const orphans = [...new Set(overrides.filter((o) => !seen.has(o.modelId)).map((o) => o.modelId))];
    return { models: rows.sort((a, b) => a.modelId.localeCompare(b.modelId)), orphans };
  },
});

const fieldNames = v.array(
  v.union(...CAPABILITY_FIELDS.map((field) => v.literal(field)))
);

/**
 * Upsert an override: set the given fields, clear the fields in `clear`
 * (back to the next layer). A row with no fields and no probe is deleted.
 */
export const setOverride = mutation({
  args: {
    modelId: v.string(),
    projectId: v.optional(v.id("projects")),
    ...capabilityPatchFields,
    clear: v.optional(fieldNames),
  },
  handler: async (ctx, args) => {
    const modelId = args.modelId.trim();
    if (!modelId) throw new Error("Model id is required");
    const project = args.projectId ? await assertProjectAccess(ctx, args.projectId) : null;
    if (!project) await assertRegistryWriteAccess(ctx);
    const { modelId: _m, projectId, clear, ...raw } = args;
    const patch = sanitizeCapabilityPatch(raw);
    if (raw.maxContextTokens !== undefined && patch.maxContextTokens === undefined) {
      throw new Error("Max context tokens must be a positive number");
    }
    const existing = await findRow(ctx, modelId, projectId);
    const next: Record<string, unknown> = {};
    for (const field of CAPABILITY_FIELDS) {
      const kept = existing ? (existing as Record<string, unknown>)[field] : undefined;
      if (clear?.includes(field)) next[field] = undefined;
      else if ((patch as Record<string, unknown>)[field] !== undefined) next[field] = (patch as Record<string, unknown>)[field];
      else next[field] = kept;
    }
    const empty = CAPABILITY_FIELDS.every((field) => next[field] === undefined) && !existing?.probe;
    if (existing && empty) {
      await ctx.db.delete(existing._id);
    } else if (existing) {
      await ctx.db.patch(existing._id, { ...next, updatedAt: Date.now() });
    } else if (!empty) {
      await ctx.db.insert("modelCapabilityOverrides", {
        modelId,
        ...(projectId ? { projectId } : {}),
        ...(Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) as object),
        updatedAt: Date.now(),
      });
    }
    await recordAudit(ctx, {
      action: "modelCapability.override",
      target: modelId,
      ...(projectId ? { projectId } : {}),
      details: { scope: projectId ? "project" : "global", set: Object.keys(patch), cleared: clear ?? [] },
    });
    return null;
  },
});

export const recordProbe = internalMutation({
  args: { modelId: v.string(), projectId: v.optional(v.id("projects")), probe: capabilityProbeValidator },
  handler: async (ctx, args) => {
    const existing = await findRow(ctx, args.modelId, args.projectId);
    if (existing) await ctx.db.patch(existing._id, { probe: args.probe, updatedAt: Date.now() });
    else
      await ctx.db.insert("modelCapabilityOverrides", {
        modelId: args.modelId,
        ...(args.projectId ? { projectId: args.projectId } : {}),
        probe: args.probe,
        updatedAt: Date.now(),
      });
    return null;
  },
});

async function post(
  baseUrl: string,
  path: string,
  flavor: "openai" | "anthropic",
  apiKey: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; status: number; text: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (flavor === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

/**
 * Manual capability probe: one tiny JSON-mode call and one tool-call test
 * against a configured connection, stored with a timestamp on the model's
 * override row (global unless projectId is given). Never run automatically;
 * costs two small completions. Errors are recorded, never thrown past the
 * verdicts, so a flaky endpoint leaves "no verdict" instead of a false.
 */
export const probe = action({
  args: {
    token: v.string(),
    providerId: v.id("llmProviders"),
    modelId: v.string(),
    projectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, args): Promise<CapabilityProbeResult> => {
    assertServiceToken(args.token);
    const pool: PoolConnectionPayload[] = await ctx.runQuery(internal.llmProviders.getForProject, {});
    const connection = pool.find((p) => p._id === args.providerId);
    if (!connection) throw new Error("Connection not found or disabled");
    const apiKey = await resolveConnectionKey(connection);
    if (!apiKey) throw new Error(`No API key for connection "${connection.name}"`);
    const flavor = probeFlavor(connection.provider);
    const result: CapabilityProbeResult = { at: Date.now(), connectionName: connection.name };
    const errors: string[] = [];

    try {
      const req = jsonProbeRequest(flavor, args.modelId);
      const res = await post(connection.baseUrl, req.path, flavor, apiKey, req.body);
      if (res.ok) result.structuredOutput = evaluateJsonProbe(res.text);
      else errors.push(`JSON call: HTTP ${res.status}`);
    } catch (error) {
      errors.push(`JSON call: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const req = toolProbeRequest(flavor, args.modelId);
      const res = await post(connection.baseUrl, req.path, flavor, apiKey, req.body);
      if (res.ok) result.toolCalling = evaluateToolProbe(res.text);
      else if (rejectedToolsParam(res.status)) {
        result.toolCalling = "none";
        errors.push(`Tool call: HTTP ${res.status} (tools parameter refused)`);
      } else errors.push(`Tool call: HTTP ${res.status}`);
    } catch (error) {
      errors.push(`Tool call: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (errors.length > 0) result.errors = errors.map((e) => e.slice(0, 200));
    await ctx.runMutation(internal.modelCapabilities.recordProbe, {
      modelId: args.modelId,
      ...(args.projectId ? { projectId: args.projectId } : {}),
      probe: result,
    });
    return result;
  },
});
