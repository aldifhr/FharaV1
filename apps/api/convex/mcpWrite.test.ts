/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { mcpTaskStartDecision } from "./lib/mcpWritePolicy";
import type { PermissionMode } from "./lib/permissionModes";

/** GOAT G12b: the token-gated writes behind the Fhara MCP server: dedupe by clientRequestId, permission modes, terminal guards. */

const modules = import.meta.glob("./**/*.ts");
const TOKEN = "mcp-write-harness-token";
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.CONVEX_SERVICE_TOKEN;
  process.env.CONVEX_SERVICE_TOKEN = TOKEN;
});
afterEach(() => {
  if (previous === undefined) delete process.env.CONVEX_SERVICE_TOKEN;
  else process.env.CONVEX_SERVICE_TOKEN = previous;
});

async function seed(mode: PermissionMode = "supervised") {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const p = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", defaultPermissionMode: mode });
    const other = await ctx.db.insert("projects", { name: "Q", workspacePath: "/tmp/q" });
    const conv = await ctx.db.insert("conversations", { projectId: p, title: "Chat", status: "active", createdAt: 1, updatedAt: 1 } as never);
    const queued = await ctx.db.insert("tasks", { projectId: p, title: "Q", command: "q", status: "queued" });
    const running = await ctx.db.insert("tasks", {
      projectId: p,
      title: "R",
      command: "r",
      status: "running",
      workerId: "w1",
      leaseExpiresAt: Date.now() + 60_000,
    });
    const done = await ctx.db.insert("tasks", { projectId: p, title: "D", command: "d", status: "done" });
    return { p, other, conv, queued, running, done };
  });
  return { t, ...ids };
}

const W = { workerToken: TOKEN };

describe("mcpWrite auth", () => {
  test("every write refuses a wrong service token", async () => {
    const { t, p, queued } = await seed();
    await expect(t.mutation(api.mcpWrite.taskCreate, { workerToken: "x", clientRequestId: "a", projectId: p, command: "c" })).rejects.toThrow();
    await expect(t.mutation(api.mcpWrite.threadSend, { workerToken: "", clientRequestId: "b", taskId: queued, content: "c" })).rejects.toThrow();
    await expect(
      t.mutation(api.mcpWrite.runReportResult, { workerToken: "x", clientRequestId: "c", taskId: queued, status: "succeeded", summary: "s" })
    ).rejects.toThrow();
    await expect(t.mutation(api.mcpWrite.questionAsk, { workerToken: "x", clientRequestId: "d", taskId: queued, question: "?" })).rejects.toThrow();
  });
});

