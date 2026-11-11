/// <reference types="vite/client" />
// D8: goal mode for direct threads, the store side (lib/directGoal.ts, lib/directPatch.ts, directThreads.ts).
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { applyGoalPatch, goalStatusLine, goalWantsWorker, parseGoalArgs, type DirectGoal } from "./lib/directGoalSchema";
import { nextUserGoal } from "./lib/directGoal";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const projectId = await t.run(async (ctx) => {
    const devId = await ctx.db.insert("agents", { name: "Dev", role: "backend", status: "idle", isEnabled: true } as never);
    return await ctx.db.insert("projects", { name: "P", workspacePath: "/ws/p", agentIds: [devId] } as never);
  });
  const { taskId } = await t.mutation(api.directThreads.create, { projectId, role: "backend" });
  return { t, projectId, taskId };
}

type T = Awaited<ReturnType<typeof setup>>["t"];
const taskOf = (t: T, taskId: Id<"tasks">) => t.run(async (ctx) => (await ctx.db.get(taskId))!);
const eventTypes = (t: T, taskId: Id<"tasks">) =>
  t.run(async (ctx) => (await ctx.db.query("taskEvents").withIndex("by_task_and_sequence", (q) => q.eq("taskId", taskId)).collect()).map((e) => e.type));
const hold = (t: T) => t.run(async (ctx) => void (await ctx.db.insert("appSettings", { automationHold: { heldAt: Date.now() }, updatedAt: Date.now() } as never)));

describe("/goal parsing and the pure rules", () => {
  test("objective, a trailing round limit, and the subcommands", () => {
    expect(parseGoalArgs("make the tests pass 3")).toEqual({ action: "set", objective: "make the tests pass", maxRounds: 3 });
    expect(parseGoalArgs("make the tests pass")).toEqual({ action: "set", objective: "make the tests pass", maxRounds: 10 });
    expect(parseGoalArgs("fix issue 999")).toEqual({ action: "set", objective: "fix issue 999", maxRounds: 10 }); // over the max: part of the objective
    expect(parseGoalArgs("pause")).toEqual({ action: "pause" });
    expect(parseGoalArgs("Clear")).toEqual({ action: "clear" });
    expect(parseGoalArgs("  ")).toBeNull();
  });

  test("worker patches: rounds only grow, terminal lands, paused only from active, another goal id is ignored", () => {
    const g = nextUserGoal(undefined, { action: "set", objective: "x", maxRounds: 3 }, 1000)!;
    expect(applyGoalPatch(g, { goalId: "other", round: 2 }, 2)).toBe(g);
    const r2 = applyGoalPatch(g, { goalId: g.id, round: 2 }, 2)!;
    expect(applyGoalPatch(r2, { goalId: g.id, round: 1 }, 3)!.round).toBe(2);
    expect(applyGoalPatch(r2, { goalId: g.id, round: 9 }, 3)!.round).toBe(3);
    const done = applyGoalPatch({ ...r2, phase: "paused" }, { goalId: g.id, phase: "complete" }, 4)!;
    expect(done.phase).toBe("complete");
    expect(applyGoalPatch(done, { goalId: g.id, phase: "paused" }, 5)!.phase).toBe("complete");
    expect(goalWantsWorker(done, false)).toBe(true); // the wrap-up is still owed
    expect(goalWantsWorker({ ...done, wrappedUp: true }, false)).toBe(false);
    expect(goalWantsWorker(r2, true)).toBe(false); // G3 hold
    expect(goalStatusLine({ ...r2, phase: "blocked", blockedReason: { code: "round-limit", message: "m" } })).toBe("Goal blocked (round-limit) · round 2/3");
  });

  test("user commands: pause only an active goal, resume only a paused one; each bumps rev", () => {
    const g = nextUserGoal(undefined, { action: "set", objective: "x", maxRounds: 99 }, 1)! as DirectGoal;
    expect(g.maxRounds).toBe(50);
    const p = nextUserGoal(g, { action: "pause" }, 2)!;
    expect([p.phase, p.rev]).toEqual(["paused", 2]);
    expect(() => nextUserGoal(p, { action: "pause" }, 3)).toThrow(/only an active goal/);
    expect(nextUserGoal(p, { action: "resume" }, 3)!.phase).toBe("active");
    expect(nextUserGoal(p, { action: "clear" }, 3)).toBeUndefined();
    expect(() => nextUserGoal(undefined, { action: "clear" }, 3)).toThrow(/no goal/);
  });
});

