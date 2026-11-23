/// <reference types="vite/client" />
import { runtimeTest } from "@fhara/runtime/test";
import { describe, expect, test } from "vitest";
import { api, internal } from "@fhara/runtime/api";
import schema from "./schema";
import { normalizeCodexModels } from "./codexModels";

const modules = import.meta.glob("./**/*.ts");

describe("Codex model catalog", () => {
  test("stores only deduplicated model ids and exposes the freshest report", async () => {
    const t = runtimeTest(schema, modules);
    await t.mutation(internal.codexModels.report, {
      workerId: "w1", hostname: "alpha", models: ["gpt-6-luna", "gpt-5.6-terra"], available: true,
    });
    const listed = await t.query(api.codexModels.list, {});
    expect(listed.models).toEqual(["gpt-6-luna", "gpt-5.6-terra"]);
    expect(listed.available).toBe(true);
    expect(listed.reportedWorkers).toBe(1);
    expect(normalizeCodexModels([" gpt-6-luna ", "gpt-6-luna", "has space", "a/b", ""])).toEqual(["gpt-6-luna"]);
  });

  test("refresh is visible to worker and cleared by its next report", async () => {
    const t = runtimeTest(schema, modules);
    await t.mutation(internal.codexModels.report, { workerId: "w1", models: ["gpt-6-luna"], available: true });
    expect((await t.mutation(api.codexModels.requestRefresh, {})).requested).toBe(1);
    expect((await t.query(internal.codexModels.state, { workerId: "w1" })).refreshRequestedAt).toBeGreaterThan(0);
    await t.mutation(internal.codexModels.report, { workerId: "w1", models: ["gpt-6-luna"], available: true });
    expect((await t.query(internal.codexModels.state, { workerId: "w1" })).refreshRequestedAt).toBe(0);
  });

  test("worker reporting requires the service token", async () => {
    process.env.FHARA_SERVICE_TOKEN = "codex-catalog-test-token";
    const t = runtimeTest(schema, modules);
    const report = {
      workerId: "w1", models: ["gpt-6-luna"], available: true,
    };
    await expect(t.action(api.worker.reportCodexModels, { ...report, workerToken: "wrong" }))
      .rejects.toThrow("Worker authentication required");
    await t.action(api.worker.reportCodexModels, { ...report, workerToken: "codex-catalog-test-token" });
    expect((await t.query(api.codexModels.list, {})).models).toEqual(["gpt-6-luna"]);
  });
});
