/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { classifyQuestion } from "./lib/questionPolicy";
import type { PermissionMode } from "./lib/permissionModes";

/** GOAT G13: CTO-first questions — policy, decision turns, the answer outbox, audit rows, expiry. */

const modules = import.meta.glob("./**/*.ts");
const TOKEN = "decision-turn-harness-token";
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

async function seed(mode: PermissionMode = "auto_edits", withCto = true) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const cto = await ctx.db.insert("agents", { name: "CTO", role: "cto", status: "idle", isEnabled: true });
    const be = await ctx.db.insert("agents", { name: "Backend", role: "backend", status: "idle", isEnabled: true });
    const p = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", agentIds: withCto ? [cto, be] : [be] });
    const task = await ctx.db.insert("tasks", { projectId: p, title: "Add CSV export", command: "c", status: "running", permissionMode: mode });
    const idle = await ctx.db.insert("tasks", { projectId: p, title: "Direct", command: "d", status: "queued", permissionMode: mode });
    return { p, cto, task, idle };
  });
  return { t, ...ids };
}

const depQuestion = {
  source: "escalation" as const,
  delivery: "inline" as const,
  question: 'Subtask "implement" stopped: New dependency (zod). The change adds a dependency the subtask does not name: zod',
  options: ["Allow the dependency", "Do it without a new dependency"],
  kind: "new_dependency",
  detail: "zod",
  subtaskKey: "implement",
  ttlMs: 60_000,
};

describe("question policy", () => {
  test("a new dependency inside the permission mode goes to the CTO; supervised mode keeps it with the user", () => {
    expect(classifyQuestion({ kind: "new_dependency", question: "Add zod?", permissionMode: "auto_edits" })).toMatchObject({ route: "cto" });
    expect(classifyQuestion({ kind: "new_dependency", question: "Add zod?", permissionMode: "supervised" })).toMatchObject({ route: "user" });
    expect(classifyQuestion({ kind: "schema_change", question: "Add an optional field?", permissionMode: "supervised" })).toMatchObject({ route: "cto" });
  });

  test("secrets, push and destructive questions always reach the user, whatever the kind or mode", () => {
    const cases = [
      "Which API key should the payment client use?",
      "Can I read the token from .env to call the service?",
      "Should I push the branch and open a pull request?",
      "Deploy the new service to production now?",
      "Delete the old migrations folder?",
      "Use git push --force to fix the history?",
    ];
    for (const question of cases) {
      for (const kind of [undefined, "new_dependency", "schema_change", "out_of_scope"]) {
        expect(classifyQuestion({ kind, question, permissionMode: "full_access" }).route, `${kind}: ${question}`).toBe("user");
      }
    }
    expect(classifyQuestion({ kind: "security", question: "Hash with bcrypt?", permissionMode: "full_access" }).route).toBe("user");
    expect(classifyQuestion({ kind: "ambiguous", question: "Which layout?", permissionMode: "full_access" }).route).toBe("user");
    expect(classifyQuestion({ question: "Should the pricing page show monthly prices?", permissionMode: "full_access" }).route).toBe("user");
  });
});

