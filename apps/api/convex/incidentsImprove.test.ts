/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { applyEdits, resolveSuggestion, type SuggestionCandidate } from "./lib/improve/suggest";
import { diffStats, unifiedDiff } from "./lib/improve/textDiff";

const modules = import.meta.glob("./**/*.ts");

function stubLlm(content: string) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  process.env.LLM_PROVIDER = "openai";
  process.env.LLM_API_KEY = "test-key";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_API_KEY;
});

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
    const agentId = await ctx.db.insert("agents", { name: "Frontend", role: "frontend", status: "idle", systemPrompt: "Build UI.\nKeep diffs small." });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "Add button",
      command: "add a save button",
      status: "running",
      workerId: "w1",
      leaseExpiresAt: Date.now() + 60_000,
    });
    await ctx.db.insert("subtasks", {
      taskId,
      projectId,
      key: "impl",
      title: "Implement button",
      description: "Add a Save button",
      kind: "code_change",
      capability: "frontend-development",
      dependencies: [],
      order: 1,
      status: "running",
      attempts: 1,
      assignedAgentId: agentId,
      assignedAgentName: "Frontend",
    });
    await ctx.db.insert("taskEvents", { taskId, projectId, type: "subtask.failed", subtaskKey: "impl", payload: { error: "typecheck failed" }, level: "error" });
    await ctx.db.insert("audit", { actor: "user", tool: "approval", action: "approval.approve", decision: "allowed", projectId, taskId, createdAt: Date.now() });
    return { projectId, taskId, agentId };
  });
  return { t, ...ids };
}

describe("incident creation triggers", () => {
  test("a failed task opens one incident with failure point, events and audit rows", async () => {
    const { t, taskId } = await seed();
    await t.run((ctx) => ctx.db.patch(taskId, {}));
    const subtaskId = await t.run(async (ctx) => (await ctx.db.query("subtasks").first())!._id);
    await t.run((ctx) => ctx.db.patch(subtaskId, { status: "failed", error: "typecheck failed" }));
    const result = await t.mutation(internal.orchestration.completeTask, { taskId, status: "failed", errorMessage: "Subtask impl failed", workerId: "w1" });
    expect(result.applied).toBe(true);
    const incidents = await t.run((ctx) => ctx.db.query("incidents").collect());
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ trigger: "task_failed", status: "open", error: "Subtask impl failed" });
    expect(incidents[0].failurePoint).toMatchObject({ subtaskKey: "impl", title: "Implement button" });
    expect(incidents[0].lastEvents.some((e) => e.type === "subtask.failed" && e.text === "typecheck failed")).toBe(true);
    expect(incidents[0].auditIds).toHaveLength(1);
    const detail = await t.query(api.incidents.get, { incidentId: incidents[0]._id });
    expect(detail?.audit[0].action).toBe("approval.approve");
    expect(detail?.taskTitle).toBe("Add button");
    // The incident is recorded in the trace and the audit log.
    const events = await t.run((ctx) => ctx.db.query("taskEvents").collect());
    expect(events.some((e) => e.type === "incident.opened")).toBe(true);
  });

  test("a done task opens no incident", async () => {
    const { t, taskId } = await seed();
    await t.mutation(internal.orchestration.completeTask, { taskId, status: "done", workerId: "w1" });
    expect(await t.run((ctx) => ctx.db.query("incidents").collect())).toHaveLength(0);
  });

  test("an escalation opens an incident once (idempotent while open)", async () => {
    const { t, taskId } = await seed();
    const escalate = {
      taskId,
      key: "impl",
      acceptanceStatus: "escalated" as const,
      acceptanceReason: "Needs a schema change",
      escalation: { kind: "schema_change" as const, reason: "Needs a new table" },
      workerId: "w1",
    };
    await t.mutation(internal.contracts.recordSubtaskAcceptance, escalate);
    await t.mutation(internal.contracts.recordSubtaskAcceptance, escalate);
    const incidents = await t.run((ctx) => ctx.db.query("incidents").collect());
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ trigger: "subtask_escalated", subtaskKey: "impl" });
    expect(incidents[0].escalation?.kind).toBe("schema_change");
  });

  test("a task failed by stale-lease recovery opens an incident", async () => {
    const { t, taskId } = await seed();
    await t.run((ctx) => ctx.db.patch(taskId, { leaseExpiresAt: Date.now() - 1_000, recoveryCount: 99 }));
    await t.mutation(internal.orchestration.recoverStale, { now: Date.now() });
    const task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task?.status).toBe("failed");
    const incidents = await t.run((ctx) => ctx.db.query("incidents").collect());
    expect(incidents.map((i) => i.trigger)).toEqual(["task_failed"]);
  });

  test("owner, status and note are updated and audited", async () => {
    const { t, taskId } = await seed();
    await t.mutation(internal.orchestration.completeTask, { taskId, status: "failed", errorMessage: "boom", workerId: "w1" });
    const [incident] = await t.query(api.incidents.list, {});
    await t.mutation(api.incidents.update, { incidentId: incident._id, status: "resolved", owner: "faray", note: "flaky test" });
    const detail = await t.query(api.incidents.get, { incidentId: incident._id });
    expect(detail).toMatchObject({ status: "resolved", owner: "faray", note: "flaky test" });
    expect(detail?.resolvedAt).not.toBeNull();
    const open = await t.query(api.incidents.list, { status: "open" });
    expect(open).toHaveLength(0);
    const audit = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(audit.find((a) => a.action === "incident.update")?.details).toEqual({ changed: ["status", "owner", "note"], status: "resolved" });
  });
});

