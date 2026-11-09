/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  SHADOW_MAX_NOTES_PER_TASK,
  extractJsonObject,
  parseOpinion,
  parseShadowNotes,
  replanNoteFromOpinion,
} from "./lib/reviewer/opinion";
import { ReviewerBudgetError, runReviewerLoop } from "./lib/reviewer/run";
import type { RepoToolCall } from "./lib/chat/repoTools";

const modules = import.meta.glob("./**/*.ts");

/** OpenAI-compatible non-streaming reply with `content`. */
function stubLlm(contents: string[]) {
  const replies = [...contents];
  const fetchMock = vi.fn(async () => {
    const content = replies.length > 1 ? replies.shift()! : replies[0];
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  // Scheduled reviews must not run on their own: each test runs the
  // action explicitly (convex-test fires runAfter(0) on real timers).
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

async function seed(opts: { status?: "running" | "done" | "failed"; shadow?: boolean } = {}) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
    const reviewerId = await ctx.db.insert("agents", { name: "Reviewer", role: "reviewer", status: "idle", systemPrompt: "You review code." });
    const frontendId = await ctx.db.insert("agents", { name: "Frontend", role: "frontend", status: "idle", systemPrompt: "Build UI.\nAlways run typecheck." });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "Add button",
      command: "add a save button",
      status: opts.status ?? "running",
      ...((opts.status ?? "running") === "running" ? { workerId: "w1", leaseExpiresAt: Date.now() + 60_000 } : {}),
      ...(opts.shadow ? { shadowAgent: true } : {}),
    });
    await ctx.db.insert("subtasks", {
      taskId,
      projectId,
      key: "impl",
      title: "Implement button",
      description: "Add a Save button to the toolbar",
      kind: "code_change",
      capability: "frontend-development",
      dependencies: [],
      order: 1,
      status: opts.status === "running" || !opts.status ? "running" : "completed",
      attempts: 1,
      assignedAgentId: frontendId,
      assignedAgentName: "Frontend",
      output: "Added the button.",
      objective: "A Save button in the toolbar",
      acceptance: [{ id: "typecheck", criterion: "web typecheck passes", check: "typecheck" }],
    });
    await ctx.db.insert("fileChanges", {
      taskId,
      projectId,
      filePath: "apps/web/Toolbar.tsx",
      changeType: "modified",
      diff: "@@ -1 +1 @@\n-<div/>\n+<div><button>Save</button></div>",
      subtaskKey: "impl",
    });
    await ctx.db.insert("approvals", { taskId, projectId, kind: "apply_changes", summary: "Apply", status: "pending" });
    return { projectId, taskId, reviewerId, frontendId };
  });
  return { t, ...ids };
}

/** Everything a review must never touch. */
async function runState(t: ReturnType<typeof convexTest>, taskId: any) {
  return t.run(async (ctx) => {
    const strip = <T extends Record<string, unknown>>(rows: T[]) => rows.map(({ _creationTime, ...rest }) => rest);
    return {
      task: await ctx.db.get(taskId),
      subtasks: strip(await ctx.db.query("subtasks").collect()),
      fileChanges: strip(await ctx.db.query("fileChanges").collect()),
      approvals: strip(await ctx.db.query("approvals").collect()),
      plans: strip(await ctx.db.query("plans").collect()),
      taskInputs: strip(await ctx.db.query("taskInputs").collect()),
      agents: strip(await ctx.db.query("agents").collect()),
      repoToolCalls: strip(await ctx.db.query("repoToolCalls").collect()),
    };
  });
}

// ─── Pure helpers ──────────────────────────────────────────────────────────

describe("reviewer parsing", () => {
  test("verdict JSON with evidence (fenced, strings or objects)", () => {
    const parsed = parseOpinion('```json\n{"verdict":"concerns","reason":"Missing test.","evidence":["apps/web/Toolbar.tsx:12 - no handler",{"file":"a.ts","line":"3"}]}\n```');
    expect(parsed.verdict).toBe("concerns");
    expect(parsed.reason).toBe("Missing test.");
    expect(parsed.evidence).toEqual([
      { file: "apps/web/Toolbar.tsx", line: 12, note: "no handler" },
      { file: "a.ts", line: 3 },
    ]);
  });

  test("an unparseable review is never reported as agreement", () => {
    expect(parseOpinion("Looks fine to me").verdict).toBe("concerns");
    expect(parseOpinion('{"verdict":"maybe"}').verdict).toBe("concerns");
  });

  test("shadow notes: kinds normalised, capped, empty dropped", () => {
    const notes = parseShadowNotes(
      '{"notes":[{"kind":"Missed requirement","text":"No a11y label"},{"kind":"risk","text":""},{"kind":"weird","text":"x"},{"kind":"risk","text":"y"},{"kind":"risk","text":"z"}]}',
      3
    );
    expect(notes.map((n) => n.kind)).toEqual(["missed_requirement", "suggestion", "risk"]);
    expect(extractJsonObject("no json")).toBeNull();
  });

  test("replan note carries the verdict, reason and evidence", () => {
    const note = replanNoteFromOpinion({ verdict: "disagree", reason: "Wrong file.", evidence: [{ file: "a.ts", line: 2 }], subtaskTitle: "Impl" });
    expect(note).toContain('Reviewer second opinion (disagree) on "Impl": Wrong file.');
    expect(note).toContain("a.ts:2");
  });
});

