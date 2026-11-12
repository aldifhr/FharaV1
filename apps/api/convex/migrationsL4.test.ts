/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { retiredLlmFields, RETIRED_AGENT_LLM_FIELDS } from "./migrations";

const modules = import.meta.glob("./**/*.ts");

describe("L4 migrations:clearPerAgentLlm", () => {
  test("retiredLlmFields lists only the fields a row still carries", () => {
    expect(retiredLlmFields("agents", { name: "QA", llmSelectionPolicy: "fixed", opencodeModel: undefined }, RETIRED_AGENT_LLM_FIELDS)).toEqual([
      { table: "agents", name: "QA", field: "llmSelectionPolicy", oldValue: "fixed" },
    ]);
    expect(retiredLlmFields("agents", { name: "QA" }, RETIRED_AGENT_LLM_FIELDS)).toEqual([]);
  });

  test("clears every retired agent and template field, logs each, and is idempotent", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const providerId = await ctx.db.insert("llmProviders", {
        name: "P",
        provider: "openai-compatible",
        model: "m",
        baseUrl: "https://llm.example/v1",
        apiKeyEnv: "",
        priority: 1,
        weight: 1,
        isEnabled: true,
        createdAt: 0,
        updatedAt: 0,
      } as never);
      const modelId = await ctx.db.insert("llmModels", { providerId, modelId: "m", isAvailable: true, createdAt: 0, updatedAt: 0 } as never);
      const legacy = await ctx.db.insert("agents", {
        name: "Legacy",
        role: "backend",
        status: "idle",
        llmProviderId: providerId,
        llmModelId: modelId,
        llmFallbackProviderId: providerId,
        llmSelectionPolicy: "fixed",
        executionRuntime: "opencode",
        opencodeModel: "openrouter/x",
      });
      const clean = await ctx.db.insert("agents", { name: "Clean", role: "qa", status: "idle" });
      const template = await ctx.db.insert("agentTemplates", {
        name: "T",
        role: "qa",
        description: "",
        systemPrompt: "",
        llmModelId: modelId,
        runtime: "api",
        builtIn: false,
        createdAt: 0,
        updatedAt: 0,
      });
      return { legacy, clean, template, providerId, modelId };
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const first = await t.mutation(internal.migrations.clearPerAgentLlm, {});
    expect(first.agentsCleared).toBe(1);
    expect(first.templatesCleared).toBe(1);
    expect(first.cleared.map((entry) => `${entry.name}.${entry.field}`).sort()).toEqual(
      [
        "Legacy.executionRuntime",
        "Legacy.llmFallbackProviderId",
        "Legacy.llmModelId",
        "Legacy.llmProviderId",
        "Legacy.llmSelectionPolicy",
        "Legacy.opencodeModel",
        "T.llmModelId",
        "T.runtime",
      ].sort()
    );
    expect(first.cleared.find((entry) => entry.field === "llmSelectionPolicy")?.oldValue).toBe("fixed");
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain('[L4 clearPerAgentLlm] agents "Legacy": opencodeModel = openrouter/x (cleared)');
    expect(lines.at(-1)).toBe("[L4 clearPerAgentLlm] 1 agent(s), 1 template(s), 8 field(s) cleared");

    const rows = await t.run(async (ctx) => ({ legacy: await ctx.db.get(ids.legacy), template: await ctx.db.get(ids.template) }));
    for (const field of RETIRED_AGENT_LLM_FIELDS) expect(rows.legacy?.[field]).toBeUndefined();
    expect(rows.legacy?.name).toBe("Legacy");
    expect(rows.template?.llmModelId).toBeUndefined();
    expect(rows.template?.runtime).toBeUndefined();

    const second = await t.mutation(internal.migrations.clearPerAgentLlm, {});
    expect(second).toEqual({ agentsCleared: 0, templatesCleared: 0, cleared: [] });
    log.mockRestore();
  });
});
