import { query, internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess, visibleProjectIds } from "./lib/authz";
import { decryptApiKey, encryptApiKey } from "./lib/llmCrypto";
import { ROLE_KEYS } from "./lib/roles";
import { changedFields, recordAudit } from "./lib/recordAudit";
import {
  MCP_ENV_KEY_PATTERN,
  MCP_RESERVED_ENV_KEYS,
  REMOTE_UNSUPPORTED_MESSAGE,
  buildPresetArgs,
  getMcpPreset,
  type McpPreset,
} from "./lib/mcpPresets";

/**
 * MCP server config — Plan 007 Phase 1 (UI config) + Plan 009 (worker
 * integration) + the Integrations page (scope, roles, presets, encrypted
 * env, test connection).
 *
 * All writes are internal mutations, called by the Next.js server route
 * (apps/web/app/api/mcp-servers) through the token-gated actions in
 * worker.ts, which hold CONVEX_SERVICE_TOKEN. An MCP row is a command the
 * worker will spawn, so the browser must never write one directly.
 * Reads use the conditional ownership model of lib/authz.ts (local
 * single-user mode has no identity; do not add a hard identity check).
 *
 * Scope: a row with no projectId is GLOBAL. A run resolves
 * global + its project's rows, enabled only (`resolveRunMcpServers`); the
 * worker then filters per agent by `agentRoles`.
 *
 * Secrets: env values are stored as ONE AES-GCM ciphertext
 * (`envCiphertext`, lib/llmCrypto — the same helper and key as provider
 * API keys). The browser only ever sees the key names (`envKeys`).
 */

const MAX_TOOL_NAMES = 50;
const TEST_LEASE_MS = 90_000;

const mcpConfigFields = {
  enabled: v.optional(v.boolean()),
  autoConnect: v.optional(v.boolean()),
  transport: v.optional(v.string()),
  allowedDirectories: v.optional(v.array(v.string())),
};

type McpRow = Doc<"mcpServers">;

/** Browser-safe projection: no ciphertext, no lease internals. */
export function maskMcpServer(row: McpRow) {
  const {
    envCiphertext: _cipher,
    testWorkerId: _worker,
    testLeaseExpiresAt: _lease,
    ...rest
  } = row;
  return {
    ...rest,
    envKeys: row.envKeys ?? [],
    hasEnv: Boolean(row.envCiphertext),
    testPending: row.testRequestedAt !== undefined,
  };
}

async function globalRows(ctx: QueryCtx | MutationCtx): Promise<McpRow[]> {
  return await ctx.db
    .query("mcpServers")
    .withIndex("by_project", (q) => q.eq("projectId", undefined))
    .collect();
}

async function projectRows(ctx: QueryCtx | MutationCtx, projectId: Id<"projects">): Promise<McpRow[]> {
  return await ctx.db
    .query("mcpServers")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
}

/**
 * The server set one run may use: global + this project's rows, enabled
 * only. Role filtering happens in the worker per agent (a run has several
 * agents). Rows carry `envCiphertext` (never plaintext); the worker
 * decrypts it at spawn with its own PROVIDER_ENCRYPTION_KEY.
 */
export async function resolveRunMcpServers(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects"> | undefined
): Promise<McpRow[]> {
  const rows = [...(await globalRows(ctx)), ...(projectId ? await projectRows(ctx, projectId) : [])];
  return rows
    .filter((row) => row.enabled !== false)
    .map(({ testWorkerId: _w, testLeaseExpiresAt: _l, toolNames: _t, ...row }) => row as McpRow);
}

export const list = query({
  args: {
    projectId: v.optional(v.id("projects")),
    scope: v.optional(v.union(v.literal("all"), v.literal("global"), v.literal("project"))),
  },
  handler: async (ctx, args) => {
    const scope = args.scope ?? "all";
    let rows: McpRow[];
    if (args.projectId) {
      await assertProjectAccess(ctx, args.projectId);
      rows = [
        ...(scope === "project" ? [] : await globalRows(ctx)),
        ...(scope === "global" ? [] : await projectRows(ctx, args.projectId)),
      ];
    } else {
      const visible = await visibleProjectIds(ctx);
      const all = await ctx.db.query("mcpServers").collect();
      rows = all.filter((row) => {
        if (row.projectId === undefined) return scope !== "project";
        return scope !== "global" && visible.has(String(row.projectId));
      });
    }
    rows.sort((a, b) => a.createdAt - b.createdAt);
    return rows.map(maskMcpServer);
  },
});

