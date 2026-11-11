/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  isMissedFixedTimeRun,
  isSameSchedule,
  MISSED_FIXED_TIME_GRACE_MS,
  nextScheduledRunAt,
  zonedParts,
  zonedTimeToUtc,
} from "./lib/schedule";

/** GOAT G7: the scheduled-task clock: next run, missed runs, one fire per occurrence, the G3 hold. */

const modules = import.meta.glob("./**/*.ts");
const MIN = 60_000;
const HOUR = 60 * MIN;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("lib/schedule next run", () => {
  test("interval adds elapsed time, also across a DST change", () => {
    // 2026-03-08 01:30 EST; clocks jump 02:00 → 03:00 in New York.
    const from = zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 1, minute: 30, second: 0 }, "America/New_York");
    expect(nextScheduledRunAt({ type: "interval", everyMs: HOUR }, from)).toBe(from + HOUR);
    // Below the 1-minute floor is raised to it.
    expect(nextScheduledRunAt({ type: "interval", everyMs: 5_000 }, from)).toBe(from + MIN);
  });

  test("time of day defaults to Asia/Jakarta (UTC+7)", () => {
    const from = Date.UTC(2026, 10, 12, 1, 0); // 08:00 WIB
    expect(nextScheduledRunAt({ type: "fixed_time", timeOfDay: "09:00" }, from)).toBe(Date.UTC(2026, 10, 12, 2, 0));
    // Already past today → tomorrow.
    expect(nextScheduledRunAt({ type: "fixed_time", timeOfDay: "07:30" }, from)).toBe(Date.UTC(2026, 10, 13, 0, 30));
  });

  test("time of day keeps the wall clock across DST (spring forward and fall back)", () => {
    const tz = "America/New_York";
    const s = { type: "fixed_time" as const, timeOfDay: "09:00", timeZone: tz };
    // The day before spring forward at 10:00 → next is 09:00 EDT on Mar 8 (13:00Z).
    const beforeSpring = zonedTimeToUtc({ year: 2026, month: 3, day: 7, hour: 10, minute: 0, second: 0 }, tz);
    const spring = nextScheduledRunAt(s, beforeSpring)!;
    expect(spring).toBe(Date.UTC(2026, 2, 8, 13, 0));
    expect(zonedParts(spring, tz)).toMatchObject({ day: 8, hour: 9, minute: 0 });
    // Fall back on Nov 1: 09:00 EST is 14:00Z.
    const beforeFall = zonedTimeToUtc({ year: 2026, month: 10, day: 31, hour: 10, minute: 0, second: 0 }, tz);
    expect(nextScheduledRunAt(s, beforeFall)).toBe(Date.UTC(2026, 10, 1, 14, 0));
    // A skipped wall time (02:30 on spring-forward day) lands at 03:30 EDT; an ambiguous one takes the earlier.
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, tz)).toBe(Date.UTC(2026, 2, 8, 7, 30));
    expect(zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 }, tz)).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });

  test("weekdays skip to the next matching local day", () => {
    // Friday 2026-11-13 10:00 WIB; Mon–Fri at 09:00 → Monday Nov 16, 09:00 WIB.
    const from = Date.UTC(2026, 10, 13, 3, 0);
    const next = nextScheduledRunAt({ type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] }, from);
    expect(next).toBe(Date.UTC(2026, 10, 16, 2, 0));
  });

  test("bad input has no next run; schedules compare structurally", () => {
    expect(nextScheduledRunAt({ type: "fixed_time", timeOfDay: "25:00" }, 0)).toBeNull();
    expect(nextScheduledRunAt({ type: "fixed_time", timeOfDay: "09:00", timeZone: "Mars/Base" }, 0)).toBeNull();
    expect(isSameSchedule({ type: "fixed_time", timeOfDay: "9:00" }, { type: "fixed_time", timeOfDay: "09:00", timeZone: "Asia/Jakarta" })).toBe(true);
    expect(isSameSchedule({ type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] }, { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] })).toBe(true);
    expect(isSameSchedule({ type: "fixed_time", timeOfDay: "09:00" }, { type: "fixed_time", timeOfDay: "09:00", timeZone: "UTC" })).toBe(false);
    expect(isSameSchedule({ type: "interval", everyMs: MIN }, { type: "fixed_time", timeOfDay: "09:00" })).toBe(false);
  });

  test("missed-run detection: fixed time past the 10-minute grace, never an interval", () => {
    const fixed = { type: "fixed_time" as const, timeOfDay: "09:00" };
    expect(isMissedFixedTimeRun(fixed, 0, MISSED_FIXED_TIME_GRACE_MS)).toBe(false);
    expect(isMissedFixedTimeRun(fixed, 0, MISSED_FIXED_TIME_GRACE_MS + 1)).toBe(true);
    expect(isMissedFixedTimeRun({ type: "interval", everyMs: MIN }, 0, 10 * HOUR)).toBe(false);
  });
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
    const conversationId = await ctx.db.insert("conversations", { projectId, kind: "project", status: "active", createdAt: 1 });
    return { projectId, conversationId };
  });
  return { t, ...ids };
}
type T = Awaited<ReturnType<typeof setup>>["t"];

