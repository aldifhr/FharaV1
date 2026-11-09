import {
  mutation,
  query,
  action,
  httpAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assertProjectAccess, assertRegistryWriteAccess, getViewerId } from "./lib/authz";
import { changedFields, recordAudit } from "./lib/recordAudit";
import { syncGithubOAuthEnv, syncGithubOAuthEnvAll } from "./mcpServers";
import {
  githubConnectionState,
  globalGithubConnection,
  projectGithubBinding,
  resolveGithubToken,
  scrubLegacyGithubTokens,
} from "./lib/githubAuth";
import {
  OAUTH_STATE_MAX_AGE_MS,
  OAUTH_STATE_RETENTION_MS,
  appOrigin,
  newOAuthNonce,
  oauthStateSecret,
  safeReturnTo,
  signOAuthState,
  verifyOAuthState,
} from "./lib/oauthState";
import { decryptApiKey, encryptApiKey } from "./lib/llmCrypto";
import {
  HANDLED_GITHUB_EVENTS,
  WEBHOOK_DELIVERY_RETENTION_MS,
  generateWebhookSecretValue,
  verifyGithubSignature,
} from "./lib/githubWebhook";
import { parsePrSignal } from "./lib/prFeedback";

// GitHub OAuth configuration
// Read per call (not at module load) so env changes and tests see them.
const githubClientId = () => process.env.GITHUB_CLIENT_ID ?? "";
const githubClientSecret = () => process.env.GITHUB_CLIENT_SECRET ?? "";
const githubCallbackUrl = () =>
  process.env.GITHUB_OAUTH_CALLBACK_URL ?? "http://localhost:3000/api/integrations/github/callback";

/**
 * Account-level GitHub connection (one per deployment; the app is
 * single-owner). Connect and disconnect are registry-level writes
 * (`assertRegistryWriteAccess`: a signed-in viewer, or local single-user
 * mode). Projects keep only a repo binding + webhook secret in
 * `integrations`; see lib/githubAuth for how a token is resolved.
 */

const OAUTH_SCOPE = "repo read:user write:repo_hook";

function oauthPage(title: string, body: string, message: Record<string, unknown>, redirectPath?: string): Response {
  // The popup reports to its opener on the web app origin only, never "*".
  const origin = appOrigin();
  const fallback = redirectPath ? `${origin}${redirectPath}` : null;
  return new Response(
    `<html><body>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(body)}</p>
      <script>
        if (window.opener) {
          window.opener.postMessage(${JSON.stringify(message).replace(/</g, "\\u003c")}, ${JSON.stringify(origin)});
          setTimeout(() => window.close(), 800);
        }${fallback ? ` else { window.location.replace(${JSON.stringify(fallback).replace(/</g, "\\u003c")}); }` : ""}
      </script>
    </body></html>`,
    { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } }
  );
}

/**
 * Start the GitHub OAuth flow: records a one-time nonce and returns the
 * authorization URL with a signed `state`. An ACTION so the nonce comes
 * from real randomness; the row is written through an internal mutation
 * that also checks access. Null when no OAuth app is configured.
 */