// ---------------------------------------------------------------------------
// Validation + env encryption helpers
// ---------------------------------------------------------------------------

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) throw new Error("Name must be 1–80 characters.");
  return trimmed;
}

function cleanRoles(roles: string[] | undefined): string[] | undefined {
  if (roles === undefined) return undefined;
  const allowed = new Set<string>(ROLE_KEYS);
  const out = [...new Set(roles.map((role) => role.trim().toLowerCase()).filter(Boolean))];
  for (const role of out) {
    if (!allowed.has(role)) throw new Error(`Unknown role "${role}".`);
  }
  return out;
}

function cleanToolAllowlist(tools: string[] | undefined): string[] | undefined {
  if (tools === undefined) return undefined;
  const out = [...new Set(tools.map((tool) => tool.trim()).filter(Boolean))];
  for (const tool of out) {
    if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(tool)) throw new Error(`Invalid tool name "${tool}".`);
  }
  return out;
}

function assertEnvKey(key: string): void {
  if (!MCP_ENV_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid env key "${key}": use UPPER_SNAKE_CASE.`);
  }
  if (MCP_RESERVED_ENV_KEYS.has(key)) throw new Error(`Env key "${key}" is reserved.`);
}

function encodeArgs(args: string[]): string {
  for (const arg of args) {
    if (arg.length > 4_000) throw new Error("An argument is too long.");
  }
  return JSON.stringify(args);
}

async function readEnv(row: Pick<McpRow, "envCiphertext" | "name">): Promise<Record<string, string>> {
  if (!row.envCiphertext) return {};
  const plain = await decryptApiKey(row.envCiphertext, `MCP server ${row.name}`);
  const parsed = JSON.parse(plain) as Record<string, string>;
  return parsed && typeof parsed === "object" ? parsed : {};
}

async function sealEnv(env: Record<string, string>): Promise<{ envCiphertext?: string; envKeys: string[] }> {
  const keys = Object.keys(env).sort();
  if (keys.length === 0) return { envCiphertext: undefined, envKeys: [] };
  return { envCiphertext: await encryptApiKey(JSON.stringify(env)), envKeys: keys };
}

/** Filesystem root: `{workspace}` or an absolute, non-system path. */
function filesystemRootDirs(preset: McpPreset, fields: Record<string, string>): string[] | undefined {
  if (preset.id !== "filesystem") return undefined;
  const root = (fields.root ?? "{workspace}").trim() || "{workspace}";
  if (root === "{workspace}") return [];
  if (!root.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(root)) {
    throw new Error("Root path must be {workspace} or an absolute path.");
  }
  return [root];
}

function assertRemoteUrl(url: string): string {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("URL is not valid.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("URL must be http(s).");
  return trimmed;
}

/** The project's active GitHub OAuth token, or undefined. */
async function githubOAuthToken(ctx: MutationCtx, projectId: Id<"projects">): Promise<string | undefined> {
  const integration = await ctx.db
    .query("integrations")
    .withIndex("by_project_and_type", (q) => q.eq("projectId", projectId).eq("type", "github"))
    .first();
  if (!integration || integration.status !== "active") return undefined;
  return integration.accessToken ?? undefined;
}

const GITHUB_TOKEN_KEY = "GITHUB_PERSONAL_ACCESS_TOKEN";

/**
 * Re-seal the env of every GitHub-preset row in a project that uses the
 * OAuth connection, so a reconnect or disconnect reaches the MCP server
 * too. Called from integrations.ts on upsert/remove.
 */
export async function syncGithubOAuthEnv(ctx: MutationCtx, projectId: Id<"projects">): Promise<void> {
  const token = await githubOAuthToken(ctx, projectId);
  const rows = (await projectRows(ctx, projectId)).filter(
    (row) => row.preset === "github" && row.useGithubOAuth === true
  );
  for (const row of rows) {
    const env = await readEnv(row);
    if (token) env[GITHUB_TOKEN_KEY] = token;
    else delete env[GITHUB_TOKEN_KEY];
    await ctx.db.patch(row._id, { ...(await sealEnv(env)), status: "untested", updatedAt: Date.now() });
  }
}

// ---------------------------------------------------------------------------
// Writes (internal; reached through token-gated worker.ts actions)
// ---------------------------------------------------------------------------

export const add = internalMutation({
  args: {
    projectId: v.optional(v.id("projects")),
    name: v.string(),
    type: v.union(v.literal("local"), v.literal("remote")),
    url: v.optional(v.string()),
    command: v.optional(v.string()),
    args: v.optional(v.string()),
    ...mcpConfigFields,
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("mcpServers", {
      projectId: args.projectId,
      name: args.name,
      type: args.type,
      url: args.url,
      command: args.command,
      args: args.args,
      status: "disconnected",
      createdAt: Date.now(),
      enabled: args.enabled,
      autoConnect: args.autoConnect,
      transport: args.transport,
      allowedDirectories: args.allowedDirectories,
    });
    // Command/args/url can embed credentials: record the name and type only.
    await recordAudit(ctx, {
      action: "mcpServer.add",
      target: args.name,
      projectId: args.projectId,
      details: { type: args.type },
    });
    return id;
  },
});

const editableArgs = {
  name: v.optional(v.string()),
  /** Plain preset field values (e.g. filesystem root). */
  fields: v.optional(v.record(v.string(), v.string())),
  /** Secret env values to set (plaintext in transit only; sealed here). */
  env: v.optional(v.record(v.string(), v.string())),
  agentRoles: v.optional(v.array(v.string())),
  toolAllowlist: v.optional(v.array(v.string())),
  enabled: v.optional(v.boolean()),
  autoConnect: v.optional(v.boolean()),
  useGithubOAuth: v.optional(v.boolean()),
  // Custom preset only.
  type: v.optional(v.union(v.literal("local"), v.literal("remote"))),
  command: v.optional(v.string()),
  commandArgs: v.optional(v.array(v.string())),
  url: v.optional(v.string()),
};

export const createFromPreset = internalMutation({
  args: {
    presetId: v.string(),
    projectId: v.optional(v.id("projects")),
    ...editableArgs,
  },
  handler: async (ctx, args): Promise<Id<"mcpServers">> => {
    const preset = getMcpPreset(args.presetId);
    if (!preset) throw new Error(`Unknown preset "${args.presetId}".`);
    if (args.projectId && !(await ctx.db.get(args.projectId))) throw new Error("Project not found.");
    if (args.useGithubOAuth && (preset.id !== "github" || !args.projectId)) {
      throw new Error("The GitHub connection can only be used by a project-scoped GitHub server.");
    }

    const fields = args.fields ?? {};
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(args.env ?? {})) {
      assertEnvKey(key);
      if (value.trim()) env[key] = value;
    }

    let type: "local" | "remote" = "local";
    let command: string | undefined;
    let storedArgs: string | undefined;
    let url: string | undefined;
    if (preset.id === "custom") {
      type = args.type ?? "local";
      if (type === "remote") {
        if (!args.url) throw new Error("A remote server needs a URL.");
        url = assertRemoteUrl(args.url);
      } else {
        command = args.command?.trim();
        if (!command) throw new Error("A local server needs a command.");
        storedArgs = encodeArgs(args.commandArgs ?? []);
      }
    } else {
      command = preset.command;
      storedArgs = encodeArgs(buildPresetArgs(preset, fields));
    }

    const githubToken = args.useGithubOAuth && args.projectId ? await githubOAuthToken(ctx, args.projectId) : undefined;
    if (githubToken) env[GITHUB_TOKEN_KEY] = githubToken;
    for (const secret of preset.secrets) {
      if (secret.required && !env[secret.key]) throw new Error(`${secret.label} is required.`);
    }

    const now = Date.now();
    const id = await ctx.db.insert("mcpServers", {
      projectId: args.projectId,
      name: cleanName(args.name ?? preset.name),
      type,
      url,
      command,
      args: storedArgs,
      status: "untested",
      errorMessage: type === "remote" ? REMOTE_UNSUPPORTED_MESSAGE : undefined,
      createdAt: now,
      updatedAt: now,
      enabled: args.enabled ?? true,
      autoConnect: args.autoConnect ?? false,
      transport: type === "local" ? "stdio" : undefined,
      allowedDirectories: filesystemRootDirs(preset, fields),
      preset: preset.id,
      agentRoles: cleanRoles(args.agentRoles),
      toolAllowlist: cleanToolAllowlist(args.toolAllowlist),
      useGithubOAuth: args.useGithubOAuth || undefined,
      ...(await sealEnv(env)),
    });
    // Name, preset and env KEY names only — never values or args.
    await recordAudit(ctx, {
      action: "mcpServer.add",
      target: cleanName(args.name ?? preset.name),
      projectId: args.projectId,
      details: { type, preset: preset.id, scope: args.projectId ? "project" : "global", envKeys: Object.keys(env).sort() },
    });
    return id;
  },
});

export const update = internalMutation({
  args: {
    serverId: v.id("mcpServers"),
    /** `null` moves the server to GLOBAL scope. */
    projectId: v.optional(v.union(v.id("projects"), v.null())),
    removeEnvKeys: v.optional(v.array(v.string())),
    ...editableArgs,
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.serverId);
    if (!row) throw new Error("MCP server not found.");
    const preset = getMcpPreset(row.preset);
    const patch: Partial<McpRow> = { updatedAt: Date.now() };
    let configChanged = false;

    if (args.name !== undefined) patch.name = cleanName(args.name);
    if (args.agentRoles !== undefined) patch.agentRoles = cleanRoles(args.agentRoles);
    if (args.toolAllowlist !== undefined) patch.toolAllowlist = cleanToolAllowlist(args.toolAllowlist);
    if (args.enabled !== undefined) patch.enabled = args.enabled;
    if (args.autoConnect !== undefined) patch.autoConnect = args.autoConnect;

    const nextProjectId =
      args.projectId === undefined ? row.projectId : args.projectId === null ? undefined : args.projectId;
    if (args.projectId !== undefined) {
      if (nextProjectId && !(await ctx.db.get(nextProjectId))) throw new Error("Project not found.");
      patch.projectId = nextProjectId;
      configChanged = true;
    }

    if (preset && preset.id !== "custom" && args.fields !== undefined) {
      patch.args = encodeArgs(buildPresetArgs(preset, args.fields));
      patch.allowedDirectories = filesystemRootDirs(preset, args.fields);
      configChanged = true;
    }
    if (preset?.id === "custom") {
      const type = args.type ?? row.type;
      if (args.type !== undefined) patch.type = type;
      if (type === "remote") {
        if (args.url !== undefined) patch.url = assertRemoteUrl(args.url);
        patch.command = undefined;
        patch.args = undefined;
        patch.transport = undefined;
      } else {
        if (args.command !== undefined) {
          const command = args.command.trim();
          if (!command) throw new Error("A local server needs a command.");
          patch.command = command;
        }
        if (args.commandArgs !== undefined) patch.args = encodeArgs(args.commandArgs);
        patch.transport = "stdio";
        if (args.type !== undefined) patch.url = undefined;
      }
      if (args.type !== undefined || args.url !== undefined || args.command !== undefined || args.commandArgs !== undefined) {
        configChanged = true;
      }
    }

    const useOAuth = args.useGithubOAuth ?? row.useGithubOAuth ?? false;
    if (useOAuth && (row.preset !== "github" || !nextProjectId)) {
      throw new Error("The GitHub connection can only be used by a project-scoped GitHub server.");
    }
    if (args.useGithubOAuth !== undefined) patch.useGithubOAuth = args.useGithubOAuth || undefined;

    const touchesEnv =
      args.env !== undefined || (args.removeEnvKeys?.length ?? 0) > 0 || args.useGithubOAuth !== undefined || args.projectId !== undefined;
    if (touchesEnv) {
      const env = await readEnv(row);
      for (const key of args.removeEnvKeys ?? []) delete env[key];
      for (const [key, value] of Object.entries(args.env ?? {})) {
        assertEnvKey(key);
        if (value.trim()) env[key] = value;
      }
      if (row.useGithubOAuth && !useOAuth) delete env[GITHUB_TOKEN_KEY];
      if (useOAuth && nextProjectId) {
        const token = await githubOAuthToken(ctx, nextProjectId);
        if (token) env[GITHUB_TOKEN_KEY] = token;
      }
      for (const secret of preset?.secrets ?? []) {
        if (secret.required && !env[secret.key]) throw new Error(`${secret.label} is required.`);
      }
      Object.assign(patch, await sealEnv(env));
      configChanged = true;
    }

    if (configChanged) {
      const remote = (patch.type ?? row.type) === "remote";
      patch.status = "untested";
      patch.errorMessage = remote ? REMOTE_UNSUPPORTED_MESSAGE : undefined;
      patch.toolCount = undefined;
      patch.toolNames = undefined;
    }
    await ctx.db.patch(args.serverId, patch);
    const changed = changedFields(row as Record<string, unknown>, patch as Record<string, unknown>).filter(
      (field) => !["status", "errorMessage", "toolCount", "toolNames"].includes(field)
    );
    if (changed.length) {
      await recordAudit(ctx, {
        action: "mcpServer.update",
        target: patch.name ?? row.name,
        projectId: nextProjectId,
        details: { changed },
      });
    }
  },
});

export const setEnabled = internalMutation({
  args: { serverId: v.id("mcpServers"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.serverId);
    if (!row) throw new Error("MCP server not found.");
    await ctx.db.patch(args.serverId, { enabled: args.enabled, updatedAt: Date.now() });
    if ((row.enabled !== false) !== args.enabled) {
      await recordAudit(ctx, {
        action: args.enabled ? "mcpServer.enable" : "mcpServer.disable",
        target: row.name,
        projectId: row.projectId,
      });
    }
  },
});

export const updateStatus = internalMutation({
  args: {
    serverId: v.id("mcpServers"),
    status: v.union(v.literal("connected"), v.literal("disconnected"), v.literal("error"), v.literal("untested")),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.serverId, {
      status: args.status,
      errorMessage: args.errorMessage,
    });
  },
});

export const remove = internalMutation({
  args: { serverId: v.id("mcpServers") },
  handler: async (ctx, args) => {
    const server = await ctx.db.get(args.serverId);
    await ctx.db.delete(args.serverId);
    if (server) {
      await recordAudit(ctx, {
        action: "mcpServer.remove",
        target: server.name,
        projectId: server.projectId,
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Test connection (worker-executed)
// ---------------------------------------------------------------------------

/**
 * Ask a worker to spawn the server and list its tools. Convex cannot spawn
 * processes, so the request waits for a running worker (index.ts polls
 * `claimTest`). A remote row is never claimed: the worker has no remote
 * transport, so it is recorded `untested` with that reason.
 */
export const requestTest = internalMutation({
  args: { serverId: v.id("mcpServers") },
  handler: async (ctx, args): Promise<{ queued: boolean; message?: string }> => {
    const row = await ctx.db.get(args.serverId);
    if (!row) throw new Error("MCP server not found.");
    if (row.type === "remote" || !row.command) {
      await ctx.db.patch(args.serverId, {
        status: "untested",
        errorMessage: REMOTE_UNSUPPORTED_MESSAGE,
        testRequestedAt: undefined,
      });
      return { queued: false, message: REMOTE_UNSUPPORTED_MESSAGE };
    }
    await ctx.db.patch(args.serverId, {
      testRequestedAt: Date.now(),
      testWorkerId: undefined,
      testLeaseExpiresAt: undefined,
    });
    return { queued: true };
  },
});

export const claimTest = internalMutation({
  args: { workerId: v.string(), leaseMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const candidates = await ctx.db
      .query("mcpServers")
      .withIndex("by_test_requested", (q) => q.gt("testRequestedAt", 0))
      .take(20);
    const row = candidates.find((candidate) => !candidate.testLeaseExpiresAt || candidate.testLeaseExpiresAt < now);
    if (!row) return null;
    await ctx.db.patch(row._id, {
      testWorkerId: args.workerId,
      testLeaseExpiresAt: now + (args.leaseMs ?? TEST_LEASE_MS),
    });
    const project = row.projectId ? await ctx.db.get(row.projectId) : null;
    return {
      serverId: row._id,
      name: row.name,
      type: row.type,
      command: row.command,
      args: row.args,
      preset: row.preset,
      allowedDirectories: row.allowedDirectories,
      envCiphertext: row.envCiphertext,
      workspacePath: project?.workspacePath ?? null,
    };
  },
});

export const completeTest = internalMutation({
  args: {
    serverId: v.id("mcpServers"),
    workerId: v.string(),
    ok: v.boolean(),
    toolNames: v.optional(v.array(v.string())),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db.get(args.serverId);
    if (!row || row.testWorkerId !== args.workerId) return false;
    const names = args.toolNames ?? [];
    await ctx.db.patch(args.serverId, {
      status: args.ok ? "connected" : "error",
      errorMessage: args.ok ? undefined : (args.errorMessage ?? "Connection failed").slice(0, 500),
      lastTestedAt: Date.now(),
      toolCount: args.ok ? names.length : undefined,
      toolNames: args.ok ? names.slice(0, MAX_TOOL_NAMES) : undefined,
      testRequestedAt: undefined,
      testWorkerId: undefined,
      testLeaseExpiresAt: undefined,
    });
    return true;
  },
});
