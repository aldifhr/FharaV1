/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function agent(t: ReturnType<typeof convexTest>, role: string, isEnabled = true) {
  return await t.run((ctx) => ctx.db.insert("agents", { name: role.toUpperCase(), role, status: "idle", isEnabled }));
}

async function taskFor(t: ReturnType<typeof convexTest>, agentIds: string[]) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "p", agentIds } as never);
    return await ctx.db.insert("tasks", { projectId, title: "T", command: "c", status: "queued" } as never);
  });
}

describe("getRunContext planner fallback", () => {
  test("team without the CTO: the global CTO is delivered as planner only", async () => {
    const t = convexTest(schema, modules);
    const fe = await agent(t, "frontend");
    const cto = await agent(t, "cto");
    const taskId = await taskFor(t, [fe]);
    const result = await t.query(internal.orchestration.getRunContext, { taskId });
    expect(result!.agents.map((a) => a._id)).toEqual([fe]);
    expect(result!.plannerAgent?._id).toBe(cto);
    expect(result!.plannerFallbackReason).toBe("CTO not in project team");
  });

  test("team CTO disabled and no other enabled CTO: no planner, reason says why", async () => {
    const t = convexTest(schema, modules);
    const fe = await agent(t, "frontend");
    const disabledCto = await agent(t, "cto", false);
    const taskId = await taskFor(t, [fe, disabledCto]);
    const result = await t.query(internal.orchestration.getRunContext, { taskId });
    expect(result!.plannerAgent).toBeNull();
    expect(result!.plannerFallbackReason).toBe("CTO is disabled in the project team; no enabled CTO agent exists");
  });

  test("team with an enabled CTO: no fallback", async () => {
    const t = convexTest(schema, modules);
    const fe = await agent(t, "frontend");
    const cto = await agent(t, "cto");
    const taskId = await taskFor(t, [fe, cto]);
    const result = await t.query(internal.orchestration.getRunContext, { taskId });
    expect(result!.plannerAgent).toBeNull();
    expect(result!.plannerFallbackReason).toBeNull();
  });
});