export const getOAuthUrl = action({
  args: { returnTo: v.optional(v.string()) },
  handler: async (ctx, args): Promise<string | null> => {
    if (!githubClientId()) return null;
    const secret = oauthStateSecret();
    if (!secret) {
      throw new Error("Set OAUTH_STATE_SECRET (or PROVIDER_ENCRYPTION_KEY) on the Convex deployment to connect GitHub.");
    }
    const nonce = newOAuthNonce();
    const iat = await ctx.runMutation(internal.integrations.createOAuthState, {
      nonce,
      returnTo: safeReturnTo(args.returnTo),
    });
    const state = await signOAuthState({ v: 1, p: "github", n: nonce, iat }, secret);
    const params = new URLSearchParams({
      client_id: githubClientId(),
      redirect_uri: githubCallbackUrl(),
      scope: OAUTH_SCOPE,
      state,
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  },
});

/** Record a nonce (access-checked) and prune old ones. Returns its createdAt. */
export const createOAuthState = internalMutation({
  args: { nonce: v.string(), returnTo: v.optional(v.string()) },
  handler: async (ctx, args): Promise<number> => {
    await assertRegistryWriteAccess(ctx);
    const now = Date.now();
    const stale = await ctx.db
      .query("oauthStates")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", now - OAUTH_STATE_RETENTION_MS))
      .take(50);
    for (const row of stale) await ctx.db.delete(row._id);
    await ctx.db.insert("oauthStates", {
      nonce: args.nonce,
      provider: "github",
      ownerId: (await getViewerId(ctx)) ?? undefined,
      returnTo: safeReturnTo(args.returnTo),
      createdAt: now,
    });
    return now;
  },
});

/**
 * Consume a nonce exactly once. A mutation is serializable, so two
 * concurrent callbacks with the same state cannot both succeed.
 */
export const consumeOAuthState = internalMutation({
  args: { nonce: v.string() },
  handler: async (
    ctx,
    args
  ): Promise<{ ok: true; returnTo?: string; ownerId?: string } | { ok: false; reason: "unknown" | "reused" | "expired" }> => {
    const row = await ctx.db
      .query("oauthStates")
      .withIndex("by_nonce", (q) => q.eq("nonce", args.nonce))
      .first();
    if (!row || row.provider !== "github") return { ok: false, reason: "unknown" };
    if (row.usedAt !== undefined) return { ok: false, reason: "reused" };
    const now = Date.now();
    await ctx.db.patch(row._id, { usedAt: now });
    if (now - row.createdAt > OAUTH_STATE_MAX_AGE_MS) return { ok: false, reason: "expired" };
    return { ok: true, returnTo: row.returnTo, ownerId: row.ownerId };
  },
});

/** Escape a value for HTML text. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Handle GitHub OAuth callback: verify the signed state, consume its nonce,
 * exchange the code, and store the account-level connection.
 */
export const handleOAuthCallback = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return oauthPage(
      "GitHub OAuth Error",
      `${error} ${url.searchParams.get("error_description") ?? ""}`.trim(),
      { type: "github_oauth_error", error: error.slice(0, 200) }
    );
  }
  if (!code || !state) {
    return new Response("Missing code or state parameter", { status: 400 });
  }

  const secret = oauthStateSecret();
  if (!secret) return new Response("OAuth state secret is not configured", { status: 500 });
  const verified = await verifyOAuthState(state, secret);
  if (!verified.ok) {
    return new Response(
      verified.reason === "expired"
        ? "OAuth state expired; start the GitHub connection again"
        : "Invalid state parameter",
      { status: 400 }
    );
  }
  const consumed = await ctx.runMutation(internal.integrations.consumeOAuthState, { nonce: verified.payload.n });
  if (!consumed.ok) {
    return new Response(
      consumed.reason === "expired"
        ? "OAuth state expired; start the GitHub connection again"
        : "Invalid or already used state parameter",
      { status: 400 }
    );
  }

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: githubClientId(),
      client_secret: githubClientSecret(),
      code,
      redirect_uri: githubCallbackUrl(),
    }),
  });
  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (tokenData.error || !tokenData.access_token) {
    return oauthPage("Token Exchange Error", tokenData.error ?? "Failed to get access token", {
      type: "github_oauth_error",
      error: (tokenData.error ?? "token_exchange_failed").slice(0, 200),
    });
  }

  // The account login, best effort (shown in Integrations).
  let login: string | undefined;
  try {
    const userResponse = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/vnd.github+json" },
    });
    if (userResponse.ok) login = ((await userResponse.json()) as { login?: string }).login;
  } catch {
    // refresh fills it later
  }

  await ctx.runMutation(internal.integrations.upsertGithubIntegration, {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresIn: tokenData.expires_in,
    login,
    ownerId: consumed.ownerId,
  });

  return oauthPage(
    "GitHub Connected!",
    login ? `Signed in as ${login}.` : "Redirecting...",
    { type: "github_oauth_success", login: login ?? null },
    consumed.returnTo ?? "/integrations"
  );
});

/**
 * Store the account-level GitHub connection (OAuth callback, or the manual
 * token path: `npx convex run integrations:upsertGithubIntegration
 * '{"accessToken":"gho_…"}'`). Tokens are sealed with PROVIDER_ENCRYPTION_KEY.
 * `projectId` is optional and only ensures that project has a binding row.
 * Once stored, legacy per-project plaintext tokens are cleared (repo
 * bindings kept) and every OAuth-borrowing MCP server is re-sealed.
 */
