/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FunctionArgs } from "convex/server";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { decryptApiKey } from "./lib/llmCrypto";
import { buildPresetArgs, getMcpPreset, mcpRoleAllowed, presetToolAction } from "./lib/mcpPresets";

/**
 * Integrations page: MCP scope resolution and secret masking.
 *
 * Invariants:
 *  - a run gets GLOBAL + its own project's servers, enabled only, never
 *    another project's;
 *  - env values are stored only as ciphertext; list() exposes key names,
 *    never values or ciphertext; getRunContext carries ciphertext, never
 *    plaintext;
 *  - test connection is worker-executed and never reports success itself.
 */

const modules = import.meta.glob("./**/*.ts");
// 32 zero bytes, base64 — test-only key.
const TEST_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let previousKey: string | undefined;

beforeAll(() => {
  previousKey = process.env.PROVIDER_ENCRYPTION_KEY;
  process.env.PROVIDER_ENCRYPTION_KEY = TEST_KEY;
});
afterAll(() => {
  if (previousKey === undefined) delete process.env.PROVIDER_ENCRYPTION_KEY;
  else process.env.PROVIDER_ENCRYPTION_KEY = previousKey;
});

async function seedRunnableTask(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const agentId = await ctx.db.insert("agents", { name: "A", role: "frontend", status: "idle" });
    const projectId = await ctx.db.insert("projects", { name: "Mine", workspacePath: "/tmp/mine", agentIds: [agentId] });
    const otherId = await ctx.db.insert("projects", { name: "Other", workspacePath: "/tmp/other" });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "T",
      command: "go",
      status: "queued",
      assignedAgentIds: [agentId],
    });
    return { projectId, otherId, taskId };
  });
}

describe("MCP scope resolution", () => {
  test("a run gets global + its project's enabled servers only", async () => {
    const t = convexTest(schema, modules);
    const { projectId, otherId, taskId } = await seedRunnableTask(t);

    await t.mutation(internal.mcpServers.createFromPreset, { presetId: "fetch", name: "global-fetch" });
    await t.mutation(internal.mcpServers.createFromPreset, { presetId: "filesystem", name: "mine-fs", projectId });
    await t.mutation(internal.mcpServers.createFromPreset, { presetId: "playwright", name: "other-browser", projectId: otherId });
    await t.mutation(internal.mcpServers.createFromPreset, {
      presetId: "filesystem",
      name: "global-off",
      enabled: false,
    });

    const context = await t.query(internal.orchestration.getRunContext, { taskId });
    expect(context!.mcpServers.map((row) => row.name).sort()).toEqual(["global-fetch", "mine-fs"]);
  });

  test("list filters by scope", async () => {
    const t = convexTest(schema, modules);
    const { projectId, otherId } = await seedRunnableTask(t);
    await t.mutation(internal.mcpServers.createFromPreset, { presetId: "fetch", name: "g" });
    await t.mutation(internal.mcpServers.createFromPreset, { presetId: "fetch", name: "p", projectId });
    await t.mutation(internal.mcpServers.createFromPreset, { presetId: "fetch", name: "o", projectId: otherId });

    const names = async (args: FunctionArgs<typeof api.mcpServers.list>) =>
      (await t.query(api.mcpServers.list, args)).map((row) => row.name).sort();
    expect(await names({})).toEqual(["g", "o", "p"]);
    expect(await names({ projectId })).toEqual(["g", "p"]);
    expect(await names({ projectId, scope: "project" })).toEqual(["p"]);
    expect(await names({ projectId, scope: "global" })).toEqual(["g"]);
    expect(await names({ scope: "global" })).toEqual(["g"]);
  });

  test("moving a server to global scope and back", async () => {
    const t = convexTest(schema, modules);
    const { projectId, taskId } = await seedRunnableTask(t);
    const { otherId } = await t.run(async (ctx) => ({
      otherId: await ctx.db.insert("projects", { name: "X", workspacePath: "/tmp/x" }),
    }));
    const serverId = await t.mutation(internal.mcpServers.createFromPreset, {
      presetId: "fetch",
      name: "f",
      projectId: otherId,
    });
    let context = await t.query(internal.orchestration.getRunContext, { taskId });
    expect(context!.mcpServers).toHaveLength(0);

    await t.mutation(internal.mcpServers.update, { serverId, projectId: null });
    context = await t.query(internal.orchestration.getRunContext, { taskId });
    expect(context!.mcpServers.map((row) => row.name)).toEqual(["f"]);
    expect((await t.run((ctx) => ctx.db.get(serverId)))!.projectId).toBeUndefined();

    await t.mutation(internal.mcpServers.update, { serverId, projectId });
    await t.mutation(internal.mcpServers.setEnabled, { serverId, enabled: false });
    context = await t.query(internal.orchestration.getRunContext, { taskId });
    expect(context!.mcpServers).toHaveLength(0);
  });
});