const runs = (t: T) => t.run(async (ctx) => await ctx.db.query("scheduledTaskRuns").collect());
const tasks = (t: T) => t.run(async (ctx) => await ctx.db.query("tasks").collect());
const nextOf = (t: T, id: Id<"scheduledTasks">) => t.run(async (ctx) => (await ctx.db.get(id))?.nextRunAt);

describe("scheduledTasks tick", () => {
  test("a due task creates one task; a double tick dispatches once", async () => {
    const { t, projectId } = await setup();
    vi.setSystemTime(Date.UTC(2026, 10, 12, 1, 0));
    const id = await t.mutation(api.scheduledTasks.create, {
      projectId,
      name: "Nightly deps",
      schedule: { type: "interval", everyMs: HOUR },
      target: { kind: "task", command: "update dependencies" },
    });
    const dueAt = (await nextOf(t, id))!;
    expect(dueAt).toBe(Date.now() + HOUR);
    expect(await t.mutation(internal.scheduledTasks.tick, { now: dueAt - 1 })).toMatchObject({ dispatched: 0 });
    const now = dueAt + 5_000;
    const [a, b] = await Promise.all([
      t.mutation(internal.scheduledTasks.tick, { now }),
      t.mutation(internal.scheduledTasks.tick, { now }),
    ]);
    expect(a.dispatched + b.dispatched).toBe(1);
    await t.mutation(internal.scheduledTasks.tick, { now });
    // The same occurrence fired straight at `fire` again does nothing.
    expect(await t.mutation(internal.scheduledTasks.fire, { scheduledTaskId: id, dueAt, now })).toEqual({ status: "stale" });
    const created = await tasks(t);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ command: "update dependencies", status: "queued", idempotencyKey: `sched:${id}:${dueAt}` });
    const r = await runs(t);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ status: "dispatched", dueAt, taskId: created[0]._id });
    expect(await nextOf(t, id)).toBe(now + HOUR);
  });

  test("held = no fire: the occurrence records held and is skipped; resuming fires the next", async () => {
    const { t, projectId } = await setup();
    vi.setSystemTime(Date.UTC(2026, 10, 12, 1, 0));
    const id = await t.mutation(api.scheduledTasks.create, {
      projectId,
      name: "Hourly",
      schedule: { type: "interval", everyMs: HOUR },
      target: { kind: "task", command: "check" },
    });
    await t.mutation(api.appSettings.setAutomationHold, { held: true, reason: "away" });
    const first = (await nextOf(t, id))!;
    expect(await t.mutation(internal.scheduledTasks.tick, { now: first })).toMatchObject({ held: 1, dispatched: 0 });
    expect(await tasks(t)).toHaveLength(0);
    expect((await runs(t))[0]).toMatchObject({ status: "held", dueAt: first });
    await t.mutation(api.appSettings.setAutomationHold, { held: false });
    const second = (await nextOf(t, id))!;
    expect(second).toBe(first + HOUR);
    expect(await t.mutation(internal.scheduledTasks.tick, { now: second })).toMatchObject({ dispatched: 1 });
    expect(await tasks(t)).toHaveLength(1);
  });

  test("a fixed-time run more than 10 minutes late is recorded missed, not fired", async () => {
    const { t, projectId } = await setup();
    vi.setSystemTime(Date.UTC(2026, 10, 12, 1, 0)); // 08:00 WIB
    const id = await t.mutation(api.scheduledTasks.create, {
      projectId,
      name: "Standup",
      schedule: { type: "fixed_time", timeOfDay: "09:00" },
      target: { kind: "task", command: "summarise yesterday" },
    });
    const dueAt = (await nextOf(t, id))!;
    expect(dueAt).toBe(Date.UTC(2026, 10, 12, 2, 0));
    expect(await t.mutation(internal.scheduledTasks.tick, { now: dueAt + 11 * MIN })).toMatchObject({ missed: 1, dispatched: 0 });
    expect(await tasks(t)).toHaveLength(0);
    expect((await runs(t))[0]).toMatchObject({ status: "missed", dueAt });
    expect(await nextOf(t, id)).toBe(dueAt + 24 * HOUR);
  });

  test("a conversation target sends once into the bound chat and starts no task", async () => {
    const { t, projectId, conversationId } = await setup();
    vi.setSystemTime(Date.UTC(2026, 10, 12, 1, 0));
    const id = await t.mutation(api.scheduledTasks.create, {
      projectId,
      name: "Morning brief",
      schedule: { type: "interval", everyMs: 30 * MIN },
      target: { kind: "conversation", conversationId, content: "What changed overnight?" },
    });
    const dueAt = (await nextOf(t, id))!;
    await t.mutation(internal.scheduledTasks.tick, { now: dueAt });
    await t.mutation(internal.scheduledTasks.tick, { now: dueAt });
    const messages = await t.run(async (ctx) => await ctx.db.query("messages").collect());
    const sent = messages.filter((m) => m.content === "What changed overnight?");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ conversationId, projectId, clientId: `sched:${id}:${dueAt}`, authorType: "user", replyStatus: "pending" });
    expect(await tasks(t)).toHaveLength(0);
  });

  test("a failing target records failed and does not block other rows", async () => {
    const { t, projectId, conversationId } = await setup();
    vi.setSystemTime(Date.UTC(2026, 10, 12, 1, 0));
    const bad = await t.mutation(api.scheduledTasks.create, {
      projectId,
      name: "Closed chat",
      schedule: { type: "interval", everyMs: HOUR },
      target: { kind: "conversation", conversationId, content: "ping" },
    });
    await t.mutation(api.scheduledTasks.create, {
      projectId,
      name: "Good",
      schedule: { type: "interval", everyMs: HOUR },
      target: { kind: "task", command: "run" },
    });
    await t.run(async (ctx) => ctx.db.patch(conversationId, { status: "closed" }));
    expect(await t.mutation(internal.scheduledTasks.tick, { now: Date.now() + HOUR })).toMatchObject({ failed: 1, dispatched: 1 });
    const failed = (await runs(t)).find((r) => r.scheduledTaskId === bad)!;
    expect(failed).toMatchObject({ status: "failed", error: "The bound conversation is closed" });
    expect(await nextOf(t, bad)).toBe(Date.now() + 2 * HOUR);
  });

  test("create validates the schedule and the target's project", async () => {
    const { t, projectId } = await setup();
    const task = { kind: "task" as const, command: "c" };
    await expect(
      t.mutation(api.scheduledTasks.create, { projectId, name: "x", schedule: { type: "fixed_time", timeOfDay: "9am" }, target: task }),
    ).rejects.toThrow(/HH:MM/);
    await expect(
      t.mutation(api.scheduledTasks.create, { projectId, name: "x", schedule: { type: "fixed_time", timeOfDay: "09:00", timeZone: "Nowhere/City" }, target: task }),
    ).rejects.toThrow(/time zone/);
    const otherConversation = await t.run(async (ctx) => {
      const other = await ctx.db.insert("projects", { name: "Q", workspacePath: "/tmp/q" });
      return await ctx.db.insert("conversations", { projectId: other, kind: "project", status: "active", createdAt: 1 });
    });
    await expect(
      t.mutation(api.scheduledTasks.create, {
        projectId,
        name: "x",
        schedule: { type: "interval", everyMs: HOUR },
        target: { kind: "conversation", conversationId: otherConversation, content: "hi" },
      }),
    ).rejects.toThrow(/does not belong/);
  });
});