export const upsertGithubIntegration = internalMutation({
  args: {
    projectId: v.optional(v.id("projects")),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    expiresIn: v.optional(v.number()),
    login: v.optional(v.string()),
    ownerId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"githubConnections">> => {
    if (!args.accessToken.trim()) throw new Error("accessToken is empty");
    let accessTokenCiphertext: string;
    let refreshTokenCiphertext: string | undefined;
    try {
      accessTokenCiphertext = await encryptApiKey(args.accessToken.trim());
      refreshTokenCiphertext = args.refreshToken ? await encryptApiKey(args.refreshToken) : undefined;
    } catch {
      throw new Error("PROVIDER_ENCRYPTION_KEY is not set on the Convex deployment, so the GitHub token cannot be stored encrypted. Set it and connect again.");
    }
    const now = Date.now();
    const tokenExpiresAt = args.expiresIn ? now + args.expiresIn * 1000 : undefined;
    const existing = await globalGithubConnection(ctx);
    const fields = {
      accessTokenCiphertext,
      refreshTokenCiphertext,
      tokenExpiresAt,
      status: "active" as const,
      errorMessage: undefined,
      updatedAt: now,
      ...(args.login ? { login: args.login, lastSyncAt: now } : {}),
      ...(args.ownerId ? { ownerId: args.ownerId } : {}),
    };
    let id: Id<"githubConnections">;
    if (existing) {
      await ctx.db.patch(existing._id, { ...fields, ...(args.login ? {} : { login: existing.status === "disconnected" ? undefined : existing.login }) });
      id = existing._id;
    } else {
      id = await ctx.db.insert("githubConnections", { scope: "global", createdAt: now, ...fields });
    }
    // Token values never reach the audit row.
    await recordAudit(ctx, {
      action: existing && existing.status !== "disconnected" ? "integration.reconnect" : "integration.add",
      target: "github",
      details: { scope: "global", ...(args.login ? { login: args.login } : {}) },
    });
    if (args.projectId && !(await projectGithubBinding(ctx, args.projectId))) {
      if (!(await ctx.db.get(args.projectId))) throw new Error("Project not found");
      await ctx.db.insert("integrations", {
        projectId: args.projectId,
        type: "github",
        name: "GitHub",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    }
    await scrubLegacyGithubTokens(ctx);
    await syncGithubOAuthEnvAll(ctx);
    return id;
  },
});

/**
 * One-time, idempotent migration to the account-level connection:
 *   npx convex run integrations:migrateGithubToGlobal   (npm run migrate:github-global)
 * If no global connection exists, the most recently updated ACTIVE
 * per-project row that holds a token is promoted (token sealed with
 * PROVIDER_ENCRYPTION_KEY). Whenever a global connection exists, legacy
 * plaintext tokens are cleared from every project row; repo bindings and
 * webhook secrets are kept. Re-running changes nothing.
 */
export const migrateGithubToGlobal = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("integrations")
      .withIndex("by_type", (q) => q.eq("type", "github"))
      .collect();
    const existing = await globalGithubConnection(ctx);
    let promotedFrom: Id<"integrations"> | null = null;
    if (!existing) {
      const candidate = rows
        .filter((row) => row.status === "active" && row.accessToken)
        .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))[0];
      if (candidate?.accessToken) {
        const now = Date.now();
        await ctx.db.insert("githubConnections", {
          scope: "global",
          accessTokenCiphertext: await encryptApiKey(candidate.accessToken),
          refreshTokenCiphertext: candidate.refreshToken ? await encryptApiKey(candidate.refreshToken) : undefined,
          tokenExpiresAt: candidate.tokenExpiresAt,
          status: "active",
          migratedFromIntegrationId: candidate._id,
          createdAt: now,
          updatedAt: now,
        });
        promotedFrom = candidate._id;
        await recordAudit(ctx, {
          action: "integration.migrate",
          target: "github",
          projectId: candidate.projectId,
          details: { scope: "global", from: candidate._id },
        });
      }
    }
    const hasGlobal = Boolean(existing || promotedFrom);
    const legacyTokensCleared = hasGlobal ? await scrubLegacyGithubTokens(ctx) : 0;
    if (promotedFrom || legacyTokensCleared > 0) await syncGithubOAuthEnvAll(ctx);
    return {
      globalExisted: Boolean(existing),
      promotedFrom,
      legacyTokensCleared,
      repoBindingsKept: rows.filter((row) => row.githubOwner && row.githubRepo).length,
    };
  },
});