describe("MCP secret masking", () => {
  test("env is sealed; list exposes key names only; run context carries ciphertext only", async () => {
    const t = convexTest(schema, modules);
    const { projectId, taskId } = await seedRunnableTask(t);
    const secret = "postgresql://u:hunter2-very-secret@db:5432/app";
    const serverId = await t.mutation(internal.mcpServers.createFromPreset, {
      presetId: "postgres",
      projectId,
      env: { DATABASE_URL: secret },
    });

    const stored = await t.run((ctx) => ctx.db.get(serverId));
    expect(stored!.envKeys).toEqual(["DATABASE_URL"]);
    expect(stored!.envCiphertext).toMatch(/^v1:/);
    expect(JSON.stringify(stored)).not.toContain("hunter2");
    // The secret never sits in the args: the worker fills {env:DATABASE_URL}.
    expect(JSON.parse(stored!.args!)).toContain("{env:DATABASE_URL}");
    expect(JSON.parse(await decryptApiKey(stored!.envCiphertext!, "test"))).toEqual({ DATABASE_URL: secret });

    const rows = await t.query(api.mcpServers.list, { projectId });
    expect(rows).toHaveLength(1);
    expect(rows[0].envKeys).toEqual(["DATABASE_URL"]);
    expect(rows[0].hasEnv).toBe(true);
    expect("envCiphertext" in rows[0]).toBe(false);
    expect(JSON.stringify(rows)).not.toContain("hunter2");
    expect(JSON.stringify(rows)).not.toContain(stored!.envCiphertext!);

    const context = await t.query(internal.orchestration.getRunContext, { taskId });
    const serialized = JSON.stringify(context!.mcpServers);
    expect(serialized).not.toContain("hunter2");
    expect(context!.mcpServers[0].envCiphertext).toBe(stored!.envCiphertext);
  });

  test("update merges, replaces and clears env keys without exposing values", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedRunnableTask(t);
    const serverId = await t.mutation(internal.mcpServers.createFromPreset, {
      presetId: "custom",
      projectId,
      name: "c",
      command: "node",
      commandArgs: ["server.js"],
      env: { API_TOKEN: "first-value", REGION: "eu" },
    });
    await t.mutation(internal.mcpServers.update, { serverId, env: { API_TOKEN: "second-value" }, removeEnvKeys: ["REGION"] });
    const stored = await t.run((ctx) => ctx.db.get(serverId));
    expect(stored!.envKeys).toEqual(["API_TOKEN"]);
    expect(JSON.parse(await decryptApiKey(stored!.envCiphertext!, "test"))).toEqual({ API_TOKEN: "second-value" });
    expect(stored!.status).toBe("untested");
  });

  test("required secrets and reserved env keys are refused", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedRunnableTask(t);
    await expect(t.mutation(internal.mcpServers.createFromPreset, { presetId: "postgres", projectId })).rejects.toThrow(
      /Database URL is required/
    );
    await expect(
      t.mutation(internal.mcpServers.createFromPreset, {
        presetId: "custom",
        projectId,
        command: "node",
        env: { CONVEX_SERVICE_TOKEN: "x" },
      })
    ).rejects.toThrow(/reserved/);
  });

  test("GitHub preset borrows the project's OAuth token and follows disconnects", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedRunnableTask(t);
    await t.mutation(internal.integrations.upsertGithubIntegration, { projectId, accessToken: "gho_first" });
    const serverId = await t.mutation(internal.mcpServers.createFromPreset, {
      presetId: "github",
      projectId,
      useGithubOAuth: true,
    });
    let stored = await t.run((ctx) => ctx.db.get(serverId));
    expect(stored!.envKeys).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN"]);
    expect(JSON.parse(await decryptApiKey(stored!.envCiphertext!, "t")).GITHUB_PERSONAL_ACCESS_TOKEN).toBe("gho_first");

    await t.mutation(internal.integrations.upsertGithubIntegration, { projectId, accessToken: "gho_second" });
    stored = await t.run((ctx) => ctx.db.get(serverId));
    expect(JSON.parse(await decryptApiKey(stored!.envCiphertext!, "t")).GITHUB_PERSONAL_ACCESS_TOKEN).toBe("gho_second");

    const integration = await t.run((ctx) =>
      ctx.db.query("integrations").withIndex("by_project", (q) => q.eq("projectId", projectId)).first()
    );
    await t.mutation(api.integrations.remove, { integrationId: integration!._id });
    stored = await t.run((ctx) => ctx.db.get(serverId));
    expect(stored!.envKeys).toEqual([]);
    expect(stored!.envCiphertext).toBeUndefined();

    await expect(
      t.mutation(internal.mcpServers.createFromPreset, { presetId: "github", useGithubOAuth: true })
    ).rejects.toThrow(/project-scoped/);
  });
});

