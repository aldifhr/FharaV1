/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { observationsFromEvent, providerErrorCode } from "./lib/observations";
import { extractRequirementsFallback } from "./lib/requirements";

/** Plan 025: requirements traceability + execution observations (backend). */

const modules = import.meta.glob("./**/*.ts");
const REQUEST = "Implement auth: login, register, logout, dan refresh token";

describe("observation mapping (deterministic)", () => {
  test("maps the run's existing events to typed observations", () => {
    const at = 1000;
    const kinds = (type: string, payload: unknown, extra: Record<string, unknown> = {}) =>
      observationsFromEvent({ type, payload, createdAt: at, ...extra }).map((o) => o.eventType);

    expect(kinds("subtask.completed", { subtaskKey: "a" })).toEqual(["agent_completed"]);
    expect(kinds("subtask.failed", { subtaskKey: "a", error: "TypeError: x is undefined" })).toEqual(["agent_failed"]);
    expect(kinds("subtask.failed", { error: "OpenAI 429 Too Many Requests" })).toEqual(["provider_error"]);
    expect(kinds("subtask.failed", { error: "Subtask timed out after 600000ms" })).toEqual(["no_progress"]);
    expect(kinds("task.check", { label: "verify:test", status: "failed", details: "2 failing" })).toEqual(["test_failed"]);
    expect(kinds("task.check", { label: "verify:typecheck", status: "failed" })).toEqual(["gate_failed"]);
    expect(kinds("task.check", { label: "verify:test", status: "passed" })).toEqual([]);
    expect(kinds("qa.failed", { findings: ["submit button missing"] })).toEqual(["test_failed"]);
    expect(kinds("native.change.rejected", { files: ["apps/api/schema.ts"] })).toEqual(["scope_violation"]);
    expect(kinds("permission.denied", { action: "apply_changes", reason: "outside workspace" })).toEqual(["scope_violation"]);
    expect(kinds("subtask.escalated", { kind: "out_of_scope", detail: "x.ts", reason: "r" })).toEqual(["scope_violation"]);
    expect(kinds("subtask.escalated", { kind: "ambiguous", reason: "r" })).toEqual([]);
    expect(kinds("subtask.blocked", { subtaskKey: "b", reason: "dependency a failed" })).toEqual(["dependency_blocked"]);
    expect(kinds("task.stalled", { reason: "no new output for 10 min" })).toEqual(["no_progress"]);
    // Deadlock & stall detector events map 1:1.
    expect(kinds("stall.agent_stalled", { kind: "agent_stalled", reason: "no progress" })).toEqual(["no_progress"]);
    expect(kinds("stall.repeated_output", { reason: "same output twice" })).toEqual(["no_progress"]);
    expect(kinds("stall.dependency_deadlock", { reason: "a waits on b" })).toEqual(["dependency_blocked"]);
    expect(kinds("stall.no_runnable_nodes", { reason: "nothing ready" })).toEqual(["dependency_blocked"]);
    expect(kinds("stall.provider_unavailable", { reason: "all providers open" })).toEqual(["provider_error"]);
    expect(kinds("task.stage", { stage: "qa" })).toEqual([]);
  });

  test("carries source, facts and evidence refs", () => {
    const [scope] = observationsFromEvent({
      type: "native.change.rejected",
      payload: { files: ["a.ts", "b.ts"] },
      subtaskKey: "impl",
      executionId: "exec-1",
      agentId: "agent-1",
      createdAt: 5,
    });
    expect(scope).toEqual({
      eventType: "scope_violation",
      source: { agentId: "agent-1", subtaskKey: "impl", tool: "native" },
      facts: { affectedFiles: ["a.ts", "b.ts"], errorCode: "outside_allowed_paths" },
      evidenceRefs: ["event:native.change.rejected", "execution:exec-1"],
      observedAt: 5,
    });
    const gates = observationsFromEvent({
      type: "acceptance.evaluated",
      payload: {
        rejected: [{ key: "impl", reason: "Relevant tests pass: 2 failing" }],
        subtasks: [{ key: "impl", status: "rejected", gates: [{ id: "typecheck", status: "pass" }, { id: "tests", status: "fail" }] }],
      },
      createdAt: 7,
    });
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      eventType: "gate_failed",
      source: { subtaskKey: "impl", tool: "acceptance" },
      facts: { errorCode: "tests" },
      evidenceRefs: ["event:acceptance.evaluated", "gate:impl/tests"],
    });
    expect(providerErrorCode("fetch failed")).toBe("network");
    expect(providerErrorCode("Assertion failed")).toBeNull();
  });
});

async function seedTask() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "Auth",
      command: REQUEST,
      status: "running",
      workerId: "w1",
      leaseExpiresAt: Date.now() + 60_000,
    });
    return { projectId, taskId };
  });
  return { t, ...ids };
}