/** What the global Integrations section shows. Never a token. */
export const githubAccount = query({
  args: {},
  handler: async (ctx) => {
    let canManage = true;
    try {
      await assertRegistryWriteAccess(ctx);
    } catch {
      canManage = false;
    }
    const configured = Boolean(githubClientId());
    if (!canManage) return { configured, canManage, connected: false, source: null, login: null, status: null, errorMessage: null, connectedAt: null };
    const state = await githubConnectionState(ctx);
    const global = await globalGithubConnection(ctx);
    return {
      configured,
      canManage,
      connected: state.connected,
      source: state.source,
      login: state.login ?? null,
      status: state.status ?? null,
      errorMessage: state.errorMessage ?? null,
      connectedAt: global && global.status !== "disconnected" ? global.updatedAt : null,
    };
  },
});

/**
 * Disconnect the account-level GitHub connection. Every project loses
 * push/PR access; repo bindings stay so reconnecting restores them.
 */
export const disconnectGithub = mutation({
  args: {},
  handler: async (ctx) => {
    await assertRegistryWriteAccess(ctx);
    const now = Date.now();
    const existing = await globalGithubConnection(ctx);
    const disconnected = {
      status: "disconnected" as const,
      accessTokenCiphertext: undefined,
      refreshTokenCiphertext: undefined,
      tokenExpiresAt: undefined,
      errorMessage: undefined,
      updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, disconnected);
    // Not migrated yet: a disconnected global row stops the legacy fallback.
    else await ctx.db.insert("githubConnections", { scope: "global", createdAt: now, ...disconnected });
    await scrubLegacyGithubTokens(ctx);
    await recordAudit(ctx, { action: "integration.remove", target: "github", details: { scope: "global" } });
    await syncGithubOAuthEnvAll(ctx);
  },
});

/**
 * Bind a project to a repository (creates the project's binding row when
 * it has none). The token comes from the account-level connection.
 */
