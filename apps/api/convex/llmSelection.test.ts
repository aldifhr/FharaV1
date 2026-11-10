/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("global LLM selection mode", () => {
  test("defaults to fallback when nothing was ever set", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.llmSelection.get, {})).toEqual({ mode: "fallback" });
  });

  test("set stores the mode and get reads it back", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(api.llmSelection.set, { mode: "round_robin" })).toEqual({
      mode: "round_robin",
    });
    expect(await t.query(api.llmSelection.get, {})).toEqual({ mode: "round_robin" });

    // One row only: switching the mode updates it in place.
    await t.mutation(api.llmSelection.set, { mode: "fallback" });
    expect(await t.query(api.llmSelection.get, {})).toEqual({ mode: "fallback" });
    const rows = await t.run(async (ctx) => await ctx.db.query("llmSelectionSettings").collect());
    expect(rows).toHaveLength(1);
  });

  test("rejects an unknown mode", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.llmSelection.set, { mode: "random_please" as never })
    ).rejects.toThrow();
  });

  test("the run context carries the mode to the worker", async () => {
    const t = convexTest(schema, modules);
    const taskId = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      return ctx.db.insert("tasks", {
        projectId,
        title: "T",
        command: "do the thing",
        status: "queued",
      });
    });

    expect((await t.query(internal.orchestration.getRunContext, { taskId }))?.llmSelectionMode).toBe(
      "fallback"
    );

    await t.mutation(api.llmSelection.set, { mode: "round_robin" });
    expect((await t.query(internal.orchestration.getRunContext, { taskId }))?.llmSelectionMode).toBe(
      "round_robin"
    );
  });
});
