import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { decryptApiKey } from "./llmCrypto";

/**
 * Where a GitHub token comes from.
 *
 * One account-level connection (`githubConnections`, scope "global") serves
 * every project. Until `integrations:migrateGithubToGlobal` has run (or the
 * user connects through the new flow), the legacy per-project
 * `integrations.accessToken` is read as a fallback. Once a global row
 * exists, in any status, it is the only source: a disconnect stays a
 * disconnect and never falls back to an old project token.
 */

type Ctx = QueryCtx | MutationCtx;

export type GithubTokenSource = "global" | "legacy";

export async function globalGithubConnection(ctx: Ctx): Promise<Doc<"githubConnections"> | null> {
  return await ctx.db
    .query("githubConnections")
    .withIndex("by_scope", (q) => q.eq("scope", "global"))
    .first();
}

/** The project's repo binding row (owner/repo/base branch, webhook secret). */
export async function projectGithubBinding(ctx: Ctx, projectId: Id<"projects">): Promise<Doc<"integrations"> | null> {
  return await ctx.db
    .query("integrations")
    .withIndex("by_project_and_type", (q) => q.eq("projectId", projectId).eq("type", "github"))
    .first();
}

function legacyUsable(row: Doc<"integrations"> | null | undefined): row is Doc<"integrations"> & { accessToken: string } {
  return Boolean(row && row.type === "github" && row.status !== "disconnected" && row.accessToken);
}

async function legacyRow(ctx: Ctx, projectId?: Id<"projects">): Promise<(Doc<"integrations"> & { accessToken: string }) | null> {
  if (projectId) {
    const row = await projectGithubBinding(ctx, projectId);
    return legacyUsable(row) ? row : null;
  }
  const rows = await ctx.db
    .query("integrations")
    .withIndex("by_type", (q) => q.eq("type", "github"))
    .collect();
  const match = rows.find((row) => row.status === "active" && legacyUsable(row));
  return legacyUsable(match) ? match : null;
}

/** Connection state without decrypting anything (safe for UI queries). */
export async function githubConnectionState(
  ctx: Ctx,
  projectId?: Id<"projects">
): Promise<{ connected: boolean; source: GithubTokenSource | null; login?: string; status?: string; errorMessage?: string }> {
  const global = await globalGithubConnection(ctx);
  if (global) {
    const connected = global.status !== "disconnected" && Boolean(global.accessTokenCiphertext);
    return {
      connected,
      source: connected ? "global" : null,
      login: global.login,
      status: global.status,
      errorMessage: global.errorMessage,
    };
  }
  const legacy = await legacyRow(ctx, projectId);
  return legacy
    ? { connected: true, source: "legacy", status: legacy.status, errorMessage: legacy.errorMessage }
    : { connected: false, source: null };
}

/**
 * The plaintext token a project (or, without a project, the deployment)
 * uses for GitHub. Backend-only: callers hand it to the worker through
 * token-gated paths or use it in actions; it never reaches a client.
 */
export async function resolveGithubToken(
  ctx: Ctx,
  projectId?: Id<"projects">
): Promise<{ token: string; source: GithubTokenSource; login?: string } | null> {
  const global = await globalGithubConnection(ctx);
  if (global) {
    if (global.status === "disconnected" || !global.accessTokenCiphertext) return null;
    return {
      token: await decryptApiKey(global.accessTokenCiphertext, "GitHub"),
      source: "global",
      login: global.login,
    };
  }
  const legacy = await legacyRow(ctx, projectId);
  return legacy ? { token: legacy.accessToken, source: "legacy" } : null;
}

/**
 * Clear plaintext legacy tokens from every per-project GitHub row, keeping
 * the repo binding and webhook secret. Called once a global connection
 * exists. Returns how many rows were scrubbed.
 */
export async function scrubLegacyGithubTokens(ctx: MutationCtx): Promise<number> {
  const rows = await ctx.db
    .query("integrations")
    .withIndex("by_type", (q) => q.eq("type", "github"))
    .collect();
  let cleared = 0;
  for (const row of rows) {
    if (row.accessToken === undefined && row.refreshToken === undefined && row.tokenExpiresAt === undefined) continue;
    await ctx.db.patch(row._id, {
      accessToken: undefined,
      refreshToken: undefined,
      tokenExpiresAt: undefined,
      updatedAt: Date.now(),
    });
    cleared++;
  }
  return cleared;
}