export const bindRepo = mutation({
  args: {
    projectId: v.id("projects"),
    githubOwner: v.string(),
    githubRepo: v.string(),
    githubBaseBranch: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"integrations">> => {
    await assertProjectAccess(ctx, args.projectId);
    assertRepoFields(args);
    if (!args.githubOwner || !args.githubRepo) throw new Error("Choose a repository as owner/name");
    const now = Date.now();
    const existing = await projectGithubBinding(ctx, args.projectId);
    const binding = {
      githubOwner: args.githubOwner,
      githubRepo: args.githubRepo,
      githubBaseBranch: args.githubBaseBranch || undefined,
      updatedAt: now,
    };
    if (existing) {
      const updates = { ...binding, ...(existing.status === "disconnected" ? { status: "active" as const, errorMessage: undefined } : {}) };
      await ctx.db.patch(existing._id, updates);
      const changed = changedFields(existing as Record<string, unknown>, updates);
      if (changed.length) {
        await recordAudit(ctx, { action: "integration.update", target: existing.name, projectId: args.projectId, details: { changed } });
      }
      return existing._id;
    }
    const id = await ctx.db.insert("integrations", {
      projectId: args.projectId,
      type: "github",
      name: "GitHub",
      status: "active",
      createdAt: now,
      ...binding,
    });
    await recordAudit(ctx, {
      action: "integration.update",
      target: "GitHub",
      projectId: args.projectId,
      details: { changed: ["githubOwner", "githubRepo", ...(args.githubBaseBranch ? ["githubBaseBranch"] : [])] },
    });
    return id;
  },
});

// These values end up in git push URLs and GitHub API paths.
const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_NAME = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

function assertRepoFields(args: { githubOwner?: string; githubRepo?: string; githubBaseBranch?: string }): void {
  if (args.githubOwner !== undefined && args.githubOwner !== "" && !REPO_NAME.test(args.githubOwner)) {
    throw new Error("Invalid GitHub owner");
  }
  if (args.githubRepo !== undefined && args.githubRepo !== "" && !REPO_NAME.test(args.githubRepo)) {
    throw new Error("Invalid GitHub repository name");
  }
  if (args.githubBaseBranch !== undefined && args.githubBaseBranch !== "" && !BRANCH_NAME.test(args.githubBaseBranch)) {
    throw new Error("Invalid base branch name");
  }
}

/**
 * GitHub webhook receiver.
 *
 * Routes (http.ts): `POST /integrations/github/webhook/<integrationId>`
 * (per-integration secret, env fallback) and `POST
 * /integrations/github/webhook` (GITHUB_WEBHOOK_SECRET only; the
 * integration is found from the payload's repository AFTER verification).
 *
 * Order matters: the raw body is read once and the HMAC is checked BEFORE
 * the payload is parsed or trusted. No secret configured = 401 (fail
 * closed) with one warning per isolate. Deliveries are deduped on
 * `X-GitHub-Delivery`, so a replayed or retried delivery is acknowledged
 * and ignored.
 */
let warnedNoWebhookSecret = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const handleWebhook = httpAction(async (ctx, request) => {
  const signature = request.headers.get("x-hub-signature-256");
  const deliveryId = request.headers.get("x-github-delivery");
  const event = request.headers.get("x-github-event");
  const rawBody = await request.text();

  // The trailing path segment, when present, names the integration.
  const prefix = "/integrations/github/webhook";
  const rest = new URL(request.url).pathname.slice(prefix.length).replace(/^\/+|\/+$/g, "");
  const pathIntegrationId = rest.length > 0 ? rest : null;

  const target = pathIntegrationId
    ? await ctx.runQuery(internal.integrations.getWebhookTarget, { integrationId: pathIntegrationId })
    : null;
  if (pathIntegrationId && !target) {
    // Unknown id: same answer as a bad signature, so ids cannot be probed.
    return json({ error: "unauthorized" }, 401);
  }

  let secret: string | null = null;
  if (target?.secretCiphertext) {
    try {
      secret = await decryptApiKey(target.secretCiphertext, "GitHub webhook");
    } catch (error) {
      console.warn(`[webhook] cannot decrypt the webhook secret for integration ${target.integrationId}: ${error instanceof Error ? error.message : error}`);
      return json({ error: "unauthorized" }, 401);
    }
  }
  if (!secret) secret = process.env.GITHUB_WEBHOOK_SECRET?.trim() || null;
  if (!secret) {
    if (!warnedNoWebhookSecret) {
      warnedNoWebhookSecret = true;
      console.warn(
        "[webhook] GitHub webhook rejected: no webhook secret configured. Generate one in Integrations → GitHub, or set GITHUB_WEBHOOK_SECRET."
      );
    }
    return json({ error: "webhook secret not configured" }, 401);
  }

  const check = await verifyGithubSignature(secret, rawBody, signature);
  if (!check.ok) return json({ error: "unauthorized", reason: check.reason }, 401);

  // Verified from here on.
  if (!event) return json({ error: "missing x-github-event" }, 400);
  if (!deliveryId) return json({ error: "missing x-github-delivery" }, 400);
  if (event === "ping") return json({ ok: true, pong: true });

  let body: Record<string, any>;
  try {
    body = JSON.parse(rawBody) as Record<string, any>;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const repository: string | undefined = body.repository?.full_name;
  const resolved =
    target ??
    (repository
      ? await ctx.runQuery(internal.integrations.findWebhookTargetByRepo, { fullName: repository })
      : null);
  if (!resolved) return json({ ok: true, ignored: "no_matching_integration" });

  const { duplicate } = await ctx.runMutation(internal.integrations.recordWebhookDelivery, {
    integrationId: resolved.integrationId,
    projectId: resolved.projectId,
    deliveryId,
    eventType: event,
    summary: {
      action: typeof body.action === "string" ? body.action : undefined,
      repository,
      number: body.pull_request?.number ?? body.issue?.number,
      ref: typeof body.ref === "string" ? body.ref : undefined,
    },
    handled: HANDLED_GITHUB_EVENTS.has(event),
  });
  if (duplicate) return json({ ok: true, duplicate: true });

  // Post-push feedback loop: CI, reviews, review comments and PR state are
  // linked to the pushed PR and may queue a fix (prFeedback.ts).
  const signal = parsePrSignal(event, body);
  if (signal) {
    const result = await ctx.runMutation(internal.prFeedback.ingest, { projectId: resolved.projectId, signal });
    return json({ ok: true, linked: result.matched, reaction: result.reaction });
  }

  return json({ ok: true });
});

/** Resolve a webhook URL's integration id (untrusted input). */
export const getWebhookTarget = internalQuery({
  args: { integrationId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("integrations", args.integrationId);
    if (!id) return null;
    const integration = await ctx.db.get(id);
    if (!integration || integration.type !== "github" || integration.status === "disconnected") return null;
    return {
      integrationId: integration._id,
      projectId: integration.projectId,
      secretCiphertext: integration.webhookSecret ?? null,
    };
  },
});

/** Env-secret route: the integration whose selected repo matches. */
export const findWebhookTargetByRepo = internalQuery({
  args: { fullName: v.string() },
  handler: async (ctx, args) => {
    const [owner, repo] = args.fullName.split("/");
    if (!owner || !repo) return null;
    const rows = await ctx.db
      .query("integrations")
      .withIndex("by_type", (q) => q.eq("type", "github"))
      .collect();
    const match = rows.find(
      (row) =>
        row.status !== "disconnected" &&
        row.githubOwner?.toLowerCase() === owner.toLowerCase() &&
        row.githubRepo?.toLowerCase() === repo.toLowerCase()
    );
    return match ? { integrationId: match._id, projectId: match.projectId, secretCiphertext: null } : null;
  },
});

/**
 * Record one verified delivery, deduped on the delivery id. A mutation is
 * serializable, so two concurrent retries of one delivery cannot both
 * insert. Also prunes this integration's rows past the retention window.
 */
export const recordWebhookDelivery = internalMutation({
  args: {
    integrationId: v.id("integrations"),
    projectId: v.id("projects"),
    deliveryId: v.string(),
    eventType: v.string(),
    summary: v.any(),
    handled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const seen = await ctx.db
      .query("integrationEvents")
      .withIndex("by_delivery", (q) => q.eq("deliveryId", args.deliveryId))
      .first();
    if (seen) return { duplicate: true as const };
    const now = Date.now();
    await ctx.db.insert("integrationEvents", {
      integrationId: args.integrationId,
      projectId: args.projectId,
      eventType: args.eventType,
      // A slim summary only: full payloads can exceed the document limit.
      payload: args.summary,
      deliveryId: args.deliveryId,
      // Nothing consumes events yet (issue intake is a later step), so
      // they are recorded as processed rather than piling up as pending.
      status: "processed",
      ...(args.handled ? {} : { error: "event type not handled" }),
      createdAt: now,
      processedAt: now,
    });
    const stale = await ctx.db
      .query("integrationEvents")
      .withIndex("by_integration", (q) => q.eq("integrationId", args.integrationId))
      .order("asc")
      .take(25);
    for (const row of stale) {
      if (row.createdAt >= now - WEBHOOK_DELIVERY_RETENTION_MS) break;
      await ctx.db.delete(row._id);
    }
    return { duplicate: false as const };
  },
});

/** The webhook URL to paste into GitHub (Convex serves HTTP actions on the site URL). */
function webhookUrlFor(integrationId: string): string | null {
  const site = process.env.CONVEX_SITE_URL?.replace(/\/$/, "");
  return site ? `${site}/integrations/github/webhook/${integrationId}` : null;
}

/**
 * What the Integrations UI shows for webhook setup. Never the secret: only
 * whether one is set, when, and whether the env fallback exists.
 */
export const getWebhookSetup = query({
  args: { integrationId: v.id("integrations") },
  handler: async (ctx, args) => {
    const integration = await ctx.db.get(args.integrationId);
    if (!integration) return null;
    await assertProjectAccess(ctx, integration.projectId);
    return {
      webhookUrl: webhookUrlFor(integration._id),
      hasSecret: Boolean(integration.webhookSecret),
      secretSetAt: integration.webhookSecretSetAt ?? null,
      envFallback: Boolean(process.env.GITHUB_WEBHOOK_SECRET?.trim()),
      canEncrypt: Boolean(process.env.PROVIDER_ENCRYPTION_KEY?.trim()),
    };
  },
});

/**
 * Generate (or rotate) this integration's webhook secret. An ACTION so the
 * secret comes from real randomness; the plaintext is returned ONCE and
 * only its ciphertext is stored.
 */
export const generateWebhookSecret = action({
  args: { integrationId: v.id("integrations") },
  handler: async (ctx, args): Promise<{ secret: string; webhookUrl: string | null }> => {
    await ctx.runQuery(internal.integrations.getForWebhookSecret, { integrationId: args.integrationId });
    const secret = generateWebhookSecretValue();
    let ciphertext: string;
    try {
      ciphertext = await encryptApiKey(secret);
    } catch {
      throw new Error(
        "PROVIDER_ENCRYPTION_KEY is not set on the Convex deployment, so a per-integration secret cannot be stored. Set it, or use GITHUB_WEBHOOK_SECRET instead."
      );
    }
    await ctx.runMutation(internal.integrations.storeWebhookSecret, {
      integrationId: args.integrationId,
      ciphertext,
    });
    return { secret, webhookUrl: webhookUrlFor(args.integrationId) };
  },
});

export const getForWebhookSecret = internalQuery({
  args: { integrationId: v.id("integrations") },
  handler: async (ctx, args) => {
    const integration = await ctx.db.get(args.integrationId);
    if (!integration) throw new Error("Integration not found");
    await assertProjectAccess(ctx, integration.projectId);
    if (integration.type !== "github") throw new Error("Not a GitHub integration");
    return { ok: true };
  },
});

export const storeWebhookSecret = internalMutation({
  args: { integrationId: v.id("integrations"), ciphertext: v.string() },
  handler: async (ctx, args) => {
    const integration = await ctx.db.get(args.integrationId);
    if (!integration) throw new Error("Integration not found");
    const now = Date.now();
    await ctx.db.patch(args.integrationId, { webhookSecret: args.ciphertext, webhookSecretSetAt: now, updatedAt: now });
    // The secret never reaches the audit row.
    await recordAudit(ctx, {
      action: "integration.update",
      target: integration.name,
      projectId: integration.projectId,
      details: { changed: ["webhookSecret"] },
    });
  },
});

/**
 * List integrations for a project
 */
export const listByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const integrations = await ctx.db
      .query("integrations")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    // Mask sensitive data
    return integrations.map((integration) => ({
      _id: integration._id,
      projectId: integration.projectId,
      type: integration.type,
      name: integration.name,
      status: integration.status,
      errorMessage: integration.errorMessage,
      lastSyncAt: integration.lastSyncAt,
      createdAt: integration.createdAt,
      updatedAt: integration.updatedAt,
      // Repository selection (plan 019) — not credential material.
      githubOwner: integration.githubOwner,
      githubRepo: integration.githubRepo,
      githubBaseBranch: integration.githubBaseBranch,
      // Don't expose access tokens
      hasAccessToken: !!integration.accessToken,
      hasWebhookSecret: !!integration.webhookSecret,
    }));
  },
});