describe("CTO decision turn", () => {
  test("a new-dependency question within policy is answered by the CTO: outbox signal + audit row", async () => {
    const { t, task } = await seed("auto_edits");
    const opened = await t.mutation(api.decisionTurns.open, { ...W, taskId: task, dedupeKey: "esc:dep", ...depQuestion });
    expect(opened).toMatchObject({ route: "cto", status: "open" });
    if (opened.route !== "cto") throw new Error("expected cto");
    const answered = await t.mutation(api.decisionTurns.answer, {
      ...W,
      turnId: opened.turnId,
      verdict: "answer",
      answer: "Allow zod; it is small and already the project's validation style.",
      chosenOption: "Allow the dependency",
      rationale: "Keeps validation consistent",
    });
    expect(answered).toMatchObject({ applied: true, status: "answered" });
    const { turn, signals, audits } = await t.run(async (ctx) => ({
      turn: await ctx.db.get(opened.turnId),
      signals: await ctx.db.query("taskSignals").collect(),
      audits: await ctx.db.query("audit").collect(),
    }));
    expect(turn).toMatchObject({ status: "answered", chosenOption: "Allow the dependency", role: "cto" });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ name: "answer", decisionTurnId: opened.turnId, taskId: task });
    expect(signals[0].consumedAt).toBeUndefined();
    const audit = audits.find((row) => row.action === "decision.cto_answered");
    expect(audit).toMatchObject({ actor: "cto:CTO", tool: "decision_turn", decision: "allowed", taskId: task });
    expect((audit?.details as { chosenOption?: string }).chosenOption).toBe("Allow the dependency");

    // A run that died before applying it gets the same committed answer back.
    expect(await t.mutation(api.decisionTurns.open, { ...W, taskId: task, dedupeKey: "esc:dep", ...depQuestion })).toMatchObject({
      route: "cto",
      status: "answered",
      chosenOption: "Allow the dependency",
    });
    await t.mutation(api.decisionTurns.consume, { ...W, turnId: opened.turnId });
    // Applied, and the same question came back: now it is the user's.
    expect(await t.mutation(api.decisionTurns.open, { ...W, taskId: task, dedupeKey: "esc:dep", ...depQuestion })).toMatchObject({ route: "user" });
  });

  test("the CTO declining writes an audit row and no outbox answer", async () => {
    const { t, task } = await seed("auto_edits");
    const opened = await t.mutation(api.decisionTurns.open, { ...W, taskId: task, dedupeKey: "esc:dep2", ...depQuestion });
    if (opened.route !== "cto") throw new Error("expected cto");
    await t.mutation(api.decisionTurns.answer, { ...W, turnId: opened.turnId, verdict: "escalate", rationale: "Not sure" });
    const { signals, audits } = await t.run(async (ctx) => ({
      signals: await ctx.db.query("taskSignals").collect(),
      audits: await ctx.db.query("audit").collect(),
    }));
    expect(signals).toHaveLength(0);
    expect(audits.some((row) => row.action === "decision.cto_escalated" && row.decision === "denied")).toBe(true);
  });

  test("an answer that crosses the ceiling is escalated, never delivered", async () => {
    const { t, task } = await seed("auto_edits");
    const opened = await t.mutation(api.decisionTurns.open, { ...W, taskId: task, dedupeKey: "esc:dep3", ...depQuestion });
    if (opened.route !== "cto") throw new Error("expected cto");
    const result = await t.mutation(api.decisionTurns.answer, {
      ...W,
      turnId: opened.turnId,
      verdict: "answer",
      answer: "Allow it and push the branch right away.",
      chosenOption: "Allow the dependency",
      rationale: "fast",
    });
    expect(result).toMatchObject({ applied: true, status: "escalated" });
    expect(await t.run((ctx) => ctx.db.query("taskSignals").collect())).toHaveLength(0);
  });

  test("a secret question and a push question reach the user: no turn, no CTO", async () => {
    const { t, task } = await seed("full_access");
    for (const [i, question] of ["Which API key should the client use for zod schemas?", "Push the dependency change and open a PR?"].entries()) {
      const routed = await t.mutation(api.decisionTurns.open, { ...W, taskId: task, dedupeKey: `esc:hard${i}`, ...depQuestion, question });
      expect(routed).toMatchObject({ route: "user" });
    }
    expect(await t.run((ctx) => ctx.db.query("decisionTurns").collect())).toHaveLength(0);
  });

  test("no CTO in the team: the user decides (noCto)", async () => {
    const { t, task } = await seed("auto_edits", false);
    expect(await t.mutation(api.decisionTurns.open, { ...W, taskId: task, dedupeKey: "esc:nocto", ...depQuestion })).toMatchObject({
      route: "user",
      noCto: true,
    });
  });

  test("a wrong service token is refused", async () => {
    const { t, task } = await seed();
    await expect(t.mutation(api.decisionTurns.open, { ...W, workerToken: "x", taskId: task, dedupeKey: "k", ...depQuestion })).rejects.toThrow();
  });
});

