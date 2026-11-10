/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { appendTaskEvent, appendAgentEvent } from "./lib/taskEvents";
import {
  compareSequenced,
  decideResume,
  hasGap,
  highWater,
  mergeSequenced,
  replayEncodedBytes,
  RESUME_MAX_REPLAY_EVENTS,
} from "./lib/eventResume";

const modules = import.meta.glob("./**/*.ts");

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
    const taskId = await ctx.db.insert("tasks", { projectId, title: "T", command: "do", status: "running" });
    const otherTaskId = await ctx.db.insert("tasks", { projectId, title: "U", command: "do", status: "running" });
    return { projectId, taskId, otherTaskId };
  });
  return { t, ...ids };
}

describe("appendTaskEvent (numbered events)", () => {
  test("assigns 1..n per task, independently per task", async () => {
    const { t, projectId, taskId, otherTaskId } = await seed();
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i += 1) await appendTaskEvent(ctx, { taskId, projectId, type: `e${i}` });
      await appendTaskEvent(ctx, { taskId: otherTaskId, projectId, type: "x" });
    });
    const rows = await t.run((ctx) => ctx.db.query("taskEvents").collect());
    expect(rows.filter((r) => r.taskId === taskId).map((r) => r.sequence)).toEqual([1, 2, 3]);
    expect(rows.filter((r) => r.taskId === otherTaskId).map((r) => r.sequence)).toEqual([1]);
    expect(rows.every((r) => typeof r.createdAt === "number")).toBe(true);
  });

  test("continues after legacy rows that have no sequence", async () => {
    const { t, projectId, taskId } = await seed();
    await t.run(async (ctx) => {
      await ctx.db.insert("taskEvents", { taskId, projectId, type: "legacy.a" });
      await ctx.db.insert("taskEvents", { taskId, projectId, type: "legacy.b" });
      await appendTaskEvent(ctx, { taskId, projectId, type: "new" });
    });
    const list = await t.query(api.taskEvents.listByTask, { taskId });
    expect(list.map((r) => r.type)).toEqual(["legacy.a", "legacy.b", "new"]);
    expect(list[2].sequence).toBe(1);
  });

  test("logEvent (worker path) numbers events and its canonical agentEvents", async () => {
    const { t, projectId, taskId } = await seed();
    await t.mutation(internal.orchestration.logEvent, { taskId, projectId, type: "subtask.started", subtaskKey: "a" });
    await t.mutation(internal.orchestration.logEvent, { taskId, projectId, type: "subtask.completed", subtaskKey: "a" });
    const events = await t.query(api.taskEvents.listByTask, { taskId });
    expect(events.map((e) => e.sequence)).toEqual([1, 2]);
    const canon = await t.query(api.orchestration.listAgentEvents, { taskId });
    const seqs = canon.map((e) => e.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test("appendAgentEvent sequences per task", async () => {
    const { t, projectId, taskId } = await seed();
    await t.run(async (ctx) => {
      await appendAgentEvent(ctx, { projectId, taskId, type: "a" });
      await appendAgentEvent(ctx, { projectId, taskId, type: "b" });
    });
    const canon = await t.query(api.orchestration.listAgentEvents, { taskId });
    expect(canon.map((e) => [e.type, e.sequence])).toEqual([["a", 1], ["b", 2]]);
  });
});

describe("listByTask newest window", () => {
  test("returns the newest events oldest-first, so long tasks keep showing new ones", async () => {
    const { t, projectId, taskId } = await seed();
    await t.run(async (ctx) => {
      for (let i = 1; i <= 30; i += 1) await appendTaskEvent(ctx, { taskId, projectId, type: `e${i}` });
    });
    const list = await t.query(api.taskEvents.listByTask, { taskId, limit: 10 });
    expect(list.map((r) => r.sequence)).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
  });

  test("pageByTask walks older history with a cursor", async () => {
    const { t, projectId, taskId } = await seed();
    await t.run(async (ctx) => {
      await ctx.db.insert("taskEvents", { taskId, projectId, type: "legacy" });
      for (let i = 1; i <= 5; i += 1) await appendTaskEvent(ctx, { taskId, projectId, type: `e${i}` });
    });
    const first = await t.query(api.taskEvents.pageByTask, { taskId, paginationOpts: { numItems: 3, cursor: null } });
    expect(first.page.map((r) => r.sequence)).toEqual([5, 4, 3]);
    const second = await t.query(api.taskEvents.pageByTask, { taskId, paginationOpts: { numItems: 3, cursor: first.continueCursor } });
    expect(second.page.map((r) => r.type)).toEqual(["e2", "e1", "legacy"]);
  });

  test("agent events: newest window, not the oldest", async () => {
    const { t, projectId, taskId } = await seed();
    await t.run(async (ctx) => {
      for (let i = 0; i < 12; i += 1) await appendAgentEvent(ctx, { projectId, taskId, type: `c${i}` });
    });
    const canon = await t.query(api.orchestration.listAgentEvents, { taskId, limit: 5 });
    expect(canon.map((e) => e.sequence)).toEqual([8, 9, 10, 11, 12]);
  });
});

describe("sinceByTask (reconnect)", () => {
  test("replays a small gap", async () => {
    const { t, projectId, taskId } = await seed();
    await t.run(async (ctx) => {
      for (let i = 1; i <= 8; i += 1) await appendTaskEvent(ctx, { taskId, projectId, type: `e${i}` });
    });
    const res = await t.query(api.taskEvents.sinceByTask, { taskId, afterSequence: 5 });
    expect(res.mode).toBe("replay");
    expect(res.events.map((e) => e.sequence)).toEqual([6, 7, 8]);
    expect(res.highWater).toBe(8);
  });

  test("falls back to a snapshot past the replay bound", async () => {
    const { t, projectId, taskId } = await seed();
    await t.run(async (ctx) => {
      for (let i = 1; i <= RESUME_MAX_REPLAY_EVENTS + 5; i += 1) await appendTaskEvent(ctx, { taskId, projectId, type: "e" });
    });
    const res = await t.query(api.taskEvents.sinceByTask, { taskId, afterSequence: 1, limit: 4 });
    expect(res.mode).toBe("snapshot");
    expect(res.events.map((e) => e.sequence)).toEqual([130, 131, 132, 133]);
  });
});

describe("eventResume helpers", () => {
  test("decideResume bounds", () => {
    expect(decideResume({ afterSequence: 3, highWater: 10, replayEventCount: 7, replayEncodedBytes: 100 })).toEqual({
      mode: "replay",
      afterSequence: 3,
      throughSequence: 10,
    });
    expect(decideResume({ afterSequence: 11, highWater: 10, replayEventCount: 0, replayEncodedBytes: 0 }).mode).toBe("snapshot");
    expect(decideResume({ afterSequence: 0, highWater: 500, replayEventCount: 129, replayEncodedBytes: 1 }).mode).toBe("snapshot");
    expect(decideResume({ afterSequence: 0, highWater: 5, replayEventCount: 5, replayEncodedBytes: 2_000_000 }).mode).toBe("snapshot");
  });

  test("replayEncodedBytes counts UTF-8 and stops past the limit", () => {
    expect(replayEncodedBytes([{ a: "é" }])).toBe(JSON.stringify({ a: "é" }).length + 1);
    expect(replayEncodedBytes(["x".repeat(100), "y".repeat(100)], 50)).toBeLessThan(150);
  });

  test("legacy rows order before numbered rows; merge dedupes by id", () => {
    const legacy = { _id: "l", _creationTime: 5 };
    const a = { _id: "a", sequence: 1, _creationTime: 9 };
    const b = { _id: "b", sequence: 2, _creationTime: 7 };
    expect([b, a, legacy].sort(compareSequenced).map((r) => r._id)).toEqual(["l", "a", "b"]);
    expect(mergeSequenced([legacy, a], [a, b]).map((r) => r._id)).toEqual(["l", "a", "b"]);
    expect(highWater([legacy, a, b])).toBe(2);
    expect(hasGap(2, [{ _id: "c", sequence: 3, _creationTime: 1 }])).toBe(false);
    expect(hasGap(2, [{ _id: "d", sequence: 9, _creationTime: 1 }])).toBe(true);
    expect(hasGap(0, [{ _id: "d", sequence: 9, _creationTime: 1 }])).toBe(false);
  });
});