/**
 * Get a specific integration
 */
export const get = query({
  args: { integrationId: v.id("integrations") },
  handler: async (ctx, args) => {
    const integration = await ctx.db.get(args.integrationId);
    if (!integration) return null;
    await assertProjectAccess(ctx, integration.projectId);

    const {
      accessToken: _a,
      refreshToken: _r,
      webhookSecret: _w,
      config: _c,
      ...rest
    } = integration as any;
    return {
      ...rest,
      hasAccessToken: !!integration.accessToken,
    };
  },
});

/**
 * Unbind a project's repository (per-project row): clears the binding's
 * webhook secret and any legacy token. The account-level connection is
 * untouched; use `disconnectGithub` for that.
 */
export const remove = mutation({
  args: { integrationId: v.id("integrations") },
  handler: async (ctx, args) => {
    const integration = await ctx.db.get(args.integrationId);
    if (!integration) throw new Error("Integration not found");
    await assertProjectAccess(ctx, integration.projectId);

    // Mark as disconnected instead of deleting to preserve audit trail
    await ctx.db.patch(args.integrationId, {
      status: "disconnected",
      accessToken: undefined,
      refreshToken: undefined,
      webhookSecret: undefined,
      webhookSecretSetAt: undefined,
      updatedAt: Date.now(),
    });
    await recordAudit(ctx, {
      action: "integration.remove",
      target: integration.name,
      projectId: integration.projectId,
    });
    // GitHub MCP servers that borrowed this token lose it too.
    await syncGithubOAuthEnv(ctx, integration.projectId);
  },
});