describe("expiry never auto-picks", () => {
  test("a late answer is refused; the turn expires with no option chosen and no outbox row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
    const { t, task } = await seed("auto_edits");
    const opened = await t.mutation(api.decisionTurns.open, { ...W, taskId: task, dedupeKey: "esc:late", ...depQuestion });
    if (opened.route !== "cto") throw new Error("expected cto");
    vi.setSystemTime(new Date("2026-11-12T00:05:00Z"));
    const late = await t.mutation(api.decisionTurns.answer, {
      ...W,
      turnId: opened.turnId,
      verdict: "answer",
      answer: "Allow it",
      chosenOption: "Allow the dependency",
      rationale: "r",
    });
    expect(late).toMatchObject({ applied: false, reason: "expired" });
    const { turn, signals } = await t.run(async (ctx) => ({
      turn: await ctx.db.get(opened.turnId),
      signals: await ctx.db.query("taskSignals").collect(),
    }));
    expect(turn?.status).toBe("expired");
    expect(turn?.chosenOption).toBeUndefined();
    expect(turn?.answer).toBeUndefined();
    expect(signals).toHaveLength(0);
  });

  test("the sweep expires a direct-thread question and hands it to the user without picking an option", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
    const { t, idle } = await seed("auto_edits");
    const asked = await t.mutation(api.mcpWrite.questionAsk, {
      workerToken: TOKEN,
      clientRequestId: "q-expire",
      taskId: idle,
      question: "Should the export module use a streaming writer or build the CSV in memory?",
      options: ["Streaming writer", "In memory"],
      ctoFirst: { ttlMs: 60_000 },
    });
    expect(asked).toMatchObject({ kind: "asked", routedTo: "cto" });
    // Routed to the CTO: not parked for the user yet.
    expect(await t.run((ctx) => ctx.db.get(idle))).toMatchObject({ status: "queued" });
    vi.setSystemTime(new Date("2026-11-12T00:02:00Z"));
    await t.mutation(internal.decisionTurns.sweep, {});
    const { task, turn, signals } = await t.run(async (ctx) => ({
      task: await ctx.db.get(idle),
      turn: (await ctx.db.query("decisionTurns").collect())[0],
      signals: await ctx.db.query("taskSignals").collect(),
    }));
    expect(turn).toMatchObject({ status: "expired" });
    expect(turn.chosenOption).toBeUndefined();
    expect(signals).toHaveLength(0);
    expect(task).toMatchObject({ status: "waiting_input", pendingOptions: ["Streaming writer", "In memory"] });
    expect(task?.pendingQuestion).toMatch(/streaming writer/);
    const inputs = await t.run((ctx) => ctx.db.query("taskInputs").collect());
    expect(inputs).toHaveLength(0);
  });
});

describe("question.ask (direct threads via MCP)", () => {
  test("a technical question goes to the CTO and its answer is delivered through the outbox", async () => {
    const { t, idle } = await seed("auto_edits");
    await t.mutation(api.mcpWrite.questionAsk, {
      workerToken: TOKEN,
      clientRequestId: "q-tech",
      taskId: idle,
      question: "Should the CSV export live in its own module or in the orders query file?",
      ctoFirst: { ttlMs: 60_000 },
    });
    const claimed = await t.mutation(api.decisionTurns.claimNext, W);
    expect(claimed).toMatchObject({ taskId: idle });
    await t.mutation(api.decisionTurns.answer, {
      ...W,
      turnId: claimed!.turnId,
      verdict: "answer",
      answer: "Give it its own module next to the orders queries.",
      rationale: "Keeps the query file small",
    });
    await t.finishAllScheduledFunctions(() => undefined);
    const { inputs, signals, audits } = await t.run(async (ctx) => ({
      inputs: await ctx.db.query("taskInputs").collect(),
      signals: await ctx.db.query("taskSignals").collect(),
      audits: await ctx.db.query("audit").collect(),
    }));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ kind: "answer", text: "CTO: Give it its own module next to the orders queries.", delivered: false });
    expect(signals[0].consumedBy).toBe("deliver");
    expect(audits.some((row) => row.action === "decision.cto_answered")).toBe(true);
  });

  test("a secret question and a push question are parked for the user, never routed", async () => {
    const { t, idle, p } = await seed("full_access");
    const asked = await t.mutation(api.mcpWrite.questionAsk, {
      workerToken: TOKEN,
      clientRequestId: "q-secret",
      taskId: idle,
      question: "Which password should the database module use?",
      ctoFirst: { ttlMs: 60_000 },
    });
    expect(asked).toMatchObject({ kind: "asked" });
    expect((asked as { routedTo?: string }).routedTo).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.get(idle))).toMatchObject({ status: "waiting_input" });

    const other = await t.run((ctx) => ctx.db.insert("tasks", { projectId: p, title: "T2", command: "c", status: "queued", permissionMode: "full_access" }));
    const push = await t.mutation(api.mcpWrite.questionAsk, {
      workerToken: TOKEN,
      clientRequestId: "q-push",
      taskId: other,
      question: "Should I merge the export module branch into main?",
      ctoFirst: { ttlMs: 60_000 },
    });
    expect((push as { routedTo?: string }).routedTo).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.get(other))).toMatchObject({ status: "waiting_input" });
    expect(await t.run((ctx) => ctx.db.query("decisionTurns").collect())).toHaveLength(0);
  });
});