describe("duplicate clientRequestId", () => {
  test("task.create: the repeat returns the same draft and writes nothing", async () => {
    const { t, p } = await seed();
    const first = await t.mutation(api.mcpWrite.taskCreate, { ...W, clientRequestId: "req-1", projectId: p, command: "add a footer" });
    const again = await t.mutation(api.mcpWrite.taskCreate, { ...W, clientRequestId: "req-1", projectId: p, command: "add a footer" });
    expect(first).toMatchObject({ kind: "draft", deduped: false });
    expect(again).toEqual({ ...first, deduped: true });
    const drafts = await t.run((ctx) => ctx.db.query("taskDrafts").collect());
    expect(drafts).toHaveLength(1);
  });

  test("task.create started under full access: one task for two calls", async () => {
    const { t, p } = await seed("full_access");
    const args = { ...W, clientRequestId: "req-2", projectId: p, command: "run the tests", approved: true };
    const first = await t.mutation(api.mcpWrite.taskCreate, args);
    const again = await t.mutation(api.mcpWrite.taskCreate, args);
    expect(first).toMatchObject({ kind: "task", permissionMode: "full_access", deduped: false });
    expect(again).toEqual({ ...first, deduped: true });
    const tasks = await t.run((ctx) => ctx.db.query("tasks").collect());
    expect(tasks.filter((task) => task.command === "run the tests")).toHaveLength(1);
  });

  test("thread.send, run.report_result and question.ask: the repeat returns the same result, one row each", async () => {
    const { t, queued } = await seed();
    const send = { ...W, clientRequestId: "s-1", taskId: queued, content: "halfway" };
    const sent = await t.mutation(api.mcpWrite.threadSend, send);
    expect(await t.mutation(api.mcpWrite.threadSend, send)).toEqual({ ...sent, deduped: true });

    const report = { ...W, clientRequestId: "r-1", taskId: queued, status: "succeeded" as const, summary: "tests green" };
    const reported = await t.mutation(api.mcpWrite.runReportResult, report);
    expect(await t.mutation(api.mcpWrite.runReportResult, report)).toEqual({ ...reported, deduped: true });

    const ask = { ...W, clientRequestId: "q-1", taskId: queued, question: "Which footer?" };
    const asked = await t.mutation(api.mcpWrite.questionAsk, ask);
    expect(asked).toMatchObject({ kind: "asked", deduped: false });
    expect(await t.mutation(api.mcpWrite.questionAsk, ask)).toEqual({ ...asked, deduped: true });

    const messages = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(messages.filter((m) => m.content === "MCP: halfway")).toHaveLength(1);
    expect(messages.filter((m) => m.content.startsWith("MCP run result (succeeded)"))).toHaveLength(1);
    const events = await t.run((ctx) => ctx.db.query("taskEvents").collect());
    expect(events.filter((e) => e.type === "mcp.result_reported")).toHaveLength(1);
    expect(events.filter((e) => e.type === "task.input_asked")).toHaveLength(1);
  });

  test("an id reused for another tool throws; a refusal is not remembered", async () => {
    const { t, p, queued, done } = await seed();
    await t.mutation(api.mcpWrite.taskCreate, { ...W, clientRequestId: "shared", projectId: p, command: "c" });
    await expect(t.mutation(api.mcpWrite.threadSend, { ...W, clientRequestId: "shared", taskId: queued, content: "x" })).rejects.toThrow(
      /already used by task.create/
    );
    const refused = await t.mutation(api.mcpWrite.runReportResult, { ...W, clientRequestId: "r-x", taskId: done, status: "failed", summary: "s" });
    expect(refused).toMatchObject({ kind: "refused", reason: "task_already_terminal" });
    const ok = await t.mutation(api.mcpWrite.runReportResult, { ...W, clientRequestId: "r-x", taskId: queued, status: "failed", summary: "s" });
    expect(ok).toMatchObject({ kind: "recorded", deduped: false });
  });
});

