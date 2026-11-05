import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

function defaultAvatarParams(name: string) {
  const palettes = ["Black", "Brown", "Blonde", "Red", "PastelPink"];
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  const hairColor = palettes[Math.abs(hash) % palettes.length];
  return {
    avatarStyle: "Circle",
    topType: "ShortHairShortFlat",
    accessoriesType: "Blank",
    hatColor: "Black",
    hairColor,
    facialHairType: "Blank",
    facialHairColor: "Brown",
    clotheType: "ShirtCrewNeck",
    clotheColor: "Blue03",
    eyeType: "Default",
    eyebrowType: "Default",
    mouthType: "Smile",
    skinColor: "Light",
  };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const agents = await ctx.db.query("agents").collect();
    return agents.map(({ llmApiKey, ...agent }) => ({
      ...agent,
      llmApiKeyConfigured: Boolean(llmApiKey),
    }));
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    role: v.string(),
    systemPrompt: v.optional(v.string()),
    llmProvider: v.optional(v.string()),
    llmModel: v.optional(v.string()),
    llmBaseUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    const role = args.role.trim();
    const systemPrompt = args.systemPrompt?.trim();
    const llmProvider = args.llmProvider?.trim() || "anthropic";
    const llmModel = args.llmModel?.trim();
    const llmBaseUrl = args.llmBaseUrl?.trim();
    if (!name) throw new Error("Agent name is required");
    if (!role) throw new Error("Agent role is required");

    return await ctx.db.insert("agents", {
      name,
      role,
      ...(systemPrompt ? { systemPrompt } : {}),
      llmProvider,
      ...(llmModel ? { llmModel } : {}),
      ...(llmBaseUrl ? { llmBaseUrl } : {}),
      status: "idle",
      avatarParams: defaultAvatarParams(name),
    });
  },
});

export const update = mutation({
  args: {
    agentId: v.id("agents"),
    name: v.string(),
    role: v.string(),
    systemPrompt: v.string(),
    llmProvider: v.string(),
    llmModel: v.string(),
    llmBaseUrl: v.string(),
    llmApiKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    const role = args.role.trim();
    if (!name) throw new Error("Agent name is required");
    if (!role) throw new Error("Agent role is required");
    await ctx.db.patch(args.agentId, {
      name,
      role,
      systemPrompt: args.systemPrompt.trim() || undefined,
      llmProvider: args.llmProvider.trim() || "anthropic",
      llmModel: args.llmModel.trim() || undefined,
      llmBaseUrl: args.llmBaseUrl.trim() || undefined,
      ...(args.llmApiKey?.trim() ? { llmApiKey: args.llmApiKey.trim() } : {}),
    });
  },
});

export const updateStatus = mutation({
  args: {
    agentId: v.id("agents"),
    status: v.union(
      v.literal("idle"),
      v.literal("working"),
      v.literal("queued"),
      v.literal("needs_you")
    ),
  },
  handler: async (ctx, args) => {
    const { agentId, status } = args;
    return await ctx.db.patch(agentId, { status });
  },
});

export const remove = mutation({
  args: { agentId: v.id("agents") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.agentId);
  },
});
