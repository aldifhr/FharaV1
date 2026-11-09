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

// GitHub OAuth configuration
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? "";
const GITHUB_OAUTH_CALLBACK_URL =
  process.env.GITHUB_OAUTH_CALLBACK_URL ?? "http://localhost:3000/api/integrations/github/callback";

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
    const state = Buffer.from(
      JSON.stringify({ projectId: args.projectId, timestamp: Date.now() })
    ).toString("base64url");

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
    const decoded = JSON.parse(Buffer.from(state, "base64url").toString());
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

    return id;
  },
});

/**
 * Handle GitHub webhook events
 */
export const handleWebhook = httpAction(async (ctx, request) => {
  const signature = request.headers.get("x-hub-signature-256");
  const deliveryId = request.headers.get("x-github-delivery");
  const event = request.headers.get("x-github-event");

  // TODO: Verify webhook signature using webhook secret stored per integration
  // For now, we'll handle this in a follow-up with per-integration secrets

  const body = (await request.json()) as Record<string, any>;

  // Find integration by repository info in the webhook payload
  // This is a simplified version - in production you'd use the delivery ID
  // to look up the correct integration

  // Insert the event for async processing
  // For now, we'll process synchronously for certain events
  if (event === "pull_request" || event === "push" || event === "issues") {
    // Store event for async processing
    // In production, you'd queue this to a background job
    console.log(`GitHub webhook event: ${event}`, {
      deliveryId,
      action: body.action,
      repository: body.repository?.full_name,
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
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
      updatedAt: Date.now(),
    });
    await recordAudit(ctx, {
      action: "integration.remove",
      target: integration.name,
      projectId: integration.projectId,
    });
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