describe("permission modes", () => {
  test("the pure policy: start only when approved, full access and not from chat; never looser than the project", () => {
    const base = { approved: true, fromChat: false };
    expect(mcpTaskStartDecision({ ...base, projectMode: "full_access" }).kind).toBe("start");
    expect(mcpTaskStartDecision({ ...base, projectMode: "auto_edits" }).kind).toBe("draft");
    expect(mcpTaskStartDecision({ ...base, projectMode: "supervised" }).kind).toBe("draft");
    expect(mcpTaskStartDecision({ ...base, projectMode: "full_access", approved: false }).kind).toBe("draft");
    expect(mcpTaskStartDecision({ ...base, projectMode: "full_access", fromChat: true }).kind).toBe("draft");
    expect(mcpTaskStartDecision({ ...base, projectMode: "full_access", requestedMode: "supervised" })).toMatchObject({
      kind: "start",
      mode: "supervised",
    });
    expect(mcpTaskStartDecision({ ...base, projectMode: "auto_edits", requestedMode: "full_access" })).toMatchObject({
      kind: "refused",
      reason: "permission_mode_escalation",
    });
  });

  for (const mode of ["supervised", "auto_edits"] as const) {
    test(`${mode}: an approved task.create is still a draft; nothing is queued`, async () => {
      const { t, p } = await seed(mode);
      const res = await t.mutation(api.mcpWrite.taskCreate, { ...W, clientRequestId: `m-${mode}`, projectId: p, command: "ship it", approved: true });
      expect(res).toMatchObject({ kind: "draft" });
      const tasks = await t.run((ctx) => ctx.db.query("tasks").collect());
      expect(tasks.some((task) => task.command === "ship it")).toBe(false);
    });
  }

  test("full_access: approved starts a queued task in the project's mode; unapproved is a draft", async () => {
    const { t, p } = await seed("full_access");
    const started = await t.mutation(api.mcpWrite.taskCreate, { ...W, clientRequestId: "fa-1", projectId: p, command: "go", approved: true });
    expect(started).toMatchObject({ kind: "task" });
    const task = await t.run(async (ctx) => (await ctx.db.query("tasks").collect()).find((row) => row.command === "go"));
    expect(task).toMatchObject({ status: "queued", permissionMode: "full_access" });
    const draft = await t.mutation(api.mcpWrite.taskCreate, { ...W, clientRequestId: "fa-2", projectId: p, command: "later" });
    expect(draft).toMatchObject({ kind: "draft" });
  });

  test("chat never auto-starts: a request with a conversation is a draft even under full access", async () => {
    const { t, p, conv } = await seed("full_access");
    const res = await t.mutation(api.mcpWrite.taskCreate, {
      ...W,
      clientRequestId: "chat-1",
      projectId: p,
      command: "from chat",
      approved: true,
      conversationId: conv,
    });
    expect(res).toMatchObject({ kind: "draft", reason: expect.stringMatching(/Chat never starts/) });
  });

  test("a looser mode than the project's is refused; a conversation from another project is refused", async () => {
    const { t, p, other, conv } = await seed("auto_edits");
    expect(
      await t.mutation(api.mcpWrite.taskCreate, { ...W, clientRequestId: "esc", projectId: p, command: "c", permissionMode: "full_access" })
    ).toMatchObject({ kind: "refused", reason: "permission_mode_escalation" });
    expect(
      await t.mutation(api.mcpWrite.taskCreate, { ...W, clientRequestId: "conv", projectId: other, command: "c", conversationId: conv })
    ).toMatchObject({ kind: "refused", reason: "conversation_not_in_project" });
  });

  test("the user starts a draft once: one queued task in the draft's mode", async () => {
    const { t, p } = await seed("supervised");
    const res = await t.mutation(api.mcpWrite.taskCreate, { ...W, clientRequestId: "d-1", projectId: p, command: "draft me" });
    if (res.kind !== "draft") throw new Error("expected a draft");
    const draftId = res.draftId as never;
    const first = await t.mutation(api.taskDrafts.start, { draftId });
    expect(await t.mutation(api.taskDrafts.start, { draftId })).toBe(first);
    const task = await t.run((ctx) => ctx.db.get(first));
    expect(task).toMatchObject({ status: "queued", permissionMode: "supervised", command: "draft me" });
  });
});

describe("guards", () => {
  test("question.ask refuses a worker-held, settled or already-asking task; report refuses a settled one", async () => {
    const { t, running, done, queued } = await seed();
    expect(await t.mutation(api.mcpWrite.questionAsk, { ...W, clientRequestId: "g1", taskId: running, question: "?" })).toMatchObject({
      reason: "task_owned_by_worker",
    });
    expect(await t.mutation(api.mcpWrite.questionAsk, { ...W, clientRequestId: "g2", taskId: done, question: "?" })).toMatchObject({
      reason: "task_already_terminal",
    });
    await t.mutation(api.mcpWrite.questionAsk, { ...W, clientRequestId: "g3", taskId: queued, question: "A or B?", options: ["A", "B"] });
    const asked = await t.run((ctx) => ctx.db.get(queued));
    expect(asked).toMatchObject({ status: "waiting_input", pendingQuestion: "A or B?", pendingOptions: ["A", "B"] });
    expect(await t.mutation(api.mcpWrite.questionAsk, { ...W, clientRequestId: "g4", taskId: queued, question: "again?" })).toMatchObject({
      reason: "question_open",
    });
    expect(
      await t.mutation(api.mcpWrite.runReportResult, { ...W, clientRequestId: "g5", taskId: done, status: "succeeded", summary: "s" })
    ).toMatchObject({ reason: "task_already_terminal" });
    expect((await t.run((ctx) => ctx.db.get(done)))?.status).toBe("done");
  });

  test("run.report_result never changes the task's status", async () => {
    const { t, running } = await seed();
    await t.mutation(api.mcpWrite.runReportResult, { ...W, clientRequestId: "k1", taskId: running, status: "succeeded", summary: "done" });
    expect((await t.run((ctx) => ctx.db.get(running)))?.status).toBe("running");
  });
});
