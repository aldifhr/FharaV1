/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

/** Plan N7: native questions in direct threads — card, routing (G13 policy), answer as the next user.message. */

const modules = import.meta.glob("./**/*.ts");
const TOKEN = "direct-question-harness-token";
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.CONVEX_SERVICE_TOKEN;
  process.env.CONVEX_SERVICE_TOKEN = TOKEN;
});
afterEach(() => {
  vi.useRealTimers();
  if (previous === undefined) delete process.env.CONVEX_SERVICE_TOKEN;
  else process.env.CONVEX_SERVICE_TOKEN = previous;
});

const W = { workerToken: TOKEN, workerId: "w1" };

async function thread(withCto = true) {
  const t = convexTest(schema, modules);
  const { projectId } = await t.run(async (ctx) => {
    const cto = await ctx.db.insert("agents", { name: "CTO", role: "cto", status: "idle", isEnabled: true });
    const be = await ctx.db.insert("agents", { name: "Backend", role: "backend", status: "idle", isEnabled: true });
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/ws/p", agentIds: withCto ? [cto, be] : [be] });
    return { projectId };
  });
  const { taskId } = await t.mutation(api.directThreads.create, { projectId, role: "backend", text: "build the export", clientId: "c1", permissionMode: "auto_edits" });
  const claim = await t.mutation(internal.directThreads.claim, { workerId: "w1" });
  expect(claim?.taskId).toBe(taskId);
  return { t, taskId };
}

type T = Awaited<ReturnType<typeof thread>>["t"];
const events = (t: T, taskId: Id<"tasks">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("taskEvents").withIndex("by_task_and_sequence", (q) => q.eq("taskId", taskId)).collect()).map((e) => ({ type: e.type, payload: e.payload as any }))
  );
const cards = async (t: T, taskId: Id<"tasks">) => (await events(t, taskId)).filter((e) => e.payload?.kind === "question");
const userTexts = async (t: T, taskId: Id<"tasks">) => (await events(t, taskId)).filter((e) => e.type === "user.message").map((e) => e.payload.text);

const technical = {
  itemId: "call-1",
  question: "Should the CSV export live in its own module or in the orders query file?",
  options: ["Own module", "Orders query file"],
};

describe("directQuestions.ask → the user", () => {
  test("a card is written; the user's answer is the next user.message and closes it", async () => {
    const { t, taskId } = await thread();
    const routed = await t.mutation(api.directQuestions.ask, { ...W, taskId, ...technical }); // CTO-first off
    expect(routed).toMatchObject({ route: "user", questionId: "call-1" });
    expect(await cards(t, taskId)).toEqual([
      { type: "approval.requested", payload: expect.objectContaining({ kind: "question", questionId: "call-1", options: technical.options, answerer: "user" }) },
    ]);
    // A retried ask (same tool call) writes nothing new.
    await t.mutation(api.directQuestions.ask, { ...W, taskId, ...technical });
    expect(await cards(t, taskId)).toHaveLength(1);

    await t.mutation(api.directQuestions.answer, { taskId, questionId: "call-1", answer: "Own module", clientId: "a1" });
    expect(await userTexts(t, taskId)).toEqual(["build the export", "Own module"]);
    expect((await cards(t, taskId)).at(-1)).toEqual({
      type: "approval.resolved",
      payload: expect.objectContaining({ kind: "question", questionId: "call-1", decision: "answered", answer: "Own module", by: "user" }),
    });
    // The same clientId again is the message already written; another answer is refused.
    await expect(t.mutation(api.directQuestions.answer, { taskId, questionId: "call-1", answer: "Own module", clientId: "a1" })).resolves.toMatchObject({ deduped: true });
    await expect(t.mutation(api.directQuestions.answer, { taskId, questionId: "call-1", answer: "Other", clientId: "a2" })).rejects.toThrow(/already answered/);
  });

  test("a plain chat message answers the open question too", async () => {
    const { t, taskId } = await thread();
    await t.mutation(api.directQuestions.ask, { ...W, taskId, ...technical });
    await t.mutation(api.directThreads.send, { taskId, text: "Orders query file, keep it simple", clientId: "m2" });
    expect((await cards(t, taskId)).at(-1)?.payload).toMatchObject({ decision: "answered", by: "user", answer: "Orders query file, keep it simple" });
  });

  test("secret, push and destructive questions reach the user even with CTO-first on", async () => {
    const { t, taskId } = await thread();
    const hard = [
      "Which API key should the payment module use?",
      "Should I push the export branch and open a pull request?",
      "Delete the old migrations folder before adding the module?",
    ];
    for (const [i, question] of hard.entries()) {
      const routed = await t.mutation(api.directQuestions.ask, { ...W, taskId, itemId: `hard-${i}`, question, options: ["Yes", "No"], ctoFirst: { ttlMs: 60_000 } });
      expect(routed.route, question).toBe("user");
      await t.mutation(api.directQuestions.answer, { taskId, questionId: `hard-${i}`, answer: "No", clientId: `h${i}` });
    }
    expect(await t.run((ctx) => ctx.db.query("decisionTurns").collect())).toHaveLength(0);
  });

  test("a wrong service token or a worker without the lease is refused", async () => {
    const { t, taskId } = await thread();
    await expect(t.mutation(api.directQuestions.ask, { ...W, workerToken: "x", taskId, ...technical })).rejects.toThrow();
    await expect(t.mutation(api.directQuestions.ask, { ...W, workerId: "w2", taskId, ...technical })).rejects.toThrow(/Lease lost/);
  });
});

