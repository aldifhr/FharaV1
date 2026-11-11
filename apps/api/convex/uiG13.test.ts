/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

/** ui-g13: the read sides the UI uses for CTO turns, MCP task drafts and earlier task events. */

const modules = import.meta.glob("./**/*.ts");
const TOKEN = "ui-g13-harness-token";
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.CONVEX_SERVICE_TOKEN;
  process.env.CONVEX_SERVICE_TOKEN = TOKEN;
});
afterEach(() => {
  if (previous === undefined) delete process.env.CONVEX_SERVICE_TOKEN;
  else process.env.CONVEX_SERVICE_TOKEN = previous;
});
const W = { workerToken: TOKEN, workerId: "w1" };

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const cto = await ctx.db.insert("agents", { name: "CTO", role: "cto", status: "idle", isEnabled: true });
    const p = await ctx.db.insert("projects", { name: "Shop", workspacePath: "/tmp/p", agentIds: [cto] });
    const task = await ctx.db.insert("tasks", { projectId: p, title: "Add CSV export", command: "c", status: "running", permissionMode: "auto_edits" });
    return { p, task };
  });
  return { t, ...ids };
}

const question = {
  source: "escalation" as const,
  delivery: "inline" as const,
  question: "Add zod for validation?",
  options: ["Allow the dependency", "Do it without a new dependency"],
  kind: "new_dependency",
  detail: "zod",
  ttlMs: 9 * 60_000,
};

describe("decisionTurns.latestForTask", () => {
  test("null without a turn; open with its deadline; then the answer", async () => {
    const { t, task } = await seed();
    expect(await t.query(api.decisionTurns.latestForTask, { taskId: task })).toBeNull();
    const opened = await t.mutation(api.decisionTurns.open, { ...W, taskId: task, dedupeKey: "q1", ...question });
    if (opened.route !== "cto") throw new Error("expected cto");
    const open = await t.query(api.decisionTurns.latestForTask, { taskId: task });
    expect(open).toMatchObject({ status: "open", role: "cto", answer: null, chosenOption: null });
    expect(open!.expiresAt).toBeGreaterThan(Date.now());
    await t.mutation(api.decisionTurns.answer, {
      ...W,
      turnId: opened.turnId,
      verdict: "answer",
      answer: "Allow zod; it matches the project's validation style.",
      chosenOption: "Allow the dependency",
      rationale: "consistent",
    });
    expect(await t.query(api.decisionTurns.latestForTask, { taskId: task })).toMatchObject({
      status: "answered",
      chosenOption: "Allow the dependency",
      answer: "Allow zod; it matches the project's validation style.",
    });
  });

  test("an expired turn reads as expired", async () => {
    const { t, task } = await seed();
    const opened = await t.mutation(api.decisionTurns.open, { ...W, taskId: task, dedupeKey: "q2", ...question });
    if (opened.route !== "cto") throw new Error("expected cto");
    await t.mutation(api.decisionTurns.expire, { workerToken: TOKEN, turnId: opened.turnId, why: "test" });
    expect(await t.query(api.decisionTurns.latestForTask, { taskId: task })).toMatchObject({ status: "expired" });
  });
});

describe("taskDrafts.listVisible", () => {
  test("lists open drafts across projects with the project name; started and dismissed ones leave", async () => {
    const { t, p } = await seed();
    const [a, b] = await t.run(async (ctx) => {
      const now = Date.now();
      const base = { projectId: p, permissionMode: "auto_edits" as const, source: "mcp" as const, reason: "Chat-sourced request", status: "draft" as const };
      return [
        await ctx.db.insert("taskDrafts", { ...base, title: "Fix login", command: "Fix the login redirect", createdAt: now, updatedAt: now }),
        await ctx.db.insert("taskDrafts", { ...base, title: "Add docs", command: "Document the API", createdAt: now + 1, updatedAt: now + 1 }),
      ];
    });
    const listed = await t.query(api.taskDrafts.listVisible, {});
    expect(listed.map((d) => d.title)).toEqual(["Add docs", "Fix login"]);
    expect(listed[0]).toMatchObject({ projectName: "Shop", reason: "Chat-sourced request" });
    await t.mutation(api.taskDrafts.dismiss, { draftId: a });
    const taskId = await t.mutation(api.taskDrafts.start, { draftId: b });
    expect(await t.query(api.taskDrafts.listVisible, {})).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(taskId))).toMatchObject({ status: "queued", title: "Add docs" });
  });
});
