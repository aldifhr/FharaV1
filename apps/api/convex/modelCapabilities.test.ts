/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { extractRouting } from "./lib/routing";

const modules = import.meta.glob("./**/*.ts");

describe("modelCapabilities (plan 027)", () => {
  test("overrides resolve per field, project beats global, the run context carries them, clearing deletes empty rows", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const providerId = await ctx.db.insert("llmProviders", { name: "nous", provider: "openai-compatible", model: "meituan/longcat-2.5", baseUrl: "https://x/v1", apiKeyEnv: "K", priority: 1, weight: 1, createdAt: now });
      await ctx.db.insert("llmModels", { providerId, modelId: "meituan/longcat-2.5", isAvailable: true, supportsTools: false, createdAt: now, updatedAt: now });
      await ctx.db.insert("llmModels", { providerId, modelId: "acme-1", isAvailable: true, contextWindow: 32000, createdAt: now, updatedAt: now });
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      const other = await ctx.db.insert("projects", { name: "Q", workspacePath: "/tmp/q" });
      const taskId = await ctx.db.insert("tasks", { projectId, title: "T", command: "c", status: "queued", updatedAt: now });
      return { projectId, other, taskId };
    });

    let view = await t.query(api.modelCapabilities.list, {});
    const longcat = view.models.find((m) => m.modelId === "meituan/longcat-2.5")!;
    expect(longcat.capabilities.toolCalling).toBe("markup");
    expect(longcat.sources.toolCalling).toBe("builtin");
    const acme = view.models.find((m) => m.modelId === "acme-1")!;
    expect(acme.capabilities.structuredOutput).toBe(false);
    expect(acme.sources.structuredOutput).toBe("unknown");
    expect(acme.capabilities.maxContextTokens).toBe(32000);

    await t.mutation(api.modelCapabilities.setOverride, { modelId: "acme-1", structuredOutput: true, toolCalling: "native" });
    await t.mutation(api.modelCapabilities.setOverride, { modelId: "acme-1", projectId: ids.projectId, toolCalling: "none" });
    view = await t.query(api.modelCapabilities.list, { projectId: ids.projectId });
    const scoped = view.models.find((m) => m.modelId === "acme-1")!;
    expect(scoped.capabilities).toMatchObject({ structuredOutput: true, toolCalling: "none" });
    expect(scoped.sources).toMatchObject({ structuredOutput: "global", toolCalling: "project" });
    const otherView = await t.query(api.modelCapabilities.list, { projectId: ids.other });
    expect(otherView.models.find((m) => m.modelId === "acme-1")!.capabilities.toolCalling).toBe("native");

    const run = await t.query(internal.orchestration.getRunContext, { taskId: ids.taskId });
    expect(run!.modelCapabilityOverrides.map((o) => o.projectId ?? "global").sort()).toEqual([ids.projectId, "global"].sort());

    await expect(t.mutation(api.modelCapabilities.setOverride, { modelId: "acme-1", maxContextTokens: -5 })).rejects.toThrow(/positive/);

    // Clearing every field of the project row deletes it; the probe keeps a row alive.
    await t.mutation(api.modelCapabilities.setOverride, { modelId: "acme-1", projectId: ids.projectId, clear: ["toolCalling"] });
    await t.mutation(internal.modelCapabilities.recordProbe, { modelId: "acme-1", probe: { at: 5, structuredOutput: false, toolCalling: "markup" } });
    await t.mutation(api.modelCapabilities.setOverride, { modelId: "acme-1", clear: ["structuredOutput", "toolCalling"] });
    const rows = await t.run(async (ctx) => await ctx.db.query("modelCapabilityOverrides").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].probe).toMatchObject({ toolCalling: "markup" });
    view = await t.query(api.modelCapabilities.list, {});
    expect(view.models.find((m) => m.modelId === "acme-1")!.sources.toolCalling).toBe("probe");
  });

  test("the probe action is token-gated", async () => {
    const t = convexTest(schema, modules);
    const providerId = await t.run(async (ctx) =>
      ctx.db.insert("llmProviders", { name: "n", provider: "openai", model: "m", baseUrl: "https://x/v1", apiKeyEnv: "K", priority: 1, weight: 1, createdAt: 1 })
    );
    await expect(t.action(api.modelCapabilities.probe, { token: "wrong", providerId, modelId: "m" })).rejects.toThrow(/authentication/i);
  });
});

describe("routing extraction (plan 027)", () => {
  test("subtask.routed model + performance payloads reach the Routing Inspector view", () => {
    const view = extractRouting({
      events: [
        {
          type: "subtask.routed",
          createdAt: 1,
          payload: {
            subtaskKey: "ui",
            capability: "frontend-development",
            agent: "Frontend B",
            role: "frontend",
            match: "exact",
            performance: {
              from: "Frontend", to: "Frontend B", fromRole: "frontend", toRole: "frontend", changed: true,
              reason: "higher performance score: 0.90 vs 0.60",
              scores: [
                { agent: "Frontend", role: "frontend", score: 0.6, samples: 9, insufficient: false, available: true, load: { running: 0, limit: 1 }, modelFit: true, budgetFit: null },
                { agent: "Frontend B", role: "frontend", score: 0.9, samples: 12, insufficient: false, available: true, load: { running: 1, limit: 2 }, modelFit: true, budgetFit: true },
              ],
            },
            model: { model: "gpt-4o", connection: "OpenAI", satisfied: true, fallback: false, reason: "gpt-4o on OpenAI: satisfies tool calling" },
          },
        },
      ],
      subtasks: [{ key: "ui", title: "UI", capability: "frontend-development", kind: "code_change", dependencies: [] }],
      delegations: [],
      roleByAgentName: {},
    });
    const s = view.subtasks[0];
    expect(s.performance).toMatchObject({ changed: true, toRole: "frontend" });
    expect(s.performance!.scores.map((c) => c.chosen)).toEqual([false, true]);
    expect(s.performance!.scores[1].load).toBe("1/2");
    expect(s.model).toMatchObject({ model: "gpt-4o", satisfied: true, fallback: false });
    expect(s.why.some((w) => w.startsWith("Performance: moved off"))).toBe(true);
    expect(s.why.some((w) => w.startsWith("Model: gpt-4o on OpenAI"))).toBe(true);
  });
});