describe("directQuestions.ask → the CTO (within policy)", () => {
  test("the decision-turn runner answers; the answer is delivered as the next user.message", async () => {
    const { t, taskId } = await thread();
    const routed = await t.mutation(api.directQuestions.ask, { ...W, taskId, ...technical, ctoFirst: { ttlMs: 60_000 } });
    expect(routed).toMatchObject({ route: "cto" });
    expect((await cards(t, taskId))[0].payload).toMatchObject({ answerer: "cto", turnId: expect.any(String) });

    // The worker's poller (decisionTurn/poller.ts) claims and answers it.
    const claimed = await t.mutation(api.decisionTurns.claimNext, W);
    expect(claimed).toMatchObject({ taskId, question: technical.question, options: technical.options });
    await t.mutation(api.decisionTurns.answer, {
      ...W,
      turnId: claimed!.turnId,
      verdict: "answer",
      answer: "Give it its own module next to the orders queries.",
      chosenOption: "Own module",
      rationale: "Keeps the query file small",
    });
    await t.finishAllScheduledFunctions(() => undefined);
    expect(await userTexts(t, taskId)).toEqual(["build the export", "CTO: Give it its own module next to the orders queries."]);
    expect((await cards(t, taskId)).at(-1)?.payload).toMatchObject({ decision: "answered", by: "cto" });
    const { signals, inputs } = await t.run(async (ctx) => ({
      signals: await ctx.db.query("taskSignals").collect(),
      inputs: await ctx.db.query("taskInputs").collect(),
    }));
    expect(signals[0].consumedBy).toBe("deliver");
    expect(inputs).toHaveLength(0); // a direct thread gets a message, not a task input
  });

  test("the CTO declining re-shows the card for the user", async () => {
    const { t, taskId } = await thread();
    await t.mutation(api.directQuestions.ask, { ...W, taskId, ...technical, ctoFirst: { ttlMs: 60_000 } });
    const claimed = await t.mutation(api.decisionTurns.claimNext, W);
    await t.mutation(api.decisionTurns.answer, { ...W, turnId: claimed!.turnId, verdict: "escalate", rationale: "Not sure" });
    const shown = (await cards(t, taskId)).map((c) => c.payload.answerer);
    expect(shown).toEqual(["cto", "user"]);
    expect(await userTexts(t, taskId)).toEqual(["build the export"]);
  });

  test("the user answering first wins: the CTO's late answer is not sent", async () => {
    const { t, taskId } = await thread();
    await t.mutation(api.directQuestions.ask, { ...W, taskId, ...technical, ctoFirst: { ttlMs: 60_000 } });
    const claimed = await t.mutation(api.decisionTurns.claimNext, W);
    await t.mutation(api.directQuestions.answer, { taskId, questionId: "call-1", answer: "Orders query file", clientId: "u1" });
    await t.mutation(api.decisionTurns.answer, { ...W, turnId: claimed!.turnId, verdict: "answer", answer: "Own module.", chosenOption: "Own module", rationale: "r" });
    await t.finishAllScheduledFunctions(() => undefined);
    expect(await userTexts(t, taskId)).toEqual(["build the export", "Orders query file"]);
    const signals = await t.run((ctx) => ctx.db.query("taskSignals").collect());
    expect(signals[0].consumedBy).toBe("superseded");
  });

  test("no CTO in the team: the user answers", async () => {
    const { t, taskId } = await thread(false);
    expect(await t.mutation(api.directQuestions.ask, { ...W, taskId, ...technical, ctoFirst: { ttlMs: 60_000 } })).toMatchObject({ route: "user" });
  });
});
