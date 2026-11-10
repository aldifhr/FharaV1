/// <reference types="vite/client" />
/**
 * O3 + L7: a task whose LLM provider is offline, rate-limited (429), out
 * of quota or refusing its credentials is put on hold (paused, pausedBy
 * "held") instead of failing, resumes with exponential backoff (cap ~30
 * min) or on the user's Resume, and is never killed by the watchdog.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  classifyProviderHold,
  HOLD_MAX_DELAY_MS,
  holdBackoffMs,
  holdNoticeText,
  nextHoldState,
  watchdogMayFail,
} from "./lib/providerHold";

const modules = import.meta.glob("./**/*.ts");
const MIN = 60_000;

describe("classifyProviderHold", () => {
  test("LLM HTTP failures map to their hold kind", () => {
    const at = (code: number, extra = "") => `LLM request failed (${code}) for model "gpt-x" at https://api.example.com/v1/chat/completions${extra}`;
    expect(classifyProviderHold(at(429))).toMatchObject({ kind: "rate_limit" });
    expect(classifyProviderHold(at(429, ': {"error":{"code":"insufficient_quota"}}'))).toMatchObject({ kind: "quota" });
    expect(classifyProviderHold(at(402))).toMatchObject({ kind: "quota" });
    expect(classifyProviderHold(at(401))).toMatchObject({ kind: "auth" });
    expect(classifyProviderHold(at(403))).toMatchObject({ kind: "auth" });
    expect(classifyProviderHold(at(503))).toMatchObject({ kind: "offline" });
    // Not a provider outage: a bad request or a missing model still fails.
    expect(classifyProviderHold(at(400))).toBeNull();
    expect(classifyProviderHold(at(404))).toBeNull();
  });

  test("the circuit breaker excluding every connection is offline", () => {
    expect(
      classifyProviderHold(
        "No LLM provider available for Coder: every candidate connection is temporarily excluded by the circuit breaker after repeated transient failures. Candidates: a, b."
      )
    ).toMatchObject({ kind: "offline" });
  });

  test("a failure summary carrying a provider error is held", () => {
    expect(classifyProviderHold("s2 (attempt 1): LLM request failed (429) for model \"m\" at x; s3: skipped")).toMatchObject({ kind: "rate_limit" });
    expect(classifyProviderHold("Planner LLM call failed: fetch failed (ECONNREFUSED 127.0.0.1:11434)")).toMatchObject({ kind: "offline" });
    expect(classifyProviderHold("OpenAI provider: Rate limit reached for requests")).toMatchObject({ kind: "rate_limit" });
    expect(classifyProviderHold("model provider error: Invalid API key provided")).toMatchObject({ kind: "auth" });
  });

  test("ordinary failures are not held", () => {
    expect(classifyProviderHold(undefined)).toBeNull();
    expect(classifyProviderHold("Verification failed: 3 tests failed")).toBeNull();
    expect(classifyProviderHold("git push failed: remote: 401 Unauthorized")).toBeNull();
    expect(classifyProviderHold("npm install: ECONNREFUSED registry.npmjs.org")).toBeNull();
    expect(classifyProviderHold("Objective not satisfied after 2 replan(s): login page")).toBeNull();
  });
});

describe("hold backoff", () => {
  test("doubles from 1 min and caps at 30 min", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map((n) => holdBackoffMs(n) / MIN)).toEqual([1, 2, 4, 8, 16, 30, 30, 30]);
    expect(holdBackoffMs(0)).toBe(MIN);
    expect(holdBackoffMs(1e9)).toBe(HOLD_MAX_DELAY_MS);
  });

  test("attempts carry over between holds", () => {
    const first = nextHoldState(undefined, { kind: "rate_limit", reason: "r" }, 1000, "x".repeat(900));
    expect(first).toMatchObject({ attempts: 1, heldAt: 1000, resumeAt: 1000 + MIN });
    expect(first.detail).toHaveLength(500);
    expect(nextHoldState(first, { kind: "offline", reason: "o" }, 5000)).toMatchObject({ attempts: 2, resumeAt: 5000 + 2 * MIN, kind: "offline" });
  });

  test("notice text and watchdog rule", () => {
    expect(holdNoticeText({ kind: "rate_limit", reason: "The LLM provider is rate-limiting requests (429)", resumeAt: 4 * MIN }, 0)).toBe(
      "On hold: The LLM provider is rate-limiting requests (429). Retrying automatically in 4 min."
    );
    expect(holdNoticeText({ kind: "auth", reason: "The LLM provider refused the credentials (401)", resumeAt: 10_000 }, 0)).toContain("Check the provider key");
    expect(watchdogMayFail({ status: "running" })).toBe(true);
    expect(watchdogMayFail({ status: "paused", pausedBy: "held" })).toBe(false);
    expect(watchdogMayFail({ status: "running", pausedBy: "held" })).toBe(false);
  });
});

async function seedRunning(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "t",
      command: "c",
      status: "running",
      workerId: "w1",
      leaseExpiresAt: Date.now() + 60 * MIN,
      updatedAt: Date.now(),
    });
    return { projectId, taskId };
  });
}

const RATE_LIMITED = 'LLM request failed (429) for model "m" at https://p/v1/chat/completions: rate limit';

