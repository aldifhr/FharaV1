/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("agent LLM selection policy", () => {
  test("accepts the round robin policy and stores it", async () => {
    const t = convexTest(schema, modules);
    const agentId = await t.run((ctx) =>
      ctx.db.insert("agents", { name: "FE", role: "frontend", status: "idle", isEnabled: true })
    );
    await t.mutation(api.agents.update, {
      agentId,
      name: "FE",
      role: "frontend",
      systemPrompt: "",
      llmSelectionPolicy: "round_robin",
    });
    const row = await t.run((ctx) => ctx.db.get(agentId));
    expect(row?.llmSelectionPolicy).toBe("round_robin");
  });

  test("accepts the fallback (priority) policy and clears it with null", async () => {
    const t = convexTest(schema, modules);
    const agentId = await t.run((ctx) =>
      ctx.db.insert("agents", { name: "QA", role: "qa", status: "idle", isEnabled: true })
    );
    const base = { agentId, name: "QA", role: "qa", systemPrompt: "" };
    await t.mutation(api.agents.update, { ...base, llmSelectionPolicy: "priority" });
    let row = await t.run((ctx) => ctx.db.get(agentId));
    expect(row?.llmSelectionPolicy).toBe("priority");

    await t.mutation(api.agents.update, { ...base, llmSelectionPolicy: null });
    row = await t.run((ctx) => ctx.db.get(agentId));
    expect(row?.llmSelectionPolicy).toBeUndefined();
  });

  test("rejects an unknown policy", async () => {
    const t = convexTest(schema, modules);
    const agentId = await t.run((ctx) =>
      ctx.db.insert("agents", { name: "FE", role: "frontend", status: "idle", isEnabled: true })
    );
    await expect(
      t.mutation(api.agents.update, {
        agentId,
        name: "FE",
        role: "frontend",
        systemPrompt: "",
        // The validator is typed, so an unknown policy only reaches the
        // runtime validator through a cast.
        llmSelectionPolicy: "random_please" as never,
      })
    ).rejects.toThrow();
  });
});
