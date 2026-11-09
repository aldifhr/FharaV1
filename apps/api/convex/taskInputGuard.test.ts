/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { decideTaskInput } from "./lib/taskInputGuard";

/**
 * Single input guard (admitTaskInput): every refusal reason, and that an
 * admitted input is recorded undelivered until the worker acks it.
 */

const modules = import.meta.glob("./**/*.ts");

type Status = "queued" | "running" | "needs_approval" | "waiting_input" | "done" | "rejected" | "failed";

async function seedTask(
  t: ReturnType<typeof convexTest>,
  status: Status,
  opts: { question?: string; approval?: "plain" | "plan" } = {}
) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "T",
      command: "do it",
      status,
      ...(opts.question ? { pendingQuestion: opts.question } : {}),
    });
    if (opts.approval) {
      await ctx.db.insert("approvals", {
        taskId,
        projectId,
        kind: "apply_changes",
        summary: "Apply",
        status: "pending",
        ...(opts.approval === "plan" ? { payload: { stage: "plan" } } : {}),
      });
    }
    return taskId;
  });
}

async function inputs(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => await ctx.db.query("taskInputs").collect());
}

describe("decideTaskInput (pure)", () => {
  const pending = { status: "pending" as const, payload: undefined };
  test("reason codes", () => {
    expect(decideTaskInput({ status: "done" }, [], "steer")).toEqual({ ok: false, reason: "terminal" });
    expect(decideTaskInput({ status: "failed" }, [pending], "answer")).toEqual({ ok: false, reason: "terminal" });
    expect(decideTaskInput({ status: "running" }, [pending], "steer")).toEqual({ ok: false, reason: "awaiting_approval" });
    expect(decideTaskInput({ status: "needs_approval" }, [], "steer")).toEqual({ ok: false, reason: "awaiting_approval" });
    expect(
      decideTaskInput({ status: "running" }, [{ status: "pending", payload: { stage: "plan" } }], "steer")
    ).toEqual({ ok: false, reason: "awaiting_plan_approval" });
    expect(decideTaskInput({ status: "waiting_input", pendingQuestion: "Q?" }, [], "steer")).toEqual({ ok: false, reason: "not_running" });
    expect(decideTaskInput({ status: "running" }, [], "answer")).toEqual({ ok: false, reason: "question_mismatch" });
    expect(decideTaskInput({ status: "waiting_input", pendingQuestion: "New?" }, [], "answer", "Old?")).toEqual({
      ok: false,
      reason: "question_mismatch",
    });
    expect(decideTaskInput({ status: "running" }, [{ status: "approved", payload: undefined }], "steer")).toEqual({ ok: true });
    expect(decideTaskInput({ status: "queued" }, [], "steer")).toEqual({ ok: true });
    expect(decideTaskInput({ status: "waiting_input", pendingQuestion: "Q?" }, [], "answer", "Q?")).toEqual({ ok: true });
  });
});

describe("steerTask through the guard", () => {
  test("refuses while an approval is pending, so a steer never answers a permission prompt", async () => {
    const t = convexTest(schema, modules);
    const taskId = await seedTask(t, "running", { approval: "plain" });
    const res = await t.mutation(api.tasks.steerTask, { taskId, instruction: "yes do it" });
    expect(res).toEqual({ applied: false, reason: "awaiting_approval" });
    expect(await inputs(t)).toHaveLength(0);
  });

  test("refuses while a plan approval is pending", async () => {
    const t = convexTest(schema, modules);
    const taskId = await seedTask(t, "running", { approval: "plan" });
    expect(await t.mutation(api.tasks.steerTask, { taskId, instruction: "x" })).toEqual({
      applied: false,
      reason: "awaiting_plan_approval",
    });
  });

  test("refuses a terminal task", async () => {
    const t = convexTest(schema, modules);
    const taskId = await seedTask(t, "done");
    expect(await t.mutation(api.tasks.steerTask, { taskId, instruction: "x" })).toEqual({ applied: false, reason: "terminal" });
  });

  test("refuses a task paused on a question (not_running)", async () => {
    const t = convexTest(schema, modules);
    const taskId = await seedTask(t, "waiting_input", { question: "Which?" });
    expect(await t.mutation(api.tasks.steerTask, { taskId, instruction: "x" })).toEqual({ applied: false, reason: "not_running" });
  });

  test("an admitted steer is recorded undelivered, then acked by the worker", async () => {
    const t = convexTest(schema, modules);
    const taskId = await seedTask(t, "running");
    expect(await t.mutation(api.tasks.steerTask, { taskId, instruction: "  add tests  " })).toEqual({ applied: true });
    const [row] = await inputs(t);
    expect(row).toMatchObject({ kind: "steer", text: "add tests", delivered: false });
    expect(row.deliveredAt).toBeUndefined();

    const pending = await t.query(internal.orchestration.listPendingTaskInputs, { taskId });
    expect(pending.map((p) => p._id)).toEqual([row._id]);
    expect(await t.mutation(internal.orchestration.markTaskInputsDelivered, { inputIds: [row._id] })).toEqual({ marked: 1 });
    // Idempotent: a second ack changes nothing.
    expect(await t.mutation(internal.orchestration.markTaskInputsDelivered, { inputIds: [row._id] })).toEqual({ marked: 0 });
    const [after] = await inputs(t);
    expect(after.delivered).toBe(true);
    expect(typeof after.deliveredAt).toBe("number");
    expect(await t.query(internal.orchestration.listPendingTaskInputs, { taskId })).toHaveLength(0);
  });

  test("works when the task has no task context yet (M9: text was silently dropped)", async () => {
    const t = convexTest(schema, modules);
    const taskId = await seedTask(t, "queued");
    expect(await t.mutation(api.tasks.steerTask, { taskId, instruction: "first" })).toEqual({ applied: true });
    expect(await t.query(internal.orchestration.listPendingTaskInputs, { taskId })).toHaveLength(1);
  });
});

describe("answerQuestion through the guard", () => {
  test("lands only on the question that is still open", async () => {
    const t = convexTest(schema, modules);
    const taskId = await seedTask(t, "waiting_input", { question: "Which colour?" });
    const stale = await t.mutation(api.tasks.answerQuestion, { taskId, answer: "blue", question: "Which font?" });
    expect(stale).toEqual({ applied: false, reason: "question_mismatch" });
    const ok = await t.mutation(api.tasks.answerQuestion, { taskId, answer: "blue", question: "Which colour?" });
    expect(ok).toEqual({ applied: true });
    const [row] = await inputs(t);
    expect(row).toMatchObject({ kind: "answer", text: "blue", question: "Which colour?", delivered: false });
    // Answered: the question is closed, so a second answer is refused.
    expect(await t.mutation(api.tasks.answerQuestion, { taskId, answer: "red" })).toEqual({
      applied: false,
      reason: "question_mismatch",
    });
  });

  test("refuses while an approval is pending", async () => {
    const t = convexTest(schema, modules);
    const taskId = await seedTask(t, "waiting_input", { question: "Q?", approval: "plain" });
    expect(await t.mutation(api.tasks.answerQuestion, { taskId, answer: "a" })).toEqual({
      applied: false,
      reason: "awaiting_approval",
    });
  });

  test("refuses a terminal task", async () => {
    const t = convexTest(schema, modules);
    const taskId = await seedTask(t, "rejected");
    expect(await t.mutation(api.tasks.answerQuestion, { taskId, answer: "a" })).toEqual({ applied: false, reason: "terminal" });
  });
});