describe("hold lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a provider failure holds the task instead of failing it, with no incident", async () => {
    const t = convexTest(schema, modules);
    const { taskId } = await seedRunning(t);
    const result = await t.mutation(internal.orchestration.completeTask, { taskId, status: "failed", errorMessage: RATE_LIMITED, workerId: "w1" });
    expect(result).toMatchObject({ applied: true, status: "paused", held: true });
    const task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task).toMatchObject({ status: "paused", pausedBy: "held", hold: { kind: "rate_limit", attempts: 1 } });
    expect(task?.workerId).toBeUndefined();
    expect(task?.leaseExpiresAt).toBeUndefined();
    expect(task?.completedAt).toBeUndefined();
    expect(task!.hold!.resumeAt - task!.hold!.heldAt).toBe(MIN);
    expect(await t.run((ctx) => ctx.db.query("incidents").collect())).toHaveLength(0);
    const events = await t.run((ctx) => ctx.db.query("taskEvents").collect());
    expect(events.some((e) => e.type === "task.held")).toBe(true);
    expect(events.some((e) => e.type === "task.failed")).toBe(false);
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.some((s) => s.name.includes("autoResumeHeld"))).toBe(true);
  });

  test("an ordinary failure still fails", async () => {
    const t = convexTest(schema, modules);
    const { taskId } = await seedRunning(t);
    await t.mutation(internal.orchestration.completeTask, { taskId, status: "failed", errorMessage: "Verification failed", workerId: "w1" });
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.status).toBe("failed");
  });

  test("the backoff resume requeues the task; a second hold waits twice as long", async () => {
    const t = convexTest(schema, modules);
    const { taskId } = await seedRunning(t);
    await t.mutation(internal.orchestration.completeTask, { taskId, status: "failed", errorMessage: RATE_LIMITED, workerId: "w1" });
    // A stale schedule (wrong attempt) is a no-op.
    expect(await t.mutation(internal.taskControl.autoResumeHeld, { taskId, attempt: 7 })).toMatchObject({ resumed: false });
    expect(await t.mutation(internal.taskControl.autoResumeHeld, { taskId, attempt: 1 })).toMatchObject({ resumed: true });
    expect(await t.run((ctx) => ctx.db.get(taskId))).toMatchObject({ status: "queued", hold: { attempts: 1 } });
    // Claimed again, still rate-limited.
    await t.run((ctx) => ctx.db.patch(taskId, { status: "running", workerId: "w1", leaseExpiresAt: Date.now() + 60 * MIN }));
    await t.mutation(internal.orchestration.completeTask, { taskId, status: "failed", errorMessage: RATE_LIMITED, workerId: "w1" });
    const task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task).toMatchObject({ status: "paused", pausedBy: "held", hold: { attempts: 2 } });
    expect(task!.hold!.resumeAt - task!.hold!.heldAt).toBe(2 * MIN);
  });

  test("the user's Resume retries now and resets the backoff; a user Pause cancels the automatic resume", async () => {
    const t = convexTest(schema, modules);
    const { taskId } = await seedRunning(t);
    await t.mutation(internal.orchestration.completeTask, { taskId, status: "failed", errorMessage: RATE_LIMITED, workerId: "w1" });
    expect(await t.mutation(api.taskControl.resume, { taskId })).toMatchObject({ resumed: true, status: "queued" });
    const resumed = await t.run((ctx) => ctx.db.get(taskId));
    expect(resumed).toMatchObject({ status: "queued" });
    expect(resumed?.hold).toBeUndefined();
    expect(resumed?.pausedBy).toBeUndefined();
    // The old schedule no longer applies.
    expect(await t.mutation(internal.taskControl.autoResumeHeld, { taskId, attempt: 1 })).toMatchObject({ resumed: false });

    await t.run((ctx) => ctx.db.patch(taskId, { status: "running", workerId: "w1", leaseExpiresAt: Date.now() + 60 * MIN }));
    await t.mutation(internal.orchestration.completeTask, { taskId, status: "failed", errorMessage: RATE_LIMITED, workerId: "w1" });
    expect(await t.mutation(api.taskControl.pause, { taskId })).toMatchObject({ paused: true, changed: true });
    const paused = await t.run((ctx) => ctx.db.get(taskId));
    expect(paused).toMatchObject({ status: "paused", pausedBy: "user" });
    expect(paused?.hold).toBeUndefined();
    expect(await t.mutation(internal.taskControl.autoResumeHeld, { taskId, attempt: 1 })).toMatchObject({ resumed: false });
  });

  test("the watchdog never kills a held task", async () => {
    const t = convexTest(schema, modules);
    const { taskId } = await seedRunning(t);
    await t.mutation(internal.orchestration.completeTask, { taskId, status: "failed", errorMessage: RATE_LIMITED, workerId: "w1" });
    // Long after the stuck window and the hold's own resume time.
    const result = await t.mutation(internal.taskWatchdog.run, { now: Date.now() + 120 * MIN, stuckMs: 30 * MIN });
    expect(result.failed).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.status).toBe("paused");
  });

  test("a cancelled held task stays cancelled when its resume fires", async () => {
    const t = convexTest(schema, modules);
    const { taskId } = await seedRunning(t);
    await t.mutation(internal.orchestration.completeTask, { taskId, status: "failed", errorMessage: RATE_LIMITED, workerId: "w1" });
    await t.mutation(api.tasks.cancel, { taskId });
    expect(await t.mutation(internal.taskControl.autoResumeHeld, { taskId, attempt: 1 })).toMatchObject({ resumed: false });
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.status).toBe("cancelled");
  });
});