describe("reviewer loop is read-only and budgeted", () => {
  test("write / command tools the model asks for never reach the tool runner", async () => {
    const replies = [
      '{"tool":"write_file","arguments":{"path":"a.ts","content":"x"}}',
      '{"tool":"run_command","arguments":{"command":"rm -rf ."}}',
      '{"tool":"read_file","arguments":{"path":"a.ts"}}',
      '{"verdict":"agree","reason":"ok","evidence":[]}',
    ];
    let i = 0;
    const ran: RepoToolCall[] = [];
    const result = await runReviewerLoop({
      system: "s",
      material: "m",
      maxToolCalls: 6,
      tokenCap: 100_000,
      step: async () => replies[i++],
      callTool: async (call) => {
        ran.push(call);
        return { ok: true, text: "1: x", files: ["a.ts"] };
      },
    });
    expect(ran.map((c) => c.tool)).toEqual(["read_file"]);
    expect(parseOpinion(result.answer).verdict).toBe("agree");
    expect(result.inputTokens).toBeGreaterThan(0);
  });

  test("the token gate refuses a call before it is made", async () => {
    const step = vi.fn(async () => "x");
    await expect(
      runReviewerLoop({ system: "s".repeat(400), material: "m".repeat(400), maxToolCalls: 0, tokenCap: 50, step })
    ).rejects.toBeInstanceOf(ReviewerBudgetError);
    expect(step).not.toHaveBeenCalled();
  });
});

// ─── Second opinion: no side effects ───────────────────────────────────────

describe("second opinion", () => {
  test("subtask opinion stores a verdict, tokens and audit, and changes nothing else", async () => {
    const { t, taskId } = await seed({ status: "done" });
    const fetchMock = stubLlm(['{"verdict":"concerns","reason":"No click handler.","evidence":[{"file":"apps/web/Toolbar.tsx","line":1}]}']);
    const opinionId = await t.mutation(api.reviewer.requestSubtaskOpinion, { taskId, subtaskKey: "impl" });
    const before = await runState(t, taskId);
    await t.action(internal.reviewerNode.runReview, { opinionId });
    const after = await runState(t, taskId);
    expect(after).toEqual(before);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const prompt = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(prompt.messages[0].content).toContain("You review code.");
    expect(prompt.messages[1].content).toContain("+<div><button>Save</button></div>");
    expect(prompt.messages[1].content).toContain("[typecheck] web typecheck passes");

    const view = await t.query(api.reviewer.listForTask, { taskId });
    expect(view?.opinions).toHaveLength(1);
    expect(view?.opinions[0]).toMatchObject({ status: "done", verdict: "concerns", reason: "No click handler." });
    expect(view?.opinions[0].evidence).toEqual([{ file: "apps/web/Toolbar.tsx", line: 1 }]);
    const usage = await t.run((ctx) => ctx.db.query("tokenUsage").collect());
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ agentName: "Reviewer", subtaskKey: "impl", estimated: true });
    const audit = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(audit.map((a) => a.action)).toEqual(["review.second_opinion.request", "review.second_opinion"]);
  });

  test("an unfinished subtask cannot get a second opinion", async () => {
    const { t, taskId } = await seed({ status: "running" });
    await expect(t.mutation(api.reviewer.requestSubtaskOpinion, { taskId, subtaskKey: "impl" })).rejects.toThrow(/finished subtask/);
  });

  test("chat reply opinion reads the question the reply answered", async () => {
    const { t, projectId, frontendId, taskId } = await seed({ status: "done" });
    const messageId = await t.run(async (ctx) => {
      const asked = await ctx.db.insert("messages", { projectId, authorType: "user", content: "Where is the toolbar?" });
      return ctx.db.insert("messages", { projectId, authorType: "agent", agentId: frontendId, content: "In apps/web/Toolbar.tsx:1", replyToMessageId: asked });
    });
    const fetchMock = stubLlm(['{"verdict":"agree","reason":"Correct.","evidence":[]}']);
    const opinionId = await t.mutation(api.reviewer.requestMessageOpinion, { messageId });
    const before = await runState(t, taskId);
    await t.action(internal.reviewerNode.runReview, { opinionId });
    expect(await runState(t, taskId)).toEqual(before);
    const prompt = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(prompt.messages[1].content).toContain("Where is the toolbar?");
    const rows = await t.query(api.reviewer.listForChat, { projectId });
    expect(rows[0]).toMatchObject({ messageId, verdict: "agree" });
  });

  test("Replan with this note: finished task → requeued with planner feedback (explicit only)", async () => {
    const { t, taskId } = await seed({ status: "done" });
    stubLlm(['{"verdict":"disagree","reason":"Wrong component.","evidence":[]}']);
    const opinionId = await t.mutation(api.reviewer.requestSubtaskOpinion, { taskId, subtaskKey: "impl" });
    await t.action(internal.reviewerNode.runReview, { opinionId });
    // The review alone changed nothing.
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.status).toBe("done");
    const result = await t.mutation(api.reviewer.replanWithOpinion, { opinionId });
    expect(result.outcome).toBe("requeued");
    const task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task?.status).toBe("queued");
    expect(task?.planReviewNote).toContain("Wrong component.");
    const audit = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(audit.some((a) => a.action === "review.replan_with_note")).toBe(true);
  });

  test("an agree verdict cannot be sent to the planner", async () => {
    const { t, taskId } = await seed({ status: "done" });
    stubLlm(['{"verdict":"agree","reason":"Fine.","evidence":[]}']);
    const opinionId = await t.mutation(api.reviewer.requestSubtaskOpinion, { taskId, subtaskKey: "impl" });
    await t.action(internal.reviewerNode.runReview, { opinionId });
    await expect(t.mutation(api.reviewer.replanWithOpinion, { opinionId })).rejects.toThrow(/agreed/);
  });
});

