/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { decryptApiKey } from "./lib/llmCrypto";
import {
  OAUTH_STATE_MAX_AGE_MS,
  appOrigin,
  newOAuthNonce,
  safeReturnTo,
  signOAuthState,
  verifyOAuthState,
} from "./lib/oauthState";

/**
 * Account-level GitHub connection + signed one-time OAuth state.
 */

const modules = import.meta.glob("./**/*.ts");
// 32 zero bytes, base64 — test-only key.
const TEST_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const STATE_SECRET = "state-secret-for-tests-0123456789";
const SERVICE_TOKEN = "test-service-token-global";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const ENV_KEYS = [
  "PROVIDER_ENCRYPTION_KEY",
  "OAUTH_STATE_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_OAUTH_CALLBACK_URL",
  "APP_ORIGIN",
  "CONVEX_SERVICE_TOKEN",
];

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.PROVIDER_ENCRYPTION_KEY = TEST_KEY;
  process.env.OAUTH_STATE_SECRET = STATE_SECRET;
  process.env.GITHUB_CLIENT_ID = "client-id";
  process.env.GITHUB_CLIENT_SECRET = "client-secret";
  process.env.GITHUB_OAUTH_CALLBACK_URL = "https://app.example.com/api/integrations/github/callback";
  delete process.env.APP_ORIGIN;
  process.env.CONVEX_SERVICE_TOKEN = SERVICE_TOKEN;
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function githubFetchStub(token = "gho_from_oauth", login = "octo") {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: token }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.startsWith("https://api.github.com/user")) {
      return new Response(JSON.stringify({ login }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function startState(t: ReturnType<typeof convexTest>): Promise<string> {
  const url = await t.action(api.integrations.getOAuthUrl, { returnTo: "/integrations" });
  expect(url).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  return new URL(url!).searchParams.get("state")!;
}

describe("signed OAuth state (lib)", () => {
  test("sign → verify round trip", async () => {
    const nonce = newOAuthNonce();
    const state = await signOAuthState({ v: 1, p: "github", n: nonce, iat: Date.now() }, STATE_SECRET);
    expect(state.split(".")).toHaveLength(2);
    const result = await verifyOAuthState(state, STATE_SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.n).toBe(nonce);
  });

  test("tampered payload, tampered signature and wrong secret are rejected", async () => {
    const state = await signOAuthState({ v: 1, p: "github", n: newOAuthNonce(), iat: Date.now() }, STATE_SECRET);
    const [body, sig] = state.split(".");
    const forgedBody = btoa(JSON.stringify({ v: 1, p: "github", n: newOAuthNonce(), iat: Date.now() }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifyOAuthState(`${forgedBody}.${sig}`, STATE_SECRET)).toEqual({ ok: false, reason: "bad_signature" });
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    expect(await verifyOAuthState(`${body}.${flipped}`, STATE_SECRET)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyOAuthState(`${body}.${sig}`, "another-secret")).toEqual({ ok: false, reason: "bad_signature" });
    // The old unsigned format (bare base64url JSON) is no longer accepted.
    expect((await verifyOAuthState(body, STATE_SECRET)).ok).toBe(false);
    expect((await verifyOAuthState(`${body}.${sig}.x`, STATE_SECRET)).ok).toBe(false);
  });

  test("expired and future-dated states are rejected", async () => {
    const old = await signOAuthState(
      { v: 1, p: "github", n: newOAuthNonce(), iat: Date.now() - OAUTH_STATE_MAX_AGE_MS - 1000 },
      STATE_SECRET
    );
    expect(await verifyOAuthState(old, STATE_SECRET)).toEqual({ ok: false, reason: "expired" });
    const future = await signOAuthState({ v: 1, p: "github", n: newOAuthNonce(), iat: Date.now() + 10 * 60_000 }, STATE_SECRET);
    expect(await verifyOAuthState(future, STATE_SECRET)).toEqual({ ok: false, reason: "expired" });
  });

  test("returnTo stays same-app; postMessage origin derives from env", () => {
    expect(safeReturnTo("/integrations")).toBe("/integrations");
    expect(safeReturnTo("//evil.example")).toBeUndefined();
    expect(safeReturnTo("https://evil.example")).toBeUndefined();
    expect(appOrigin()).toBe("https://app.example.com");
    process.env.APP_ORIGIN = "https://moagent.example.org/some/path";
    expect(appOrigin()).toBe("https://moagent.example.org");
  });
});

describe("OAuth callback", () => {
  test("a valid state connects the global account once; reuse is rejected", async () => {
    const t = convexTest(schema, modules);
    const fetchStub = githubFetchStub();
    const state = await startState(t);

    const ok = await t.fetch(`/integrations/github/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain('"https://app.example.com"');
    expect(html).not.toContain('"*"');
    expect(fetchStub).toHaveBeenCalled();

    const global = await t.run((ctx) => ctx.db.query("githubConnections").collect());
    expect(global).toHaveLength(1);
    expect(global[0].login).toBe("octo");
    expect(global[0].status).toBe("active");
    expect(await decryptApiKey(global[0].accessTokenCiphertext!, "t")).toBe("gho_from_oauth");

    // Same state again: the nonce is consumed.
    const calls = fetchStub.mock.calls.length;
    const reused = await t.fetch(`/integrations/github/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(reused.status).toBe(400);
    expect(fetchStub.mock.calls.length).toBe(calls); // no code exchange attempted
  });

  test("tampered, unknown-nonce and expired states never reach GitHub", async () => {
    const t = convexTest(schema, modules);
    const fetchStub = githubFetchStub();
    const state = await startState(t);
    const [body, sig] = state.split(".");

    const tampered = await t.fetch(`/integrations/github/callback?code=abc&state=${encodeURIComponent(`${body}x.${sig}`)}`);
    expect(tampered.status).toBe(400);

    // Correctly signed, but the nonce was never issued by getOAuthUrl.
    const unknown = await signOAuthState({ v: 1, p: "github", n: newOAuthNonce(), iat: Date.now() }, STATE_SECRET);
    const unknownRes = await t.fetch(`/integrations/github/callback?code=abc&state=${encodeURIComponent(unknown)}`);
    expect(unknownRes.status).toBe(400);

    // Issued nonce whose row is past max age (signature still fresh).
    await t.run(async (ctx) => {
      const row = await ctx.db.query("oauthStates").first();
      await ctx.db.patch(row!._id, { createdAt: Date.now() - OAUTH_STATE_MAX_AGE_MS - 1000 });
    });
    const expired = await t.fetch(`/integrations/github/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(expired.status).toBe(400);
    expect(await expired.text()).toMatch(/expired/);

    expect(fetchStub).not.toHaveBeenCalled();
    expect(await t.run((ctx) => ctx.db.query("githubConnections").collect())).toHaveLength(0);
  });

  test("old nonce rows are pruned when a new state is created", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("oauthStates", { nonce: "stale-nonce-0000000000", provider: "github", createdAt: Date.now() - 2 * 60 * 60_000 });
    });
    await startState(t);
    const rows = await t.run((ctx) => ctx.db.query("oauthStates").collect());
    expect(rows.map((row) => row.nonce)).not.toContain("stale-nonce-0000000000");
    expect(rows).toHaveLength(1);
  });

  test("getOAuthUrl refuses an anonymous caller once projects are owned", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) => ctx.db.insert("projects", { name: "Owned", workspacePath: "/tmp/o", ownerId: "user-1" }));
    await expect(t.action(api.integrations.getOAuthUrl, {})).rejects.toThrow(/Unauthorized/);
    const asOwner = t.withIdentity({ subject: "user-1" });
    expect(await asOwner.action(api.integrations.getOAuthUrl, {})).toMatch(/^https:\/\/github\.com/);
  });
});

async function seedLegacy(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const projectA = await ctx.db.insert("projects", { name: "A", workspacePath: "/tmp/a", mainBranch: "main" });
    const projectB = await ctx.db.insert("projects", { name: "B", workspacePath: "/tmp/b", mainBranch: "main" });
    const rowA = await ctx.db.insert("integrations", {
      projectId: projectA,
      type: "github",
      name: "GitHub",
      accessToken: "gho_older",
      status: "active",
      githubOwner: "acme",
      githubRepo: "a",
      createdAt: 1,
      updatedAt: 100,
    });
    const rowB = await ctx.db.insert("integrations", {
      projectId: projectB,
      type: "github",
      name: "GitHub",
      accessToken: "gho_newer",
      status: "active",
      githubOwner: "acme",
      githubRepo: "b",
      githubBaseBranch: "develop",
      createdAt: 1,
      updatedAt: 200,
    });
    return { projectA, projectB, rowA, rowB };
  });
}

describe("migration to the global connection", () => {
  test("promotes the most recently updated connected row, keeps bindings, and is idempotent", async () => {
    const t = convexTest(schema, modules);
    const { rowA, rowB } = await seedLegacy(t);

    const first = await t.mutation(internal.integrations.migrateGithubToGlobal, {});
    expect(first).toMatchObject({ globalExisted: false, promotedFrom: rowB, legacyTokensCleared: 2, repoBindingsKept: 2 });

    const global = await t.run((ctx) => ctx.db.query("githubConnections").collect());
    expect(global).toHaveLength(1);
    expect(global[0].migratedFromIntegrationId).toBe(rowB);
    expect(await decryptApiKey(global[0].accessTokenCiphertext!, "t")).toBe("gho_newer");

    const a = await t.run((ctx) => ctx.db.get(rowA));
    const b = await t.run((ctx) => ctx.db.get(rowB));
    expect(a?.accessToken).toBeUndefined();
    expect(b?.accessToken).toBeUndefined();
    expect([a?.githubOwner, a?.githubRepo]).toEqual(["acme", "a"]);
    expect([b?.githubOwner, b?.githubRepo, b?.githubBaseBranch]).toEqual(["acme", "b", "develop"]);

    const second = await t.mutation(internal.integrations.migrateGithubToGlobal, {});
    expect(second).toMatchObject({ globalExisted: true, promotedFrom: null, legacyTokensCleared: 0 });
    expect(await t.run((ctx) => ctx.db.query("githubConnections").collect())).toHaveLength(1);
  });

  test("nothing to promote: no global row is created", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(internal.integrations.migrateGithubToGlobal, {});
    expect(result).toMatchObject({ globalExisted: false, promotedFrom: null, legacyTokensCleared: 0 });
    expect(await t.run((ctx) => ctx.db.query("githubConnections").collect())).toHaveLength(0);
  });
});

async function seedPush(t: ReturnType<typeof convexTest>, projectId: any) {
  return await t.run(async (ctx) => {
    const conversationId = await ctx.db.insert("conversations", { projectId, status: "active", createdAt: Date.now() });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "Ship it",
      command: "ship it",
      status: "running",
      workerId: "w1",
      leaseExpiresAt: Date.now() + 60_000,
      conversationId,
    });
    return { taskId };
  });
}

async function claimToken(t: ReturnType<typeof convexTest>, projectId: any): Promise<{ token: string; owner: string; repo: string }> {
  const { taskId } = await seedPush(t, projectId);
  const { pushId } = (await t.mutation(internal.githubPush.recordTaskCommit, {
    taskId,
    projectId,
    workerId: "w1",
    branchName: "moagent/t/ship-it",
    commitSha: SHA,
    commitMessage: "MOAgent: Ship it",
    filesChanged: 1,
  })) as any;
  await t.mutation(api.githubPush.requestPush, { pushId, openPr: false });
  const claimed = await t.mutation(internal.githubPush.claimPushRequest, { workerId: "w1" });
  expect(claimed).not.toBeNull();
  return { token: claimed!.token, owner: claimed!.owner, repo: claimed!.repo };
}

describe("token resolution for pushes", () => {
  test("a project push uses the global token with the project's own repo binding", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run((ctx) => ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", mainBranch: "main" }));
    await t.mutation(internal.integrations.upsertGithubIntegration, { accessToken: "gho_global", login: "octo" });
    await t.mutation(api.integrations.bindRepo, { projectId, githubOwner: "acme", githubRepo: "app" });

    const binding = await t.run((ctx) =>
      ctx.db.query("integrations").withIndex("by_project", (q) => q.eq("projectId", projectId)).first()
    );
    expect(binding?.accessToken).toBeUndefined();
    expect(await claimToken(t, projectId)).toEqual({ token: "gho_global", owner: "acme", repo: "app" });

    const account = await t.query(api.integrations.githubAccount, {});
    expect(account).toMatchObject({ connected: true, source: "global", login: "octo" });
    expect(JSON.stringify(account)).not.toContain("gho_global");
  });

  test("legacy per-project token is used until migrated", async () => {
    const t = convexTest(schema, modules);
    const { projectB } = await seedLegacy(t);
    expect((await t.query(api.integrations.githubAccount, {})).source).toBe("legacy");
    expect(await claimToken(t, projectB)).toEqual({ token: "gho_newer", owner: "acme", repo: "b" });
  });

  test("a global disconnect stops pushes and never falls back to legacy tokens", async () => {
    const t = convexTest(schema, modules);
    const { projectA } = await seedLegacy(t);
    await t.mutation(api.integrations.disconnectGithub, {});
    expect((await t.query(api.integrations.githubAccount, {})).connected).toBe(false);
    const { taskId } = await seedPush(t, projectA);
    const { pushId } = (await t.mutation(internal.githubPush.recordTaskCommit, {
      taskId,
      projectId: projectA,
      workerId: "w1",
      branchName: "moagent/t/ship-it",
      commitSha: SHA,
      commitMessage: "MOAgent: Ship it",
      filesChanged: 1,
    })) as any;
    await expect(t.mutation(api.githubPush.requestPush, { pushId, openPr: false })).rejects.toThrow(/Connect GitHub/);
    const rows = await t.run((ctx) => ctx.db.query("integrations").collect());
    expect(rows.every((row) => row.accessToken === undefined)).toBe(true);
    expect(rows.every((row) => row.githubRepo)).toBe(true);
  });

  test("manual token path writes the global connection and creates the project binding", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run((ctx) => ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" }));
    const id = await t.mutation(internal.integrations.upsertGithubIntegration, { projectId, accessToken: "gho_manual" });
    const stored = await t.run((ctx) => ctx.db.get(id));
    expect(stored?.scope).toBe("global");
    expect(await decryptApiKey(stored!.accessTokenCiphertext!, "t")).toBe("gho_manual");
    const binding = await t.run((ctx) =>
      ctx.db.query("integrations").withIndex("by_project", (q) => q.eq("projectId", projectId)).first()
    );
    expect(binding?.status).toBe("active");
    expect(binding?.accessToken).toBeUndefined();
  });
});