describe("directThreads goal mutations", () => {
  test("/goal in the thread sets the goal, wakes the thread, and is never a user message", async () => {
    const { t, taskId } = await setup();
    expect((await taskOf(t, taskId)).status).toBe("waiting_input");
    const r = await t.mutation(api.directThreads.send, { taskId, text: "/goal make the tests pass 3", clientId: "g1" });
    const again = await t.mutation(api.directThreads.send, { taskId, text: "/goal make the tests pass 3", clientId: "g1" });
    expect(again).toMatchObject({ eventId: r.eventId, deduped: true });
    const task = await taskOf(t, taskId);
    expect(task.status).toBe("queued");
    expect(task.direct?.goal).toMatchObject({ objective: "make the tests pass", maxRounds: 3, round: 0, phase: "active", rev: 1 });
    const types = await eventTypes(t, taskId);
    expect(types.filter((x) => x === "goal.updated")).toHaveLength(1);
    expect(types).not.toContain("user.message");
    await expect(t.mutation(api.directThreads.send, { taskId, text: "/goal", clientId: "g2" })).rejects.toThrow(/Usage: \/goal/);
  });

  test("setGoal / pauseGoal / resume / clearGoal", async () => {
    const { t, taskId } = await setup();
    await t.mutation(api.directThreads.setGoal, { taskId, objective: "ship it", maxRounds: 2 });
    await t.mutation(api.directThreads.pauseGoal, { taskId });
    expect((await taskOf(t, taskId)).direct?.goal?.phase).toBe("paused");
    await expect(t.mutation(api.directThreads.pauseGoal, { taskId })).rejects.toThrow(/paused/);
    await t.mutation(api.directThreads.setGoal, { taskId }); // no objective: resume
    expect((await taskOf(t, taskId)).direct?.goal).toMatchObject({ phase: "active", rev: 3 });
    await t.mutation(api.directThreads.clearGoal, { taskId });
    expect((await taskOf(t, taskId)).direct?.goal).toBeUndefined();
  });

  test("under the G3 hold a goal is stored but does not wake the thread", async () => {
    const { t, taskId } = await setup();
    await hold(t);
    await t.mutation(api.directThreads.setGoal, { taskId, objective: "ship it" });
    expect((await taskOf(t, taskId)).status).toBe("waiting_input");
  });

  test("poll carries the goal and the hold; the worker patch moves rounds; release keeps an active goal queued", async () => {
    const { t, taskId } = await setup();
    await t.mutation(api.directThreads.setGoal, { taskId, objective: "ship it", maxRounds: 3 });
    await t.mutation(internal.directThreads.claim, { workerId: "w1" });
    await t.run(async (ctx) => void (await ctx.db.patch(taskId, { leaseExpiresAt: Date.now() + 60_000 })));
    const poll = await t.query(internal.directThreads.poll, { taskId, workerId: "w1" });
    expect(poll?.automationHeld).toBe(false);
    const goalId = poll!.goal!.id;
    await t.mutation(internal.directThreads.appendEvents, {
      taskId,
      workerId: "w1",
      events: [{ type: "goal.prompt", eventKey: `goal.prompt:${goalId}:1`, payload: { goalId, kind: "round", round: 1, text: "<goal_round>" } }],
      state: { goal: { goalId, round: 1 } },
    });
    await t.mutation(internal.directThreads.appendEvents, { taskId, workerId: "w1", events: [], state: { goal: { goalId: "stale", phase: "complete" } } });
    expect((await taskOf(t, taskId)).direct?.goal).toMatchObject({ round: 1, phase: "active" });
    const r = await t.mutation(internal.directThreads.release, { taskId, workerId: "w1", reason: "MCP servers changed" });
    expect(r.status).toBe("queued");
    await t.mutation(internal.directThreads.claim, { workerId: "w1" });
    await hold(t);
    expect((await t.query(internal.directThreads.poll, { taskId, workerId: "w1" }))?.automationHeld).toBe(true);
    expect((await t.mutation(internal.directThreads.release, { taskId, workerId: "w1", reason: "idle" })).status).toBe("waiting_input");
  });
});