const sub = (key: string, requirementIds?: string[]) => ({
  key,
  title: `${key} endpoint`,
  description: `Implement ${key}`,
  kind: "code_change" as const,
  capability: "backend-development",
  dependencies: [],
  order: 0,
  ...(requirementIds ? { requirementIds } : {}),
});

describe("observations are stored by task", () => {
  test("logEvent and updateExecution write typed observations; the query returns them in order", async () => {
    const { t, projectId, taskId } = await seedTask();
    const executionId = await t.mutation(internal.orchestration.startExecution, {
      taskId, projectId, subtaskKey: "login", agentName: "Backend", capability: "backend-development", workerId: "w1", attempt: 1,
    });
    await t.mutation(internal.orchestration.updateExecution, { executionId, status: "failed", error: "503 Service Unavailable", workerId: "w1" });
    await t.mutation(internal.orchestration.logEvent, {
      taskId, projectId, type: "task.check", payload: { label: "verify:test", status: "failed", details: "1 failing" },
    });
    await t.mutation(internal.orchestration.logEvent, { taskId, projectId, type: "task.stage", payload: { stage: "qa" } });
    const rows = await t.query(api.traceability.observations, { taskId });
    expect(rows?.map((row) => row.eventType)).toEqual(["provider_error", "test_failed"]);
    expect(rows?.[0].source.subtaskKey).toBe("login");
    expect(rows?.[0].evidenceRefs).toContain(`execution:${executionId}`);
  });
});

describe("requirements on the task", () => {
  test("savePlan stores the plan's requirements and subtask requirementIds; the query computes coverage", async () => {
    const { t, projectId, taskId } = await seedTask();
    const requirements = extractRequirementsFallback(REQUEST);
    const subtasks = [sub("login", ["r1"]), sub("register", ["r2"]), sub("logout", ["r3"])];
    await t.mutation(internal.orchestration.savePlan, {
      taskId, projectId, version: 1, strategy: "dag", createdBy: "orchestrator", goal: "Auth",
      payload: { goal: "Auth", subtasks, requirements }, subtasks, workerId: "w1",
    });
    const task = await t.run(async (ctx) => ctx.db.get(taskId));
    expect(task?.requirements?.map((r) => r.text)).toEqual(["login", "register", "logout", "refresh token"]);

    await t.run(async (ctx) => {
      const rows = await ctx.db.query("subtasks").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect();
      expect(rows.map((row) => row.requirementIds)).toEqual([["r1"], ["r2"], ["r3"]]);
      for (const row of rows) {
        await ctx.db.patch(row._id, {
          status: "completed",
          acceptanceStatus: "accepted",
          gateResults: [{ gateId: "tests", status: "pass", evidence: { kind: "verification", summary: "ok" } }],
        });
      }
    });
    const view = await t.query(api.traceability.requirements, { taskId });
    expect(view?.report?.covered).toEqual(["r1", "r2", "r3"]);
    expect(view?.report?.uncovered).toEqual(["r4"]);
    expect(view?.quotes.r4).toBe("refresh token");

    const recorded = await t.mutation(internal.traceability.recordRequirementCoverage, {
      taskId, outcome: "completed_with_gaps", covered: ["r1", "r2", "r3"], missingEvidence: [], uncovered: ["r4"], workerId: "w1",
    });
    expect(recorded.applied).toBe(true);
    const fenced = await t.mutation(internal.traceability.recordRequirementCoverage, {
      taskId, outcome: "covered", covered: [], missingEvidence: [], uncovered: [], workerId: "w2",
    });
    expect(fenced).toEqual({ applied: false, reason: "lease_lost" });
    expect((await t.query(api.traceability.requirements, { taskId }))?.coverage?.outcome).toBe("completed_with_gaps");
  });

  test("a plan version without requirements keeps the stored list", async () => {
    const { t, projectId, taskId } = await seedTask();
    const requirements = extractRequirementsFallback(REQUEST);
    await t.mutation(internal.orchestration.savePlan, {
      taskId, projectId, version: 1, strategy: "single", createdBy: "orchestrator", goal: "g",
      payload: { subtasks: [sub("a")], requirements }, subtasks: [sub("a")], workerId: "w1",
    });
    await t.mutation(internal.orchestration.savePlan, {
      taskId, projectId, version: 2, strategy: "single", createdBy: "orchestrator", goal: "g",
      payload: { subtasks: [sub("a")] }, subtasks: [sub("a")], workerId: "w1",
    });
    const task = await t.run(async (ctx) => ctx.db.get(taskId));
    expect(task?.requirements).toHaveLength(4);
  });
});
