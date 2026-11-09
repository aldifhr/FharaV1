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
import { assertProjectAccess } from "./lib/authz";
import { changedFields, recordAudit } from "./lib/recordAudit";
import { syncGithubOAuthEnv } from "./mcpServers";
import { decryptApiKey, encryptApiKey } from "./lib/llmCrypto";
import {
  HANDLED_GITHUB_EVENTS,
  WEBHOOK_DELIVERY_RETENTION_MS,
  generateWebhookSecretValue,
  verifyGithubSignature,
} from "./lib/githubWebhook";

// GitHub OAuth configuration
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? "";
const GITHUB_OAUTH_CALLBACK_URL =
  process.env.GITHUB_OAUTH_CALLBACK_URL ?? "http://localhost:3000/api/integrations/github/callback";

// Convex runs in a V8 isolate without the Node `Buffer` global, so the
// OAuth `state` uses Web-standard base64url via btoa/atob + TextEncoder.
function encodeOAuthState(payload: { projectId: string; timestamp: number }): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeOAuthState(state: string): { projectId: string; timestamp: number } {
  const base64 = state.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Start GitHub OAuth flow - returns the authorization URL
 */
export const getOAuthUrl = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<string | null> => {
    await assertProjectAccess(ctx, args.projectId);
    // No OAuth app configured on this deployment: the UI says so instead
    // of opening a GitHub page that rejects an empty client id.
    if (!GITHUB_CLIENT_ID) return null;
    const state = encodeOAuthState({ projectId: args.projectId, timestamp: Date.now() });

    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: GITHUB_OAUTH_CALLBACK_URL,
      scope: "repo read:user write:repo_hook",
      state,
    });

    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  },
});

const OAUTH_STATE_MAX_AGE_MS = 15 * 60_000;

/** Escape a value for HTML text and for a JS string inside a <script>. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Handle GitHub OAuth callback - exchange code for access token
 */
