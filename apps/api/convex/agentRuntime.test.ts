/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { normalizeOpencodeModel } from "./agents";

const modules = import.meta.glob("./**/*.ts");

describe("per-agent execution runtime (OpenCode)", () => {
  test("update sets, keeps, and clears executionRuntime + opencodeModel", async () => {
    const t = convexTest(schema, modules);
    const agentId = await t.run((ctx) =>
      ctx.db.insert("agents", { name: "FE", role: "frontend", status: "idle", isEnabled: true })
    );
    const base = { agentId, name: "FE", role: "frontend", systemPrompt: "" };

    await t.mutation(api.agents.update, { ...base, executionRuntime: "opencode", opencodeModel: " anthropic/claude-sonnet-4 " });
    let row = await t.run((ctx) => ctx.db.get(agentId));
    expect(row?.executionRuntime).toBe("opencode");
    expect(row?.opencodeModel).toBe("anthropic/claude-sonnet-4");

    // Omitted fields are left as-is.
    await t.mutation(api.agents.update, base);
    row = await t.run((ctx) => ctx.db.get(agentId));
    expect(row?.executionRuntime).toBe("opencode");

    // null clears back to the worker default.
    await t.mutation(api.agents.update, { ...base, executionRuntime: null, opencodeModel: null });
    row = await t.run((ctx) => ctx.db.get(agentId));
    expect(row?.executionRuntime).toBeUndefined();
    expect(row?.opencodeModel).toBeUndefined();
  });

  test("rejects malformed OpenCode model ids", async () => {
    const t = convexTest(schema, modules);
    const agentId = await t.run((ctx) =>
      ctx.db.insert("agents", { name: "FE", role: "frontend", status: "idle", isEnabled: true })
    );
    await expect(
      t.mutation(api.agents.update, { agentId, name: "FE", role: "frontend", systemPrompt: "", opencodeModel: "no slash here" })
    ).rejects.toThrow(/provider\/model/);
  });

  test("normalizeOpencodeModel", () => {
    expect(normalizeOpencodeModel("openrouter/anthropic/claude")).toBe("openrouter/anthropic/claude");
    expect(normalizeOpencodeModel("  ")).toBeUndefined();
    expect(normalizeOpencodeModel(null)).toBeUndefined();
    expect(() => normalizeOpencodeModel("claude")).toThrow();
  });
});