describe("suggestion diff", () => {
  test("applyEdits: exact single match only; empty find appends", () => {
    expect(applyEdits("a\nb\nc", [{ find: "b", replace: "B" }])).toEqual({ text: "a\nB\nc", applied: 1, skipped: 0 });
    expect(applyEdits("x x", [{ find: "x", replace: "y" }]).applied).toBe(0);
    expect(applyEdits("a", [{ find: "", replace: "z" }]).text).toBe("a\n\nz");
  });

  test("unified diff marks the changed lines", () => {
    const diff = unifiedDiff("one\ntwo\nthree", "one\n2\nthree", "prompt");
    expect(diff).toContain("--- a/prompt");
    expect(diff).toContain("-two");
    expect(diff).toContain("+2");
    expect(diffStats(diff)).toEqual({ added: 1, removed: 1 });
    expect(unifiedDiff("same", "same")).toBe("");
  });

  test("resolveSuggestion refuses unknown targets and non-matching edits", () => {
    const candidates: SuggestionCandidate[] = [{ kind: "agent_prompt", id: "a1", label: "frontend prompt", text: "Build UI." }];
    expect(resolveSuggestion('{"targetId":"zz","rationale":"r","edits":[]}', candidates).ok).toBe(false);
    expect(resolveSuggestion('{"targetId":"a1","rationale":"r","edits":[{"find":"nope","replace":"x"}]}', candidates).ok).toBe(false);
    const ok = resolveSuggestion('{"targetId":"a1","rationale":"r","edits":[{"find":"Build UI.","replace":"Build UI. Run typecheck first."}]}', candidates);
    expect(ok.ok && ok.proposedText).toBe("Build UI. Run typecheck first.");
  });
});

describe("Self-Improvement Lab", () => {
  async function failedWithSuggestion() {
    const env = await seed();
    await env.t.mutation(internal.orchestration.completeTask, { taskId: env.taskId, status: "failed", errorMessage: "typecheck failed", workerId: "w1" });
    const [incident] = await env.t.query(api.incidents.list, {});
    stubLlm(
      JSON.stringify({
        targetId: env.agentId,
        rationale: "The agent skipped the typecheck.",
        edits: [{ find: "Keep diffs small.", replace: "Keep diffs small.\nRun the typecheck before you report done." }],
      })
    );
    const suggestionId = await env.t.mutation(api.improve.requestSuggestion, { incidentId: incident._id });
    await env.t.action(internal.improveNode.runSuggestion, { suggestionId });
    return { ...env, incident, suggestionId };
  }

  test("suggest stores a diff against the current text and applies nothing", async () => {
    const { t, agentId, incident } = await failedWithSuggestion();
    const [row] = await t.query(api.improve.listSuggestions, { incidentId: incident._id });
    expect(row.status).toBe("ready");
    expect(row.targetKind).toBe("agent_prompt");
    expect(row.diff).toContain("+Run the typecheck before you report done.");
    expect((await t.run((ctx) => ctx.db.get(agentId)))?.systemPrompt).toBe("Build UI.\nKeep diffs small.");
    const usage = await t.run((ctx) => ctx.db.query("tokenUsage").collect());
    expect(usage[0]).toMatchObject({ agentName: "Self-Improvement Lab", estimated: true });
  });

  test("Apply writes the new version and is audited", async () => {
    const { t, agentId, suggestionId } = await failedWithSuggestion();
    await t.mutation(api.improve.applySuggestion, { suggestionId });
    expect((await t.run((ctx) => ctx.db.get(agentId)))?.systemPrompt).toBe("Build UI.\nKeep diffs small.\nRun the typecheck before you report done.");
    const audit = await t.run((ctx) => ctx.db.query("audit").collect());
    const update = audit.find((a) => a.action === "agent.update");
    expect(update?.details).toMatchObject({ changed: ["systemPrompt"], source: "improve", suggestionId });
    expect(audit.some((a) => a.action === "improve.apply")).toBe(true);
    await expect(t.mutation(api.improve.applySuggestion, { suggestionId })).rejects.toThrow(/applied/);
  });

  test("Apply refuses when the text changed since; Dismiss is audited", async () => {
    const { t, agentId, suggestionId } = await failedWithSuggestion();
    await t.run((ctx) => ctx.db.patch(agentId, { systemPrompt: "Edited by hand." }));
    await expect(t.mutation(api.improve.applySuggestion, { suggestionId })).rejects.toThrow(/changed since/);
    expect((await t.run((ctx) => ctx.db.get(agentId)))?.systemPrompt).toBe("Edited by hand.");
    await t.mutation(api.improve.dismissSuggestion, { suggestionId });
    const audit = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(audit.some((a) => a.action === "improve.dismiss")).toBe(true);
  });
});
