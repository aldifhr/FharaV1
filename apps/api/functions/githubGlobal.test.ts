/// <reference types="vite/client" />
import { runtimeTest } from "@fhara/runtime/test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "@fhara/runtime/api";
import schema from "./schema";
import { decryptApiKey } from "./lib/llmCrypto";

/**
 * Plan 079: GitHub is connected from the local Git credential helper.
 * The account-level connection is still one per deployment, and the
 * encrypted token still resolves to a project's own repo binding.
 */

const modules = import.meta.glob("./**/*.ts");
// 32 zero bytes, base64 — test-only key.
const TEST_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const SERVICE_TOKEN = "test-service-token-global";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const ENV_KEYS = ["PROVIDER_ENCRYPTION_KEY", "FHARA_SERVICE_TOKEN"];

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.PROVIDER_ENCRYPTION_KEY = TEST_KEY;
  process.env.FHARA_SERVICE_TOKEN = SERVICE_TOKEN;
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function seedLegacy(t: ReturnType<typeof runtimeTest>) {
  return await t.run(async (ctx) => {
    const projectA = await ctx.db.insert("projects", { name: "A", workspacePath: "/tmp/a", mainBranch: "main" });
    const projectB = await ctx.db.insert("projects", { name: "B", workspacePath: "/tmp/b", mainBranch: "main" });
    await ctx.db.insert("integrations", {
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
    return { projectA, projectB, rowB };
  });
}

async function seedPush(t: ReturnType<typeof runtimeTest>, projectId: any) {
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

async function claimToken(t: ReturnType<typeof runtimeTest>, projectId: any): Promise<{ token: string; owner?: string; repo?: string }> {
  const { taskId } = await seedPush(t, projectId);
  const { pushId } = (await t.mutation(internal.githubPush.recordTaskCommit, {
    taskId,
    projectId,
    workerId: "w1",
    branchName: "fhara/t/ship-it",
    commitSha: SHA,
    commitMessage: "Fhara: Ship it",
    filesChanged: 1,
  })) as any;
  await t.mutation(api.githubPush.requestPush, { pushId, openPr: false });
  const claimed = await t.mutation(internal.githubPush.claimPushRequest, { workerId: "w1" });
  expect(claimed).not.toBeNull();
  return { token: claimed!.token, owner: claimed!.owner, repo: claimed!.repo };
}

describe("token resolution for pushes", () => {
  test("a project push uses the imported account token with the project's own repo binding", async () => {
    const t = runtimeTest(schema, modules);
    const projectId = await t.run((ctx) => ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", mainBranch: "main" }));
    await t.mutation(internal.integrations.upsertGithubIntegration, { accessToken: "gho_local_git", login: "octo" });
    await t.mutation(api.integrations.bindRepo, { projectId, githubOwner: "acme", githubRepo: "app" });

    const binding = await t.run((ctx) =>
      ctx.db.query("integrations").withIndex("by_project", (q) => q.eq("projectId", projectId)).first()
    );
    expect(binding?.accessToken).toBeUndefined();
    expect(await claimToken(t, projectId)).toEqual({ token: "gho_local_git", owner: "acme", repo: "app" });

    const account = await t.query(api.integrations.githubAccount, {});
    expect(account).toMatchObject({ connected: true, source: "global", login: "octo", configured: true });
    expect(JSON.stringify(account)).not.toContain("gho_local_git");
  });

  test("unpinning a repository leaves the target to the workspace origin", async () => {
    const t = runtimeTest(schema, modules);
    const projectId = await t.run((ctx) => ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", mainBranch: "main" }));
    await t.mutation(internal.integrations.upsertGithubIntegration, { accessToken: "gho_local_git", login: "octo" });
    await t.mutation(api.integrations.bindRepo, { projectId, githubOwner: "acme", githubRepo: "app" });
    expect(await t.mutation(api.integrations.unbindRepo, { projectId })).toEqual({ unbound: true });
    const binding = await t.run((ctx) =>
      ctx.db.query("integrations").withIndex("by_project", (q) => q.eq("projectId", projectId)).first()
    );
    expect(binding?.githubRepo).toBeUndefined();
    const claim = await claimToken(t, projectId);
    expect(claim.token).toBe("gho_local_git");
    expect(claim.owner).toBeUndefined();
    expect(claim.repo).toBeUndefined();
  });

  test("legacy per-project token stays readable until migrated away", async () => {
    const t = runtimeTest(schema, modules);
    const { projectB } = await seedLegacy(t);
    expect((await t.query(api.integrations.githubAccount, {})).source).toBe("legacy");
    expect(await claimToken(t, projectB)).toEqual({ token: "gho_newer", owner: "acme", repo: "b" });
  });

  test("a disconnect stops pushes and never falls back to legacy tokens", async () => {
    const t = runtimeTest(schema, modules);
    const { projectA } = await seedLegacy(t);
    await t.mutation(api.integrations.disconnectGithub, {});
    expect((await t.query(api.integrations.githubAccount, {})).connected).toBe(false);
    const { taskId } = await seedPush(t, projectA);
    const { pushId } = (await t.mutation(internal.githubPush.recordTaskCommit, {
      taskId,
      projectId: projectA,
      workerId: "w1",
      branchName: "fhara/t/ship-it",
      commitSha: SHA,
      commitMessage: "Fhara: Ship it",
      filesChanged: 1,
    })) as any;
    await expect(t.mutation(api.githubPush.requestPush, { pushId, openPr: false })).rejects.toThrow(/local Git credential/);
    const rows = await t.run((ctx) => ctx.db.query("integrations").collect());
    expect(rows.every((row) => row.accessToken === undefined)).toBe(true);
    expect(rows.every((row) => row.githubRepo)).toBe(true);
  });

  test("import writes a sealed global connection and creates the project binding", async () => {
    const t = runtimeTest(schema, modules);
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

  test("importLocalGithub is refused for an anonymous caller once projects are owned", async () => {
    const t = runtimeTest(schema, modules);
    await t.run((ctx) => ctx.db.insert("projects", { name: "Owned", workspacePath: "/tmp/o", ownerId: "user-1" }));
    await expect(t.action(api.integrations.importLocalGithub, {})).rejects.toThrow(/Unauthorized/);
  });
});

describe("no OAuth surface remains", () => {
  test("the callback route and app env readers are gone from source", async () => {
    // The local test runtime cannot serve HTTP actions, so assert on the
    // source of truth instead: no route, no env reader, no state module.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const read = (relative: string) => fs.readFileSync(path.resolve(here, relative), "utf8");
    const http = read("http.ts");
    const integrations = read("integrations.ts");
    const configSchema = read("../../../packages/config/src/schema/github.ts");
    expect(http).not.toContain("/integrations/github/callback");
    expect(integrations).not.toContain("getOAuthUrl");
    expect(integrations).not.toContain("GITHUB_CLIENT_SECRET");
    expect(configSchema).not.toContain("OAUTH_STATE_SECRET");
    expect(fs.existsSync(path.resolve(here, "lib/oauthState.ts"))).toBe(false);
  });
});