describe("MCP test connection", () => {
  test("a local server waits for a worker; the claimed result is recorded", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedRunnableTask(t);
    const serverId = await t.mutation(internal.mcpServers.createFromPreset, { presetId: "fetch", projectId });
    expect((await t.run((ctx) => ctx.db.get(serverId)))!.status).toBe("untested");

    expect(await t.mutation(internal.mcpServers.requestTest, { serverId })).toEqual({ queued: true });
    let row = (await t.query(api.mcpServers.list, { projectId }))[0];
    expect(row.testPending).toBe(true);
    expect(row.status).toBe("untested");

    const claim = await t.mutation(internal.mcpServers.claimTest, { workerId: "w1" });
    expect(claim).toMatchObject({ serverId, command: "uvx", workspacePath: "/tmp/mine" });
    // Leased: a second worker gets nothing.
    expect(await t.mutation(internal.mcpServers.claimTest, { workerId: "w2" })).toBeNull();
    // Only the lease holder may report.
    expect(await t.mutation(internal.mcpServers.completeTest, { serverId, workerId: "w2", ok: true })).toBe(false);

    await t.mutation(internal.mcpServers.completeTest, { serverId, workerId: "w1", ok: true, toolNames: ["fetch"] });
    row = (await t.query(api.mcpServers.list, { projectId }))[0];
    expect(row).toMatchObject({ status: "connected", toolCount: 1, toolNames: ["fetch"], testPending: false });
  });

  test("a remote server is recorded untested, never connected", async () => {
    const t = convexTest(schema, modules);
    const serverId = await t.mutation(internal.mcpServers.createFromPreset, {
      presetId: "custom",
      type: "remote",
      url: "https://mcp.example.test/mcp",
    });
    const result = await t.mutation(internal.mcpServers.requestTest, { serverId });
    expect(result.queued).toBe(false);
    const stored = await t.run((ctx) => ctx.db.get(serverId));
    expect(stored!.status).toBe("untested");
    expect(stored!.testRequestedAt).toBeUndefined();
    expect(await t.mutation(internal.mcpServers.claimTest, { workerId: "w1" })).toBeNull();
  });
});

describe("mcpPresets helpers", () => {
  test("filesystem root fills the arg template", () => {
    const preset = getMcpPreset("filesystem")!;
    expect(buildPresetArgs(preset)).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "{workspace}"]);
    expect(buildPresetArgs(preset, { root: "/srv/data" })).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/srv/data"]);
  });

  test("tool policy fails closed and roles match by key", () => {
    expect(presetToolAction("fetch", "fetch")).toBe("read");
    expect(presetToolAction("fetch", "exec")).toBeNull();
    expect(presetToolAction("github", "create_issue")).toBe("write");
    expect(presetToolAction("playwright", "browser_click")).toBe("write");
    expect(presetToolAction("custom", "anything")).toBeNull();
    expect(presetToolAction("custom", "anything", ["anything"])).toBe("read");
    expect(mcpRoleAllowed(undefined, "qa")).toBe(true);
    expect(mcpRoleAllowed(["qa"], "QA")).toBe(true);
    expect(mcpRoleAllowed(["qa"], "frontend")).toBe(false);
    expect(mcpRoleAllowed(["frontend"], "Frontend Engineer")).toBe(true);
  });
});
