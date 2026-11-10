/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  BRIEF_QUESTIONS_MAX,
  BRIEF_QUESTION_MAX,
  BRIEF_TEXT_MAX,
  addOpenQuestion,
  applyBriefPatch,
  briefAfterNode,
  formatBriefSection,
  removeOpenQuestion,
} from "./lib/brief";

const modules = import.meta.glob("./**/*.ts");
const SERVICE_TOKEN = "brief-harness-token";

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
    return await ctx.db.insert("tasks", {
      projectId,
      title: "Add dark mode",
      command: "Add a dark mode toggle to settings",
      status: "running",
      workerId: "w1",
      leaseExpiresAt: Date.now() + 60_000,
    });
  });
}

describe("brief helpers (lib/brief.ts)", () => {
  test("absent key keeps, explicit null clears, empty string clears", () => {
    const start = { objective: "o", owner: "backend", nextStep: "n", openQuestions: ["q1"] };
    const next = applyBriefPatch(start, { nextStep: null, owner: "" });
    expect(next.objective).toBe("o");
    expect(next.nextStep).toBeUndefined();
    expect(next.owner).toBeUndefined();
    expect(next.openQuestions).toEqual(["q1"]);
    expect(applyBriefPatch(start, { openQuestions: null }).openQuestions).toEqual([]);
  });

  test("caps: 4000 chars, 20 questions of 500 chars", () => {
    const next = applyBriefPatch(null, {
      objective: "x".repeat(BRIEF_TEXT_MAX + 50),
      openQuestions: Array.from({ length: 30 }, (_, i) => `${i}-${"q".repeat(BRIEF_QUESTION_MAX)}`),
    });
    expect(next.objective).toHaveLength(BRIEF_TEXT_MAX);
    expect(next.openQuestions).toHaveLength(BRIEF_QUESTIONS_MAX);
    expect(next.openQuestions.every((q) => q.length <= BRIEF_QUESTION_MAX)).toBe(true);
  });

  test("question add dedupes and resolve removes", () => {
    const qs = addOpenQuestion(addOpenQuestion([], "Which style?"), "Which style?");
    expect(qs).toEqual(["Which style?"]);
    expect(removeOpenQuestion(qs, "Which style?")).toEqual([]);
  });

  test("briefAfterNode names the node and outcome, sets next step and owner", () => {
    const patch = briefAfterNode({
      nodeKey: "s1",
      title: "Write toggle",
      role: "Frontend",
      status: "completed",
      summary: "added Toggle.tsx",
      next: { key: "s2", title: "Review", role: "Reviewer", owner: "reviewer" },
    });
    expect(patch.latestResult).toBe("Frontend · s1 (Write toggle) completed: added Toggle.tsx");
    expect(patch.nextStep).toBe("Reviewer · s2 (Review)");
    expect(patch.owner).toBe("reviewer");
    expect(patch.objective).toBeUndefined();
  });

  test("formatBriefSection is empty for an empty brief and bounded otherwise", () => {
    expect(formatBriefSection({ openQuestions: [] })).toBe("");
    const text = formatBriefSection({ objective: "o".repeat(5000), nextStep: "do it", openQuestions: ["q"] }, 400);
    expect(text.length).toBeLessThanOrEqual(400);
    expect(text).toContain("Task brief");
  });
});

describe("briefs functions", () => {
  test("user update upserts, starts the objective from the request, null clears", async () => {
    const t = convexTest(schema, modules);
    const taskId = await seed(t);
    expect(await t.query(api.briefs.get, { taskId })).toBeNull();
    await t.mutation(api.briefs.update, { taskId, nextStep: "Ship it" });
    let brief = await t.query(api.briefs.get, { taskId });
    expect(brief?.objective).toBe("Add a dark mode toggle to settings");
    expect(brief?.nextStep).toBe("Ship it");
    expect(brief?.updatedBy).toBe("user");
    await t.mutation(api.briefs.update, { taskId, nextStep: null });
    brief = await t.query(api.briefs.get, { taskId });
    expect(brief?.nextStep).toBeUndefined();
    expect(brief?.objective).toBe("Add a dark mode toggle to settings");
  });

  test("worker write is token-gated; an escalation question lands and leaves when answered", async () => {
    process.env.CONVEX_SERVICE_TOKEN = SERVICE_TOKEN;
    const t = convexTest(schema, modules);
    const taskId = await seed(t);
    await expect(
      t.action(api.worker.updateTaskBrief, { taskId, latestResult: "x", workerToken: "wrong" })
    ).rejects.toThrow("Worker authentication required");
    await t.action(api.worker.updateTaskBrief, { taskId, latestResult: "s1 completed", workerToken: SERVICE_TOKEN });
    expect((await t.action(api.worker.getTaskBrief, { taskId, workerToken: SERVICE_TOKEN }))?.latestResult).toBe(
      "s1 completed"
    );

    await t.action(api.worker.pauseForInput, { taskId, question: "Which style?", workerId: "w1", workerToken: SERVICE_TOKEN });
    expect((await t.query(api.briefs.get, { taskId }))?.openQuestions).toEqual(["Which style?"]);

    const res = await t.mutation(api.tasks.answerQuestion, { taskId, answer: "Minimal", question: "Which style?" });
    expect(res.applied).toBe(true);
    expect((await t.query(api.briefs.get, { taskId }))?.openQuestions).toEqual([]);
  });

  test("a task delete removes its brief", async () => {
    const t = convexTest(schema, modules);
    const taskId = await seed(t);
    await t.mutation(api.briefs.update, { taskId, nextStep: "x" });
    await t.run(async (ctx) => ctx.db.patch(taskId, { status: "done", workerId: undefined, leaseExpiresAt: undefined }));
    await t.mutation(api.tasks.remove, { taskId });
    expect(await t.run(async (ctx) => ctx.db.query("taskBriefs").collect())).toHaveLength(0);
  });
});