/**
 * Re-check the account-level GitHub connection: fetch the login and record
 * the outcome. An ACTION (queries and mutations cannot do network I/O).
 */
export const refresh = action({
  args: {},
  handler: async (ctx): Promise<{ status: "active"; login?: string }> => {
    const target = await ctx.runQuery(internal.integrations.getTokenForUse, {});
    let login: string | undefined;
    try {
      const userResponse = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${target.accessToken}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (!userResponse.ok) {
        throw new Error(`GitHub API error: ${userResponse.status}`);
      }
      const user = (await userResponse.json()) as { login?: string; name?: string };
      login = user.login;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await ctx.runMutation(internal.integrations.recordRefreshResult, { ok: false, errorMessage: message });
      throw error;
    }
    await ctx.runMutation(internal.integrations.recordRefreshResult, { ok: true, login });
    return { status: "active", login };
  },
});

/**
 * Authorize a GitHub API call and hand the action the token (internal only).
 * With a project: project access + that project's resolved token (global,
 * legacy fallback). Without: registry access + the account-level token.
 */
export const getTokenForUse = internalQuery({
  args: { projectId: v.optional(v.id("projects")) },
  handler: async (ctx, args) => {
    if (args.projectId) await assertProjectAccess(ctx, args.projectId);
    else await assertRegistryWriteAccess(ctx);
    const resolved = await resolveGithubToken(ctx, args.projectId);
    if (!resolved) throw new Error("GitHub is not connected. Connect it in Integrations.");
    return { accessToken: resolved.token, source: resolved.source };
  },
});

