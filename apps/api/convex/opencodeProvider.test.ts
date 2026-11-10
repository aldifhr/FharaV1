/// <reference types="vite/client" />
/**
 * Plan 038: OpenCode as a provider in Settings → LLM & Models — the row,
 * the carry-over of the plan 035 switch, detection/test through the worker
 * catalog, the pool split (run context only), and model-id validation.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const TOKEN = "svc-token-opencode-provider";

beforeEach(() => {
  process.env.CONVEX_SERVICE_TOKEN = TOKEN;
});
afterEach(() => {
  delete process.env.CONVEX_SERVICE_TOKEN;
});

async function seedTask(t: ReturnType<typeof convexTest>) {
  const projectId = await t.run((ctx) => ctx.db.insert("projects", { name: "P", workspacePath: "p" }));
  return await t.run((ctx) => ctx.db.insert("tasks", { projectId, title: "t", command: "c", status: "queued" }));
}

async function seedHttp(t: ReturnType<typeof convexTest>) {
  return await t.mutation(api.llmProviders.create, {
    token: TOKEN,
    name: "HTTP",
    provider: "openai-compatible",
    model: "x",
    baseUrl: "https://http.example/v1",
    apiKeyEnv: "LLM_API_KEY",
  });
}

describe("OpenCode provider row", () => {
  test("status before anything: not configured, worker offline, not checked", async () => {
    const t = convexTest(schema, modules);
    const status = await t.query(api.opencodeProvider.status, {});
    expect(status).toMatchObject({ configured: false, enabled: false, workerOnline: false, installed: null, test: null });
  });

  test("setEnabled creates one row, toggles it, and is token-gated", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.opencodeProvider.setEnabled, { token: "wrong", enabled: true })).rejects.toThrow();
    const first = await t.mutation(api.opencodeProvider.setEnabled, { token: TOKEN, enabled: true });
    const again = await t.mutation(api.opencodeProvider.setEnabled, { token: TOKEN, enabled: false });
    expect(again.providerId).toBe(first.providerId);
    const rows = await t.run((ctx) => ctx.db.query("llmProviders").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "opencode", isEnabled: false, baseUrl: "" });
    expect((await t.query(api.opencodeProvider.status, {})).enabled).toBe(false);
  });

  test("an HTTP create cannot make a second OpenCode row", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.llmProviders.create, {
        token: TOKEN, name: "X", provider: "opencode", model: "", baseUrl: "", apiKeyEnv: "",
      })
    ).rejects.toThrow(/OpenCode/);
  });

  test("OpenCode models must be provider/model ids and take list positions", async () => {
    const t = convexTest(schema, modules);
    await seedHttp(t);
    const { providerId } = await t.mutation(api.opencodeProvider.setEnabled, { token: TOKEN, enabled: true });
    await expect(
      t.mutation(api.llmModels.create, { token: TOKEN, providerId: providerId as never, modelId: "nope" })
    ).rejects.toThrow(/provider\/model/);
    await t.mutation(api.llmModels.create, { token: TOKEN, providerId: providerId as never, modelId: "opencode/a" });
    const list = await t.query(api.llmModels.list, {});
    expect(list.map((m) => m.modelId)).toEqual(["x", "opencode/a"]);
  });
});

describe("backward compatibility with the plan 035 switch", () => {
  test("enabling carries an 'OpenCode CLI + model' setting over as the first entry", async () => {
    const t = convexTest(schema, modules);
    await seedHttp(t);
    await t.mutation(api.opencodeSettings.set, { runtime: "opencode", model: "opencode/beam-free" });
    const result = await t.mutation(api.opencodeProvider.setEnabled, { token: TOKEN, enabled: true });
    expect(result.carriedOver).toBe("opencode/beam-free");
    const list = await t.query(api.llmModels.list, {});
    expect(list.map((m) => m.modelId)).toEqual(["opencode/beam-free", "x"]);
  });

  test("without the row the legacy switch reaches the run context; with it, the neutral baseline", async () => {
    const t = convexTest(schema, modules);
    const taskId = await seedTask(t);
    await t.mutation(api.opencodeSettings.set, { runtime: "opencode", model: "opencode/beam-free" });
    let context = await t.query(internal.orchestration.getRunContext, { taskId });
    expect(context?.opencodeRuntime).toBe("opencode");

    await t.mutation(api.opencodeProvider.setEnabled, { token: TOKEN, enabled: true });
    context = await t.query(internal.orchestration.getRunContext, { taskId });
    expect(context?.opencodeRuntime).toBe("api");
    expect(context?.opencodeModel).toBe("");
    expect((await t.query(api.opencodeSettings.get, {})).viaModelList).toBe(true);
  });
});

describe("the pool split", () => {
  test("the run context carries the OpenCode row; chat and the internal pool do not", async () => {
    const t = convexTest(schema, modules);
    const taskId = await seedTask(t);
    await seedHttp(t);
    const { providerId } = await t.mutation(api.opencodeProvider.setEnabled, { token: TOKEN, enabled: true });
    await t.mutation(api.llmModels.create, { token: TOKEN, providerId: providerId as never, modelId: "opencode/a" });

    const context = await t.query(internal.orchestration.getRunContext, { taskId });
    expect(context?.llmProviders.map((p) => p.provider).sort()).toEqual(["openai-compatible", "opencode"]);
    const pool = await t.query(internal.llmProviders.getForProject, {});
    expect(pool.map((p) => p.provider)).toEqual(["openai-compatible"]);
  });

  test("a disabled OpenCode row is not in the run context (the worker skips it)", async () => {
    const t = convexTest(schema, modules);
    const taskId = await seedTask(t);
    await t.mutation(api.opencodeProvider.setEnabled, { token: TOKEN, enabled: false });
    const context = await t.query(internal.orchestration.getRunContext, { taskId });
    expect(context?.llmProviders.some((p) => p.provider === "opencode")).toBe(false);
  });
});

describe("detection and Test through the worker catalog", () => {
  test("a report with detection shows in status; Test is requested, served and read back", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.opencodeModels.report, {
      workerId: "w1",
      models: ["opencode/a"],
      available: true,
      installed: true,
      version: "1.19.5",
      path: "/usr/local/bin/opencode",
    });
    let status = await t.query(api.opencodeProvider.status, {});
    expect(status).toMatchObject({ installed: true, version: "1.19.5", path: "/usr/local/bin/opencode", pendingTest: false });

    await t.mutation(api.opencodeModels.requestTest, { model: "opencode/a" });
    const state = await t.query(internal.opencodeModels.state, { workerId: "w1" });
    expect(state.testRequestedAt).toBeGreaterThan(0);
    expect(state.testModel).toBe("opencode/a");
    expect((await t.query(api.opencodeProvider.status, {})).pendingTest).toBe(true);

    await t.mutation(internal.opencodeModels.reportTest, { workerId: "w1", ok: true, latencyMs: 4306, model: "opencode/a" });
    status = await t.query(api.opencodeProvider.status, {});
    expect(status.pendingTest).toBe(false);
    expect(status.test).toMatchObject({ ok: true, latencyMs: 4306, model: "opencode/a" });
    expect((await t.query(internal.opencodeModels.state, { workerId: "w1" })).testRequestedAt).toBe(0);
  });

  test("a missing CLI reads as not installed", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.opencodeModels.report, {
      workerId: "w1", models: [], available: false, installed: false, error: '"opencode" was not found on PATH',
    });
    const status = await t.query(api.opencodeProvider.status, {});
    expect(status).toMatchObject({ installed: false, error: '"opencode" was not found on PATH' });
  });
});
