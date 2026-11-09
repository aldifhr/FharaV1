import { query, mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertAgentAccess, assertProjectAccess, assertRegistryWriteAccess } from "./lib/authz";
import { ROLES, isRoleKey } from "./lib/roles";
import { defaultAvatarParams } from "./lib/avatar";
import {
  BUILT_IN_TEMPLATES,
  builtInTemplateId,
  findBuiltInTemplate,
  matchSkillsByName,
  nextAgentName,
  validateTemplateInput,
} from "./lib/agentTemplates";
import { defaultSystemPromptForRole, normalizeOpencodeModel } from "./agents";
import { recordAudit, setFields } from "./lib/recordAudit";

/**
 * Agent templates: built-ins from code (lib/agentTemplates.ts, ids
 * `builtin:<key>`) plus custom rows in `agentTemplates`. Same authz model as
 * agents.ts / skills.ts — reads are open (local single-user mode), writes go
 * through assertRegistryWriteAccess, agent reads through assertAgentAccess.
 */

type Ctx = QueryCtx | MutationCtx;

export type TemplateView = {
  id: string;
  builtIn: boolean;
  name: string;
  role: string;
  description: string;
  systemPrompt: string;
  /** Library skills, in prompt order (built-ins: matched by name). */
  skillIds: Id<"skills">[];
  /** Built-ins only: the skill names it suggests, matched or not. */
  suggestedSkills: string[];
  llmProviderId?: Id<"llmProviders">;
  llmModelId?: Id<"llmModels">;
  runtime?: "api" | "opencode";
  opencodeModel?: string;
  avatarParams?: unknown;
  tags: string[];
  createdAt?: number;
  updatedAt?: number;
};

const runtimeArg = v.optional(v.union(v.literal("api"), v.literal("opencode"), v.null()));

async function librarySkills(ctx: Ctx) {
  return (await ctx.db.query("skills").collect()).map((s) => ({ _id: s._id as string, name: s.name }));
}