// ─── Shadow agent ──────────────────────────────────────────────────────────

describe("shadow agent", () => {
  const complete = (taskId: any) => ({ taskId, key: "impl", status: "completed" as const, output: "done", workerId: "w1" });

  test("off by default: completing a subtask schedules nothing", async () => {
    const { t, taskId } = await seed();
    await t.mutation(internal.orchestration.updateSubtask, complete(taskId));
    expect(await t.run((ctx) => ctx.db.query("reviewOpinions").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(0);
  });

  test("on: a completed subtask gets one shadow review; notes never change the run", async () => {
    const { t, taskId } = await seed({ shadow: true });
    await t.mutation(internal.orchestration.updateSubtask, complete(taskId));
    // Re-reporting the same completion does not add a second review.
    await t.mutation(internal.orchestration.updateSubtask, complete(taskId));
    const rows = await t.run((ctx) => ctx.db.query("reviewOpinions").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: "shadow", status: "running", subtaskKey: "impl" });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(1);

    stubLlm(['{"notes":[{"kind":"risk","text":"No onClick handler","evidence":[{"file":"apps/web/Toolbar.tsx","line":1}]}]}']);
    const before = await runState(t, taskId);
    await t.action(internal.reviewerNode.runReview, { opinionId: rows[0]._id });
    expect(await runState(t, taskId)).toEqual(before);
    const view = await t.query(api.reviewer.listForTask, { taskId });
    expect(view?.shadow[0].notes).toEqual([{ kind: "risk", text: "No onClick handler", evidence: [{ file: "apps/web/Toolbar.tsx", line: 1 }] }]);
    expect(view?.shadowBudget.notes).toBe(1);
  });

  test("budget: past the note limit no further review is scheduled", async () => {
    const { t, taskId, projectId } = await seed({ shadow: true });
    await t.run(async (ctx) => {
      await ctx.db.insert("reviewOpinions", {
        projectId,
        taskId,
        subtaskKey: "earlier",
        mode: "shadow",
        target: "subtask",
        status: "done",
        notes: Array.from({ length: SHADOW_MAX_NOTES_PER_TASK }, () => ({ kind: "suggestion" as const, text: "n", evidence: [] })),
        createdAt: Date.now(),
      });
    });
    await t.mutation(internal.orchestration.updateSubtask, complete(taskId));
    const rows = await t.run((ctx) => ctx.db.query("reviewOpinions").collect());
    expect(rows.filter((r) => r.status === "running")).toHaveLength(0);
    expect(rows.some((r) => r.status === "skipped")).toBe(true);
    expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(0);
  });

  test("project default applies to new tasks; toggles are audited", async () => {
    const { t, projectId, taskId } = await seed();
    await t.mutation(api.reviewer.setProjectShadowDefault, { projectId, enabled: true });
    const newTask = await t.mutation(api.tasks.createFromCommand, { projectId, command: "another thing to build here" });
    expect((await t.run((ctx) => ctx.db.get(newTask)))?.shadowAgent).toBe(true);
    await t.mutation(api.reviewer.setTaskShadow, { taskId, enabled: true });
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.shadowAgent).toBe(true);
    const actions = (await t.run((ctx) => ctx.db.query("audit").collect())).map((a) => a.action);
    expect(actions).toEqual(["project.update", "task.update"]);
  });
});
