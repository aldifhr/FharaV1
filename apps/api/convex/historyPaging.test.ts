/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { loadEarlier, mergeHistory, MESSAGE_WINDOW, type EarlierPage } from "./lib/historyPaging";

/**
 * D12: history paging. A long thread is read as the newest window plus
 * cursor pages; the outline lists the turns and a jump loads the page that
 * holds the chosen turn, keeping the list contiguous.
 */

const modules = import.meta.glob("./**/*.ts");
const THREAD_SIZE = 3000;

async function seedThread(count = THREAD_SIZE) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
    const taskId = await ctx.db.insert("tasks", { projectId, title: "T", command: "do", status: "running" });
    // Every 10th message is the user's turn; the rest are agent replies.
    for (let n = 1; n <= count; n++) {
      await ctx.db.insert("messages", {
        projectId,
        taskId,
        authorType: n % 10 === 1 ? "user" : "agent",
        content: `message ${n}`,
      });
    }
    return { projectId, taskId };
  });
  return { t, ...ids };
}

type Row = { _id: string; _creationTime: number; content: string };

describe("history paging (D12)", () => {
  test("a 3,000-message thread reaches message 1 by paging", async () => {
    const { t, taskId } = await seedThread();
    const live = (await t.query(api.messages.listByTask, { taskId })) as Row[];
    expect(live).toHaveLength(MESSAGE_WINDOW);
    expect(live[0].content).toBe(`message ${THREAD_SIZE - MESSAGE_WINDOW + 1}`);

    const scope = { kind: "task" as const, taskId };
    const fetchPage = (args: { before: number; floor?: number; limit?: number }) =>
      t.query(api.messages.pageEarlier, { scope, ...args }) as Promise<EarlierPage<Row>>;
    let earlier: Row[] = [];
    let hasMore = true;
    let pages = 0;
    while (hasMore) {
      ({ earlier, hasMore } = await loadEarlier(fetchPage, { earlier, live }));
      pages++;
      expect(pages).toBeLessThan(50);
    }
    const all = mergeHistory(earlier, live);
    expect(all).toHaveLength(THREAD_SIZE);
    expect(all[0].content).toBe("message 1");
    expect(all[THREAD_SIZE - 1].content).toBe(`message ${THREAD_SIZE}`);
    expect(new Set(all.map((m) => m._id)).size).toBe(THREAD_SIZE);
    // 2,500 older rows at the default page of 200.
    expect(pages).toBe(13);
  }, 120_000);

  test("the outline jump loads the page that holds the turn", async () => {
    const { t, taskId } = await seedThread();
    const scope = { kind: "task" as const, taskId };
    const live = (await t.query(api.messages.listByTask, { taskId })) as Row[];
    const outline = await t.query(api.messages.turnOutline, { scope });
    expect(outline.truncated).toBe(false);
    expect(outline.turns).toHaveLength(THREAD_SIZE / 10);
    expect(outline.turns[0]).toMatchObject({ turn: 1, preview: "message 1" });
    const target = outline.turns[1]; // message 11, far behind the live window
    expect(live.some((m) => m._id === target._id)).toBe(false);

    const fetchPage = (args: { before: number; floor?: number; limit?: number }) =>
      t.query(api.messages.pageEarlier, { scope, ...args }) as Promise<EarlierPage<Row>>;
    const { earlier, hasMore } = await loadEarlier(fetchPage, { earlier: [], live }, { floor: target._creationTime });
    const all = mergeHistory(earlier, live);
    expect(all.some((m) => m._id === target._id)).toBe(true);
    expect(all[0].content).toBe("message 11");
    // Contiguous from the turn to the newest message, and older rows remain.
    expect(all).toHaveLength(THREAD_SIZE - 10);
    expect(hasMore).toBe(true);
  }, 120_000);

  test("a floor page reports when the range spans more than one page", async () => {
    const { t, taskId } = await seedThread(60);
    const scope = { kind: "task" as const, taskId };
    const rows = (await t.query(api.messages.listByTask, { taskId })) as Row[];
    const newest = rows[rows.length - 1];
    const page = await t.query(api.messages.pageEarlier, { scope, before: newest._creationTime, floor: rows[0]._creationTime, limit: 20 });
    expect(page.rows).toHaveLength(20);
    expect(page.reachedFloor).toBe(false);
    const rest = await t.query(api.messages.pageEarlier, { scope, before: newest._creationTime, floor: rows[50]._creationTime, limit: 20 });
    expect(rest.rows.map((m) => m.content)).toEqual(Array.from({ length: 9 }, (_, i) => `message ${51 + i}`));
    expect(rest).toMatchObject({ reachedFloor: true, hasMore: true });
  });

  test("project scope outline skips task-thread turns", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      const taskId = await ctx.db.insert("tasks", { projectId, title: "T", command: "do", status: "running" });
      await ctx.db.insert("messages", { projectId, authorType: "user", content: "chat turn\nsecond line" });
      await ctx.db.insert("messages", { projectId, taskId, authorType: "user", content: "thread reply" });
      return projectId;
    });
    const outline = await t.query(api.messages.turnOutline, { scope: { kind: "project", projectId } });
    expect(outline.turns.map((turn) => turn.preview)).toEqual(["chat turn"]);
  });

  test("task events page by sequence down to the first event", async () => {
    const t = convexTest(schema, modules);
    const taskId = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      const taskId = await ctx.db.insert("tasks", { projectId, title: "T", command: "do", status: "running" });
      for (let sequence = 1; sequence <= 1200; sequence++) {
        await ctx.db.insert("taskEvents", { taskId, projectId, type: "tool.started", payload: {}, sequence });
      }
      return taskId;
    });
    const window = await t.query(api.taskEvents.listByTask, { taskId });
    let before = window[0].sequence as number;
    const seen: number[] = [];
    for (let pages = 0; pages < 20; pages++) {
      const page = await t.query(api.taskEvents.pageEarlier, { taskId, beforeSequence: before });
      seen.unshift(...page.rows.map((row) => row.sequence as number));
      if (!page.hasMore) break;
      before = page.rows[0].sequence as number;
    }
    expect(seen[0]).toBe(1);
    expect(seen).toEqual(Array.from({ length: 700 }, (_, i) => i + 1));
  }, 60_000);
});