function customView(row: Doc<"agentTemplates">, existingSkills: Set<string>): TemplateView {
  return {
    id: row._id,
    builtIn: false,
    name: row.name,
    role: row.role,
    description: row.description,
    systemPrompt: row.systemPrompt,
    skillIds: (row.skillIds ?? []).filter((id) => existingSkills.has(id)),
    suggestedSkills: [],
    ...(row.llmProviderId ? { llmProviderId: row.llmProviderId } : {}),
    ...(row.llmModelId ? { llmModelId: row.llmModelId } : {}),
    ...(row.runtime ? { runtime: row.runtime } : {}),
    ...(row.opencodeModel ? { opencodeModel: row.opencodeModel } : {}),
    ...(row.avatarParams ? { avatarParams: row.avatarParams } : {}),
    tags: row.tags ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Built-ins (code order) then custom templates (by name). */
export async function listTemplates(ctx: Ctx): Promise<TemplateView[]> {
  const library = await librarySkills(ctx);
  const existing = new Set(library.map((s) => s._id));
  const builtIns: TemplateView[] = BUILT_IN_TEMPLATES.map((t) => ({
    id: builtInTemplateId(t.key),
    builtIn: true,
    name: t.name,
    role: t.role,
    description: t.description,
    systemPrompt: t.systemPrompt,
    skillIds: matchSkillsByName(t.suggestedSkills, library) as Id<"skills">[],
    suggestedSkills: [...t.suggestedSkills],
    ...(t.runtime ? { runtime: t.runtime } : {}),
    avatarParams: t.avatarParams,
    tags: [...t.tags],
  }));
  const rows = await ctx.db.query("agentTemplates").withIndex("by_name").collect();
  return [...builtIns, ...rows.map((row) => customView(row, existing))];
}

async function resolveTemplate(ctx: Ctx, templateId: string): Promise<TemplateView> {
  const builtIn = findBuiltInTemplate(templateId);
  if (builtIn) {
    const all = await listTemplates(ctx);
    return all.find((t) => t.id === templateId)!;
  }
  const id = ctx.db.normalizeId("agentTemplates", templateId);
  const row = id ? await ctx.db.get(id) : null;
  if (!row) throw new Error("Template not found");
  const existing = new Set((await librarySkills(ctx)).map((s) => s._id));
  return customView(row, existing);
}

async function assertUniqueName(ctx: Ctx, name: string, except?: Id<"agentTemplates">) {
  const lower = name.toLowerCase();
  if (BUILT_IN_TEMPLATES.some((t) => t.name.toLowerCase() === lower)) {
    throw new Error(`"${name}" is a built-in template name`);
  }
  const existing = await ctx.db
    .query("agentTemplates")
    .withIndex("by_name", (q) => q.eq("name", name))
    .first();
  if (existing && existing._id !== except) throw new Error(`A template named "${name}" already exists`);
}

/** "Frontend" → "Frontend", or "Frontend 2" when a template has it. */
async function freeTemplateName(ctx: Ctx, base: string): Promise<string> {
  const rows = await ctx.db.query("agentTemplates").collect();
  const taken = new Set([
    ...rows.map((r) => r.name.toLowerCase()),
    ...BUILT_IN_TEMPLATES.map((t) => t.name.toLowerCase()),
  ]);
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`.toLowerCase())) n += 1;
  return `${base} ${n}`;
}

async function cleanSkillIds(ctx: Ctx, ids: readonly Id<"skills">[] | undefined) {
  const unique = Array.from(new Set(ids ?? []));
  for (const id of unique) {
    if (!(await ctx.db.get(id))) throw new Error("Skill not found");
  }
  return unique;
}

async function assertLlm(ctx: Ctx, providerId?: Id<"llmProviders"> | null, modelId?: Id<"llmModels"> | null) {
  if (providerId && !(await ctx.db.get(providerId))) throw new Error("LLM provider not found");
  if (modelId && !(await ctx.db.get(modelId))) throw new Error("LLM model not found");
}

export const list = query({
  args: {},
  handler: async (ctx) => await listTemplates(ctx),
});

export const create = mutation({
  args: {
    name: v.string(),
    role: v.string(),
    description: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
    skillIds: v.optional(v.array(v.id("skills"))),
    llmProviderId: v.optional(v.id("llmProviders")),
    llmModelId: v.optional(v.id("llmModels")),
    runtime: v.optional(v.union(v.literal("api"), v.literal("opencode"))),
    opencodeModel: v.optional(v.string()),
    avatarParams: v.optional(v.any()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const clean = validateTemplateInput({
      name: args.name,
      role: args.role,
      description: args.description ?? "",
      systemPrompt: args.systemPrompt ?? "",
      tags: args.tags ?? [],
    });
    await assertUniqueName(ctx, clean.name!);
    await assertLlm(ctx, args.llmProviderId, args.llmModelId);
    const skillIds = await cleanSkillIds(ctx, args.skillIds);
    const opencodeModel = args.opencodeModel ? normalizeOpencodeModel(args.opencodeModel) : undefined;
    const now = Date.now();
    const templateId = await ctx.db.insert("agentTemplates", {
      name: clean.name!,
      role: clean.role!,
      description: clean.description ?? "",
      systemPrompt: clean.systemPrompt || defaultSystemPromptForRole(clean.role!),
      ...(skillIds.length ? { skillIds } : {}),
      ...(args.llmProviderId ? { llmProviderId: args.llmProviderId } : {}),
      ...(args.llmModelId ? { llmModelId: args.llmModelId } : {}),
      ...(args.runtime ? { runtime: args.runtime } : {}),
      ...(opencodeModel ? { opencodeModel } : {}),
      ...(args.avatarParams ? { avatarParams: args.avatarParams } : {}),
      ...(clean.tags?.length ? { tags: clean.tags } : {}),
      builtIn: false,
      createdAt: now,
      updatedAt: now,
    });
    await recordAudit(ctx, { action: "template.create", target: clean.name!, details: { fields: setFields(args) } });
    return templateId;
  },
});

export const update = mutation({
  args: {
    templateId: v.id("agentTemplates"),
    name: v.optional(v.string()),
    role: v.optional(v.string()),
    description: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
    skillIds: v.optional(v.array(v.id("skills"))),
    // An id sets it, null clears it, omit leaves it (agents.update contract).
    llmProviderId: v.optional(v.union(v.id("llmProviders"), v.null())),
    llmModelId: v.optional(v.union(v.id("llmModels"), v.null())),
    runtime: runtimeArg,
    opencodeModel: v.optional(v.union(v.string(), v.null())),
    avatarParams: v.optional(v.any()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const row = await ctx.db.get(args.templateId);
    if (!row) throw new Error("Template not found");
    const clean = validateTemplateInput({
      name: args.name,
      role: args.role,
      description: args.description,
      systemPrompt: args.systemPrompt,
      tags: args.tags,
    });
    if (clean.name !== undefined && clean.name !== row.name) await assertUniqueName(ctx, clean.name, row._id);
    await assertLlm(ctx, args.llmProviderId, args.llmModelId);
    const skillIds = args.skillIds !== undefined ? await cleanSkillIds(ctx, args.skillIds) : undefined;
    const role = clean.role ?? row.role;
    await ctx.db.patch(row._id, {
      ...(clean.name !== undefined ? { name: clean.name } : {}),
      ...(clean.role !== undefined ? { role: clean.role } : {}),
      ...(clean.description !== undefined ? { description: clean.description } : {}),
      ...(clean.systemPrompt !== undefined
        ? { systemPrompt: clean.systemPrompt || defaultSystemPromptForRole(role) }
        : {}),
      ...(skillIds !== undefined ? { skillIds: skillIds.length ? skillIds : undefined } : {}),
      ...(args.llmProviderId !== undefined ? { llmProviderId: args.llmProviderId ?? undefined } : {}),
      ...(args.llmModelId !== undefined ? { llmModelId: args.llmModelId ?? undefined } : {}),
      ...(args.runtime !== undefined ? { runtime: args.runtime ?? undefined } : {}),
      ...(args.opencodeModel !== undefined ? { opencodeModel: normalizeOpencodeModel(args.opencodeModel) } : {}),
      ...(args.avatarParams !== undefined ? { avatarParams: args.avatarParams } : {}),
      ...(clean.tags !== undefined ? { tags: clean.tags.length ? clean.tags : undefined } : {}),
      updatedAt: Date.now(),
    });
    const { templateId: _id, ...fields } = args;
    await recordAudit(ctx, { action: "template.update", target: clean.name ?? row.name, details: { changed: setFields(fields) } });
  },
});

/** Custom templates only; built-ins live in code and cannot be deleted. */
export const remove = mutation({
  args: { templateId: v.string() },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    if (findBuiltInTemplate(args.templateId)) throw new Error("Built-in templates cannot be deleted");
    const id = ctx.db.normalizeId("agentTemplates", args.templateId);
    const row = id ? await ctx.db.get(id) : null;
    if (!id || !row) throw new Error("Template not found");
    await ctx.db.delete(id);
    await recordAudit(ctx, { action: "template.remove", target: row.name });
  },
});

/**
 * Save an agent's current (stored) configuration as a custom template:
 * role, instructions, library skills, LLM preference, runtime and avatar.
 * Name defaults to the agent's name, numbered when taken.
 */
export const saveFromAgent = mutation({
  args: { agentId: v.id("agents"), name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const agent = await assertAgentAccess(ctx, args.agentId);
    await assertRegistryWriteAccess(ctx);
    const role = agent.role.trim().toLowerCase();
    const requested = args.name?.trim();
    const clean = validateTemplateInput({
      name: requested || (await freeTemplateName(ctx, agent.name.trim() || ROLES.frontend.label)),
      role: isRoleKey(role) ? role : "frontend",
      description: (agent.description ?? "").slice(0, 280),
      systemPrompt: agent.systemPrompt ?? "",
    });
    if (requested) await assertUniqueName(ctx, clean.name!);
    const skillIds = (
      await Promise.all((agent.skillIds ?? []).map(async (id) => ((await ctx.db.get(id)) ? id : null)))
    ).filter((id): id is Id<"skills"> => id !== null);
    const now = Date.now();
    const templateId = await ctx.db.insert("agentTemplates", {
      name: clean.name!,
      role: clean.role!,
      description: clean.description ?? "",
      systemPrompt: clean.systemPrompt || defaultSystemPromptForRole(clean.role!),
      ...(skillIds.length ? { skillIds } : {}),
      ...(agent.llmProviderId ? { llmProviderId: agent.llmProviderId } : {}),
      ...(agent.llmModelId ? { llmModelId: agent.llmModelId } : {}),
      ...(agent.executionRuntime ? { runtime: agent.executionRuntime } : {}),
      ...(agent.opencodeModel ? { opencodeModel: agent.opencodeModel } : {}),
      ...(agent.avatarParams ? { avatarParams: agent.avatarParams } : {}),
      builtIn: false,
      createdAt: now,
      updatedAt: now,
    });
    await recordAudit(ctx, { action: "template.create", target: clean.name!, details: { fromAgent: `${agent.name} (${agent.role})` } });
    return { templateId, name: clean.name! };
  },
});

/**
 * New agent from a template. Name follows the New agent modal rule (role
 * label, numbered when taken); role defaults (capabilities, tools,
 * scheduling) come from the role; the template supplies instructions,
 * skills, LLM preference, runtime and avatar. With `projectId`, the agent
 * also joins that project's team.
 */
export const createAgentFromTemplate = mutation({
  args: { templateId: v.string(), projectId: v.optional(v.id("projects")) },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const project = args.projectId ? await assertProjectAccess(ctx, args.projectId) : null;
    const template = await resolveTemplate(ctx, args.templateId);
    const agents = await ctx.db.query("agents").collect();
    const name = nextAgentName(template.role, agents);
    const role = template.role;
    const defaults = isRoleKey(role) ? ROLES[role] : null;
    // A preference whose provider/model was deleted since is dropped.
    const llmProviderId =
      template.llmProviderId && (await ctx.db.get(template.llmProviderId)) ? template.llmProviderId : undefined;
    const llmModelId =
      template.llmModelId && (await ctx.db.get(template.llmModelId)) ? template.llmModelId : undefined;
    const agentId = await ctx.db.insert("agents", {
      name,
      role,
      systemPrompt: template.systemPrompt.trim() || defaultSystemPromptForRole(role),
      status: "idle",
      avatarParams: template.avatarParams ?? defaultAvatarParams(name),
      ...(template.description ? { description: template.description } : {}),
      ...(defaults
        ? {
            capabilities: [...defaults.capabilities],
            supportedTools: [...defaults.defaultTools],
            priority: defaults.priority,
            maxConcurrency: defaults.maxConcurrency,
          }
        : { priority: 0, maxConcurrency: 1 }),
      isEnabled: true,
      ...(template.skillIds.length ? { skillIds: template.skillIds } : {}),
      ...(llmProviderId ? { llmProviderId } : {}),
      ...(llmModelId ? { llmModelId } : {}),
      ...(template.runtime ? { executionRuntime: template.runtime } : {}),
      ...(template.opencodeModel ? { opencodeModel: template.opencodeModel } : {}),
    });
    if (project) {
      await ctx.db.patch(project._id, { agentIds: [...(project.agentIds ?? []), agentId] });
    }
    await recordAudit(ctx, {
      action: "agent.create",
      target: `${name} (${role})`,
      details: { template: template.name },
      ...(project ? { projectId: project._id } : {}),
    });
    return { agentId, name };
  },
});