export const handleOAuthCallback = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(
      `<html><body>
        <h1>GitHub OAuth Error</h1>
        <p>${escapeHtml(error)}</p>
        <p>${escapeHtml(url.searchParams.get("error_description") ?? "")}</p>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: "github_oauth_error", error: ${JSON.stringify(escapeHtml(error))} }, "*");
            window.close();
          }
        </script>
      </body></html>`,
      { headers: { "Content-Type": "text/html" } }
    );
  }

  if (!code || !state) {
    return new Response("Missing code or state parameter", { status: 400 });
  }

  // Decode state to get projectId
  let projectId: string;
  try {
    const decoded = decodeOAuthState(state);
    projectId = decoded.projectId;
    if (typeof projectId !== "string" || typeof decoded.timestamp !== "number") throw new Error("bad state");
    if (Date.now() - decoded.timestamp > OAUTH_STATE_MAX_AGE_MS) {
      return new Response("OAuth state expired; start the GitHub connection again", { status: 400 });
    }
  } catch {
    return new Response("Invalid state parameter", { status: 400 });
  }

  // Exchange code for access token
  const tokenResponse = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: GITHUB_OAUTH_CALLBACK_URL,
      }),
    }
  );

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };

  if (tokenData.error || !tokenData.access_token) {
    return new Response(
      `<html><body>
        <h1>Token Exchange Error</h1>
        <p>${escapeHtml(tokenData.error ?? "Failed to get access token")}</p>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: "github_oauth_error", error: ${JSON.stringify(escapeHtml(tokenData.error ?? "token_exchange_failed"))} }, "*");
            window.close();
          }
        </script>
      </body></html>`,
      { headers: { "Content-Type": "text/html" } }
    );
  }

  // Store the integration
  const integrationId = await ctx.runMutation(
    internal.integrations.upsertGithubIntegration,
    {
      projectId: projectId as any,
      accessToken: tokenData.access_token!,
      refreshToken: tokenData.refresh_token,
      expiresIn: tokenData.expires_in,
    }
  );

  return new Response(
    `<html><body>
      <h1>GitHub Connected!</h1>
      <p>Redirecting...</p>
      <script>
        if (window.opener) {
          window.opener.postMessage({ 
            type: "github_oauth_success",
            integrationId: ${JSON.stringify(String(integrationId))}
          }, "*");
          setTimeout(() => window.close(), 1000);
        }
      </script>
    </body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
});

/**
 * Internal mutation to upsert GitHub integration
 */
export const upsertGithubIntegration = internalMutation({
  args: {
    projectId: v.id("projects"),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    expiresIn: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Check if integration already exists for this project
    const existing = await ctx.db
      .query("integrations")
      .withIndex("by_project_and_type", (q) =>
        q.eq("projectId", args.projectId).eq("type", "github")
      )
      .first();

    const now = Date.now();
    const tokenExpiresAt = args.expiresIn
      ? now + args.expiresIn * 1000
      : undefined;

    if (existing) {
      // Update existing integration
      await ctx.db.patch(existing._id, {
        accessToken: args.accessToken,
        refreshToken: args.refreshToken,
        tokenExpiresAt,
        status: "active",
        errorMessage: undefined,
        updatedAt: now,
      });
      // Token values never reach the audit row.
      await recordAudit(ctx, {
        action: "integration.reconnect",
        target: "github",
        projectId: args.projectId,
        details: { changed: ["accessToken", ...(args.refreshToken ? ["refreshToken"] : [])] },
      });
      await syncGithubOAuthEnv(ctx, args.projectId);
      return existing._id;
    }

    // Create new integration
    const id = await ctx.db.insert("integrations", {
      projectId: args.projectId,
      type: "github",
      name: "GitHub",
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      tokenExpiresAt,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await recordAudit(ctx, { action: "integration.add", target: "github", projectId: args.projectId });
    await syncGithubOAuthEnv(ctx, args.projectId);

    return id;
  },
});

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
 * Delete/disconnect an integration
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
 * Refresh GitHub integration - re-fetch user info and update integration.
 *
 * An ACTION (core H8): queries and mutations cannot do network I/O, so the
 * old mutation threw on every `fetch` and rolled its own error patch back.
 * The action authorizes and reads the token through an internal query, calls
 * GitHub, then records the outcome through an internal mutation.
 */
export const refresh = action({
  args: { integrationId: v.id("integrations") },
  handler: async (ctx, args): Promise<{ status: "active"; githubOwner?: string }> => {
    const target = await ctx.runQuery(internal.integrations.getForRefresh, {
      integrationId: args.integrationId,
    });

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
      await ctx.runMutation(internal.integrations.recordRefreshResult, {
        integrationId: args.integrationId,
        ok: false,
        errorMessage: message,
      });
      throw error;
    }
    await ctx.runMutation(internal.integrations.recordRefreshResult, {
      integrationId: args.integrationId,
      ok: true,
      githubOwner: login,
    });
    return { status: "active", githubOwner: login };
  },
});

/** Authorize a refresh and hand the action the token (internal only). */
export const getForRefresh = internalQuery({
  args: { integrationId: v.id("integrations") },
  handler: async (ctx, args) => {
    const integration = await ctx.db.get(args.integrationId);
    if (!integration) throw new Error("Integration not found");
    await assertProjectAccess(ctx, integration.projectId);
    if (integration.type !== "github") throw new Error("Not a GitHub integration");
    if (!integration.accessToken) throw new Error("No access token");
    return { accessToken: integration.accessToken };
  },
});

export const recordRefreshResult = internalMutation({
  args: {
    integrationId: v.id("integrations"),
    ok: v.boolean(),
    githubOwner: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const integration = await ctx.db.get(args.integrationId);
    if (!integration) return;
    const now = Date.now();
    if (args.ok) {
      await ctx.db.patch(args.integrationId, {
        // githubOwner doubles as the selected repository's owner (plan 019):
        // once a repository is chosen, the account login must not replace it.
        ...(args.githubOwner !== undefined && !integration.githubRepo ? { githubOwner: args.githubOwner } : {}),
        status: "active",
        errorMessage: undefined,
        lastSyncAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(args.integrationId, {
        status: "error",
        errorMessage: args.errorMessage,
        updatedAt: now,
      });
    }
  },
});

/**
 * Repositories the connected GitHub account can push to (plan 019 repo
 * picker). Reads the token through the access-checked internal query.
 */
export const listGithubRepos = action({
  args: { integrationId: v.id("integrations") },
  handler: async (
    ctx,
    args
  ): Promise<Array<{ fullName: string; owner: string; name: string; defaultBranch: string; private: boolean }>> => {
    const target = await ctx.runQuery(internal.integrations.getForRefresh, {
      integrationId: args.integrationId,
    });
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

    // These values end up in git push URLs and GitHub API paths.
    const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
    const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
    if (args.githubOwner !== undefined && args.githubOwner !== "" && !NAME.test(args.githubOwner)) {
      throw new Error("Invalid GitHub owner");
    }
    if (args.githubRepo !== undefined && args.githubRepo !== "" && !NAME.test(args.githubRepo)) {
      throw new Error("Invalid GitHub repository name");
    }
    if (args.githubBaseBranch !== undefined && args.githubBaseBranch !== "" && !BRANCH.test(args.githubBaseBranch)) {
      throw new Error("Invalid base branch name");
    }

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
    if (!integration.accessToken) throw new Error("No access token");

    return {
      type: "github",
      // The worker will use these to spawn the MCP server
      env: {
        GITHUB_TOKEN: integration.accessToken,
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