export const recordRefreshResult = internalMutation({
  args: {
    ok: v.boolean(),
    login: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Legacy-only deployments (not migrated) have no global row to update.
    const global = await globalGithubConnection(ctx);
    if (!global || global.status === "disconnected") return;
    const now = Date.now();
    if (args.ok) {
      await ctx.db.patch(global._id, {
        ...(args.login ? { login: args.login } : {}),
        status: "active",
        errorMessage: undefined,
        lastSyncAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(global._id, { status: "error", errorMessage: args.errorMessage, updatedAt: now });
    }
  },
});

/**
 * Repositories the connected GitHub account can push to (repo picker).
 * Uses the account-level token; reads it through the access-checked
 * internal query.
 */
export const listGithubRepos = action({
  args: { projectId: v.optional(v.id("projects")) },
  handler: async (
    ctx,
    args
  ): Promise<Array<{ fullName: string; owner: string; name: string; defaultBranch: string; private: boolean }>> => {
    const target = await ctx.runQuery(internal.integrations.getTokenForUse, { projectId: args.projectId });
    const response = await fetch(
      "https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
      {
        headers: {
          Authorization: `Bearer ${target.accessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
    if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
    const repos = (await response.json()) as Array<{
      full_name: string;
      name: string;
      owner?: { login?: string };
      default_branch?: string;
      private?: boolean;
      permissions?: { push?: boolean };
    }>;
    return repos
      .filter((repo) => repo.permissions?.push !== false)
      .map((repo) => ({
        fullName: repo.full_name,
        owner: repo.owner?.login ?? repo.full_name.split("/")[0],
        name: repo.name,
        defaultBranch: repo.default_branch ?? "main",
        private: Boolean(repo.private),
      }));
  },
});

/**
 * Update integration config (e.g., selected repository)
 */
export const updateConfig = mutation({
  args: {
    integrationId: v.id("integrations"),
    githubOwner: v.optional(v.string()),
    githubRepo: v.optional(v.string()),
    githubBaseBranch: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const integration = await ctx.db.get(args.integrationId);
    if (!integration) throw new Error("Integration not found");
    await assertProjectAccess(ctx, integration.projectId);

    const updates: Record<string, unknown> = {
      updatedAt: Date.now(),
    };
    assertRepoFields(args);

    if (args.githubOwner !== undefined) updates.githubOwner = args.githubOwner || undefined;
    if (args.githubRepo !== undefined) updates.githubRepo = args.githubRepo || undefined;
    if (args.githubBaseBranch !== undefined) updates.githubBaseBranch = args.githubBaseBranch || undefined;

    await ctx.db.patch(args.integrationId, updates);
    const changed = changedFields(integration as Record<string, unknown>, updates);
    if (changed.length) {
      await recordAudit(ctx, {
        action: "integration.update",
        target: integration.name,
        projectId: integration.projectId,
        details: { changed },
      });
    }
  },
});

/**
 * Create a GitHub MCP server configuration for the worker.
 *
 * INTERNAL ONLY: the result carries the plaintext `GITHUB_TOKEN`. A public
 * query must never return credential material (AGENTS.md rule 1). The worker
 * reads this through a `workerToken`-gated action in `worker.ts`.
 */
export const getMcpConfig = internalQuery({
  args: { integrationId: v.id("integrations") },
  handler: async (ctx, args) => {
    const integration = await ctx.db.get(args.integrationId);
    if (!integration) throw new Error("Integration not found");
    if (integration.status !== "active") throw new Error("Integration not active");
    // Account-level token (legacy project token until migrated).
    const resolved = await resolveGithubToken(ctx, integration.projectId);
    if (!resolved) throw new Error("No access token");

    return {
      type: "github",
      // The worker will use these to spawn the MCP server
      env: {
        GITHUB_TOKEN: resolved.token,
      },
      // Tool allowlist for this integration
      allowedTools: [
        "github_repos_list",
        "github_repo_get",
        "github_issues_list",
        "github_issues_create",
        "github_pulls_list",
        "github_pulls_create",
        "github_pulls_get",
        "github_pulls_review",
        "github_code_search",
        "github_file_get",
        "github_file_create",
        "github_file_update",
      ],
      config: {
        owner: integration.githubOwner,
        repo: integration.githubRepo,
      },
    };
  },
});
