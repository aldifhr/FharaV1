/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { MCP_MEMORY_CONTENT_MAX } from "./mcpRead";

/** GOAT G12a: the token-gated reads behind the Fhara MCP server's task.status, task.list and memory.search. */

const modules = import.meta.glob("./**/*.ts");
const TOKEN = "mcp-read-harness-token";
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.CONVEX_SERVICE_TOKEN;
  process.env.CONVEX_SERVICE_TOKEN = TOKEN;
});
afterEach(() => {
  if (previous === undefined) delete process.env.CONVEX_SERVICE_TOKEN;
  else process.env.CONVEX_SERVICE_TOKEN = previous;
});

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const p1 = await ctx.db.insert("projects", { name: "P1", workspacePath: "/tmp/p1" });
    const p2 = await ctx.db.insert("projects", { name: "P2", workspacePath: "/tmp/p2" });
    const a = await ctx.db.insert("tasks", { projectId: p1, title: "Add login", command: "add login", status: "done", completedAt: 5 });
    const b = await ctx.db.insert("tasks", {
      projectId: p1,
      title: "Fix footer",
      command: "fix footer",
      status: "waiting_input",
      pendingQuestion: "Which footer?",
      mode: "direct",
    });
    const c = await ctx.db.insert("tasks", { projectId: p2, title: "Other", command: "other", status: "running" });
    const sub = { projectId: p1, taskId: a, description: "d", kind: "code_change" as const, capability: "code", dependencies: [], attempts: 0 };
    await ctx.db.insert("subtasks", { ...sub, key: "s1", title: "S1", order: 1, status: "completed" });
    await ctx.db.insert("subtasks", { ...sub, key: "s2", title: "S2", order: 2, status: "completed" });
    await ctx.db.insert("subtasks", { ...sub, key: "s3", title: "S3", order: 3, status: "failed" });
    const mem = { pinned: false, source: "user" as const, createdAt: 1, updatedAt: 2 };
    await ctx.db.insert("memories", { ...mem, scope: "shared", title: "Deploy", content: "deploy with vercel preview first" });
    await ctx.db.insert("memories", { ...mem, scope: "project", projectId: p1, title: "P1 deploy", content: "deploy p1 " + "x".repeat(MCP_MEMORY_CONTENT_MAX) });
    await ctx.db.insert("memories", { ...mem, scope: "project", projectId: p2, title: "P2 deploy", content: "deploy p2 secret plan" });
    return { p1, p2, a, b, c };
  });
  return { t, ...ids };
}

describe("mcpRead", () => {
  test("every read refuses a missing or wrong service token", async () => {
    const { t, a } = await seed();
    await expect(t.query(api.mcpRead.taskStatus, { workerToken: "wrong", taskId: a })).rejects.toThrow();
    await expect(t.query(api.mcpRead.taskList, { workerToken: "" })).rejects.toThrow();
    await expect(t.query(api.mcpRead.memorySearch, { workerToken: "wrong", text: "deploy" })).rejects.toThrow();
  });

  test("task.status: compact row plus subtask counts; null for unknown or malformed ids", async () => {
    const { t, a, p1 } = await seed();
    const res = await t.query(api.mcpRead.taskStatus, { workerToken: TOKEN, taskId: a });
    expect(res?.task).toMatchObject({ id: a, projectId: p1, title: "Add login", status: "done", mode: "orchestrated", completedAt: 5 });
    expect(res?.task).not.toHaveProperty("command");
    expect(res?.subtasks).toEqual([
      { status: "completed", count: 2 },
      { status: "failed", count: 1 },
    ]);
    expect(await t.query(api.mcpRead.taskStatus, { workerToken: TOKEN, taskId: "not-an-id" })).toBeNull();
    expect(await t.query(api.mcpRead.taskStatus, { workerToken: TOKEN, taskId: p1 })).toBeNull();
  });

  test("task.list: newest first, project and status filters, limit", async () => {
    const { t, a, b, c, p1 } = await seed();
    const all = await t.query(api.mcpRead.taskList, { workerToken: TOKEN });
    expect(all.tasks.map((r) => r.id)).toEqual([c, b, a]);
    const inP1 = await t.query(api.mcpRead.taskList, { workerToken: TOKEN, projectId: p1 });
    expect(inP1.tasks.map((r) => r.id)).toEqual([b, a]);
    const waiting = await t.query(api.mcpRead.taskList, { workerToken: TOKEN, projectId: p1, status: "waiting_input" });
    expect(waiting.tasks).toEqual([expect.objectContaining({ id: b, pendingQuestion: "Which footer?", mode: "direct" })]);
    const running = await t.query(api.mcpRead.taskList, { workerToken: TOKEN, status: "running" });
    expect(running.tasks.map((r) => r.id)).toEqual([c]);
    expect((await t.query(api.mcpRead.taskList, { workerToken: TOKEN, limit: 1 })).tasks).toHaveLength(1);
    expect((await t.query(api.mcpRead.taskList, { workerToken: TOKEN, projectId: "bogus" })).tasks).toEqual([]);
  });

  test("memory.search: shared plus the named project only, content capped", async () => {
    const { t, p1 } = await seed();
    const sharedOnly = await t.query(api.mcpRead.memorySearch, { workerToken: TOKEN, text: "deploy" });
    expect(sharedOnly.memories.map((m) => m.title)).toEqual(["Deploy"]);
    const withP1 = await t.query(api.mcpRead.memorySearch, { workerToken: TOKEN, text: "deploy", projectId: p1 });
    expect(withP1.memories.map((m) => m.title).sort()).toEqual(["Deploy", "P1 deploy"]);
    expect(withP1.memories.some((m) => m.title === "P2 deploy")).toBe(false);
    const long = withP1.memories.find((m) => m.title === "P1 deploy")!;
    expect(long.content).toHaveLength(MCP_MEMORY_CONTENT_MAX);
    expect(long.truncated).toBe(true);
    expect((await t.query(api.mcpRead.memorySearch, { workerToken: TOKEN, text: "   " })).memories).toEqual([]);
  });
});
