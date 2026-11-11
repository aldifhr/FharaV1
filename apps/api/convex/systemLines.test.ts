/// <reference types="vite/client" />
/**
 * O2: System status lines. A System line is a message with
 * `voice: "system"` and no agentId; identical lines on one task are posted
 * once; and a System line never reaches a model as transcript.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { buildChatMessages } from "./lib/prompts/chat";
import { isSystemLine, normalizeSystemLine } from "./lib/systemLine";

const modules = import.meta.glob("./**/*.ts");
const makeT = () => convexTest(schema, modules);

describe("systemLines.insert", () => {
  test("no agentId, voice system, deduped per task", async () => {
    const t = makeT();
    const { projectId, taskId } = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      const taskId = await ctx.db.insert("tasks", { projectId, title: "T", command: "c", status: "running" });
      return { projectId, taskId };
    });
    await t.mutation(internal.systemLines.insert, { projectId, taskId, content: "Sent to @Frontend: Build page" });
    await t.mutation(internal.systemLines.insert, { projectId, taskId, content: "Sent to @Frontend: Build page" });
    await t.mutation(internal.systemLines.insert, { projectId, taskId, content: "Planned 2 subtasks" });
    const rows = await t.run(async (ctx) => await ctx.db.query("messages").collect());
    expect(rows.map((row) => row.content)).toEqual(["Sent to Frontend: Build page", "Planned 2 subtasks"]);
    for (const row of rows) {
      expect(row.agentId).toBeUndefined();
      expect(row.voice).toBe("system");
      expect(row.authorType).toBe("agent");
    }
  });
});

describe("System lines stay out of LLM transcripts", () => {
  test("buildChatMessages drops System rows", () => {
    const msgs = buildChatMessages([
      { authorType: "user", content: "add a CSV export" },
      { authorType: "agent", voice: "system", content: "Sent to Backend" },
      { authorType: "agent", agentId: "be", content: "Done: export added." },
      { authorType: "user", content: "thanks, now the button" },
    ]);
    expect(JSON.stringify(msgs)).not.toContain("Sent to Backend");
    expect(JSON.stringify(msgs)).toContain("Done: export added.");
    expect(msgs.at(-1)).toEqual({ role: "user", content: "thanks, now the button" });
  });

  test("helpers", () => {
    expect(isSystemLine({ voice: "system" })).toBe(true);
    expect(isSystemLine({})).toBe(false);
    expect(normalizeSystemLine("  Planned\n 3 subtasks  ")).toBe("Planned 3 subtasks");
    expect(normalizeSystemLine("x".repeat(500))).toHaveLength(300);
  });
});
