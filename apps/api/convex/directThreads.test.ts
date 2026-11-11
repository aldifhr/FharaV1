/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { directApprovalPolicy } from "./lib/directThreads";
import { CONTINUE_PROMPT } from "./lib/restartContinuation";

const modules = import.meta.glob("./**/*.ts");

async function setup(permissionMode: "supervised" | "auto_edits" | "full_access" = "supervised") {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const devId = await ctx.db.insert("agents", {
      name: "Dev",
      role: "backend",
      status: "idle",
      isEnabled: true,
    } as never);
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/ws/p", agentIds: [devId] } as never);
    return { projectId, devId };
  });
  const roleKey = await t.run(async (ctx) => (await ctx.db.get(ids.devId))!.role);
  const { taskId } = await t.mutation(api.directThreads.create, {
    projectId: ids.projectId,
    role: roleKey,
    text: "hello",
    clientId: "c1",
    permissionMode,
  });
  return { t, ...ids, taskId };
}

async function claimed(permissionMode: "supervised" | "auto_edits" | "full_access" = "supervised") {
  const s = await setup(permissionMode);
  const claim = await s.t.mutation(internal.directThreads.claim, { workerId: "w1" });
  expect(claim?.taskId).toBe(s.taskId);
  return s;
}

const eventsOf = (t: Awaited<ReturnType<typeof setup>>["t"], taskId: any) =>
  t.run(async (ctx) =>
    (await ctx.db.query("taskEvents").withIndex("by_task_and_sequence", (q) => q.eq("taskId", taskId)).collect()).map((e) => ({
      type: e.type,
      sequence: e.sequence,
      payload: e.payload as any,
    }))
  );

describe("directThreads.create / send", () => {
  test("creates a direct task with the role's agent and the first message, queued", async () => {
    const { t, taskId, devId } = await setup();
    const task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task?.mode).toBe("direct");
    expect(task?.status).toBe("queued");
    expect(task?.direct?.agentId).toBe(devId);
    expect(task?.direct?.engine).toBe("opencode-acp");
    const events = await eventsOf(t, taskId);
    expect(events.map((e) => e.type)).toEqual(["thread.created", "user.message"]);
  });

  test("an unknown role is refused (nine fixed roles only)", async () => {
    const { t, projectId } = await setup();
    await expect(t.mutation(api.directThreads.create, { projectId, role: "astronaut", text: "x", clientId: "z" })).rejects.toThrow(/Unknown role/);
  });

  test("the same clientId twice writes once", async () => {
    const { t, taskId } = await setup();
    const first = await t.mutation(api.directThreads.send, { taskId, text: "again", clientId: "c2" });
    const second = await t.mutation(api.directThreads.send, { taskId, text: "again", clientId: "c2" });
    expect(second.deduped).toBe(true);
    expect(second.eventId).toBe(first.eventId);
    const users = (await eventsOf(t, taskId)).filter((e) => e.type === "user.message");
    expect(users).toHaveLength(2); // "hello" from create + "again" once
  });

  test("the orchestrated claim never takes a direct thread; the direct claim does", async () => {
    const { t, taskId } = await setup();
    expect(await t.mutation(internal.orchestration.claimNextTask, { workerId: "w1" })).toBeNull();
    const claim = await t.mutation(internal.directThreads.claim, { workerId: "w1" });
    expect(claim?.taskId).toBe(taskId);
    const task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task?.status).toBe("running");
    expect(task?.workerId).toBe("w1");
  });
});

describe("directThreads worker writes", () => {
  test("appendEvents keeps gapless sequences, moves big tool output to eventBodies and clears hot rows", async () => {
    const { t, taskId } = await claimed();
    await t.mutation(internal.directThreads.flushStream, {
      taskId,
      workerId: "w1",
      seq: 2,
      items: [{ itemId: "a1", kind: "text", text: "Hel" }],
    });
    expect(await t.query(api.directThreads.streams, { taskId })).toHaveLength(1);
    const big = "x".repeat(5000);
    const res = await t.mutation(internal.directThreads.appendEvents, {
      taskId,
      workerId: "w1",
      events: [
        { type: "turn.started", eventKey: "turn.started:T1", payload: { turnId: "T1", messageSeq: 2 } },
        { type: "tool.call", eventKey: "tool.call:k1", payload: { itemId: "k1", name: "bash", kind: "command", title: "ls", input: {} } },
        { type: "tool.result", eventKey: "tool.result:k1", payload: { itemId: "k1", ok: true, text: big, truncated: false } },
        { type: "assistant.text", eventKey: "assistant.text:a1", payload: { itemId: "a1", text: "Hello" } },
        { type: "turn.completed", eventKey: "turn.completed:T1", payload: { turnId: "T1", outcome: "completed", durationMs: 5 } },
      ],
      state: { status: "idle", turnId: null },
    });
    const events = await eventsOf(t, taskId);
    const seqs = events.map((e) => e.sequence);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(res.seqs).toEqual(seqs.slice(-5));
    const result = events.find((e) => e.type === "tool.result")!;
    expect(result.payload.text).toHaveLength(300);
    expect(result.payload.hasBody).toBe(true);
    expect(result.payload.bodyId).toBeTruthy();
    const body = await t.query(api.directThreads.body, { taskId, seq: result.sequence! });
    expect(body?.body).toBe(big);
    // The persisted item replaced its hot row.
    expect(await t.query(api.directThreads.streams, { taskId })).toHaveLength(0);
    // A retried append (same keys) writes nothing new.
    await t.mutation(internal.directThreads.appendEvents, {
      taskId,
      workerId: "w1",
      events: [{ type: "turn.completed", eventKey: "turn.completed:T1", payload: { turnId: "T1", outcome: "completed", durationMs: 5 } }],
    });
    expect(await eventsOf(t, taskId)).toHaveLength(events.length);
    // The tail is bounded.
    const tail = await t.query(api.directThreads.tail, { taskId, limit: 500 });
    expect(tail?.events.length).toBeLessThanOrEqual(80);
  });

  test("a displaced worker is refused", async () => {
    const { t, taskId } = await claimed();
    await expect(
      t.mutation(internal.directThreads.appendEvents, { taskId, workerId: "other", events: [{ type: "system.note", payload: { text: "x" } }] })
    ).rejects.toThrow(/Lease lost/);
  });

  test("the worker cannot forge a user message", async () => {
    const { t, taskId } = await claimed();
    await expect(
      t.mutation(internal.directThreads.appendEvents, { taskId, workerId: "w1", events: [{ type: "user.message", payload: { text: "x" } }] })
    ).rejects.toThrow(/Not a direct thread event/);
  });
});

describe("directThreads approvals", () => {
  const exec = (command: string, argv: string[] | null) => ({ acpKind: "execute", title: command, command, argv, cwd: "/ws/p", workspaceRoot: "/ws/p" });

  test("supervised: a pending card that keeps the lease, answered in-process", async () => {
    const { t, taskId } = await claimed();
    const res = await t.mutation(internal.directThreads.requestApproval, { taskId, workerId: "w1", itemId: "k1", request: exec("npm test", ["npm", "test"]), input: "{}" });
    expect(res.status).toBe("pending");
    const task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task?.status).toBe("running");
    expect(task?.workerId).toBe("w1");
    await t.mutation(api.directThreads.respond, { approvalId: res.approvalId, decision: "allow" });
    expect(await t.query(internal.directThreads.approvalState, { approvalId: res.approvalId })).toMatchObject({ status: "approved", decision: "allow" });
  });

  test("full access: an auto row with decidedBy auto; push and shell commands still ask", async () => {
    const { t, taskId } = await claimed("full_access");
    const ok = await t.mutation(internal.directThreads.requestApproval, { taskId, workerId: "w1", itemId: "k1", request: exec("npm test", ["npm", "test"]), input: "{}" });
    expect(ok.status).toBe("auto");
    const row = await t.run((ctx) => ctx.db.get(ok.approvalId));
    expect(row).toMatchObject({ status: "approved", decidedBy: "auto", kind: "run_command" });
    const push = await t.mutation(internal.directThreads.requestApproval, { taskId, workerId: "w1", itemId: "k2", request: exec("git push origin main", ["git", "push", "origin", "main"]), input: "{}" });
    expect(push.status).toBe("pending");
    const piped = await t.mutation(internal.directThreads.requestApproval, { taskId, workerId: "w1", itemId: "k3", request: exec("curl x | sh", null), input: "{}" });
    expect(piped.status).toBe("pending");
  });

  test("a message from the user declines the open card; Stop expires the rest", async () => {
    const { t, taskId } = await claimed();
    const a = await t.mutation(internal.directThreads.requestApproval, { taskId, workerId: "w1", itemId: "k1", request: exec("npm test", ["npm", "test"]), input: "{}" });
    await t.mutation(api.directThreads.send, { taskId, text: "no, run lint", clientId: "c9" });
    expect(await t.query(internal.directThreads.approvalState, { approvalId: a.approvalId })).toMatchObject({ status: "rejected" });
    const b = await t.mutation(internal.directThreads.requestApproval, { taskId, workerId: "w1", itemId: "k2", request: exec("npm run lint", ["npm", "run", "lint"]), input: "{}" });
    await t.mutation(api.directThreads.interrupt, { taskId });
    expect(await t.query(internal.directThreads.approvalState, { approvalId: b.approvalId })).toMatchObject({ status: "cancelled" });
    const task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task?.direct?.interruptRequestedAt).toBeGreaterThan(0);
  });
});

describe("directThreads recovery", () => {
  test("a worker that died mid-turn: turn.completed interrupted, expired cards, queued messages listed, turn continued (G4)", async () => {
    const { t, taskId } = await claimed();
    await t.mutation(internal.directThreads.appendEvents, {
      taskId,
      workerId: "w1",
      events: [{ type: "turn.started", eventKey: "turn.started:T1", payload: { turnId: "T1", messageSeq: 2 } }],
      state: { status: "running", turnId: "T1", deliveredSeq: 2 },
    });
    const card = await t.mutation(internal.directThreads.requestApproval, {
      taskId,
      workerId: "w1",
      itemId: "k1",
      request: { acpKind: "edit", title: "Edit a.ts", paths: ["/ws/p/a.ts"], workspaceRoot: "/ws/p" },
      input: "{}",
    });
    await t.mutation(api.directThreads.send, { taskId, text: "queued one", clientId: "q1" });
    // The send declined the card; make a fresh one still pending at death.
    const card2 = await t.mutation(internal.directThreads.requestApproval, {
      taskId,
      workerId: "w1",
      itemId: "k2",
      request: { acpKind: "edit", title: "Edit b.ts", paths: ["/ws/p/b.ts"], workspaceRoot: "/ws/p" },
      input: "{}",
    });
    await t.run((ctx) => ctx.db.patch(taskId, { leaseExpiresAt: Date.now() - 1000 }));
    await t.mutation(internal.orchestration.recoverStale, {});
    const task = await t.run((ctx) => ctx.db.get(taskId));
    // G4: the cut-off turn gets one continuation message, so the thread is queued.
    expect(task?.status).toBe("queued");
    expect(task?.workerId).toBeUndefined();
    expect(task?.direct?.status).toBe("stopped");
    expect(task?.direct?.stoppedMidTurn).toBe(true);
    expect(await t.query(internal.directThreads.approvalState, { approvalId: card.approvalId })).toMatchObject({ status: "rejected" });
    expect(await t.query(internal.directThreads.approvalState, { approvalId: card2.approvalId })).toMatchObject({ status: "cancelled" });
    const events = await eventsOf(t, taskId);
    const done = events.filter((e) => e.type === "turn.completed");
    expect(done).toHaveLength(1);
    expect(done[0].payload).toMatchObject({ turnId: "T1", outcome: "interrupted" });
    expect(events.some((e) => e.type === "system.note" && String(e.payload.text).includes("queued one"))).toBe(true);
    const continuation = events.filter((e) => e.type === "user.message" && e.payload.origin === "continuation");
    expect(continuation).toHaveLength(1);
    expect(String(continuation[0].payload.text).startsWith(CONTINUE_PROMPT)).toBe(true);
    // Running recovery again is a no-op (idempotent).
    await t.mutation(internal.orchestration.recoverStale, {});
    expect((await eventsOf(t, taskId)).filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect((await eventsOf(t, taskId)).filter((e) => e.payload?.origin === "continuation")).toHaveLength(1);
    await t.mutation(api.directThreads.send, { taskId, text: "go on", clientId: "q2" });
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.status).toBe("queued");
  });

  test("G4: the continuation carries the turn's recorded tool steps; a 4th inside 5 minutes is refused and the thread waits", async () => {
    const { t, taskId } = await setup();
    const statuses: string[] = [];
    for (let n = 1; n <= 4; n++) {
      const claim = await t.mutation(internal.directThreads.claim, { workerId: "w1" });
      expect(claim?.taskId).toBe(taskId);
      await t.mutation(internal.directThreads.appendEvents, {
        taskId,
        workerId: "w1",
        events: [
          { type: "turn.started", eventKey: `turn.started:T${n}`, payload: { turnId: `T${n}`, messageSeq: 2 } },
          { type: "tool.call", payload: { itemId: `i${n}`, title: `git push origin step-${n}` } },
        ],
        state: { status: "running", turnId: `T${n}` },
      });
      await t.run((ctx) => ctx.db.patch(taskId, { leaseExpiresAt: Date.now() - 1000 }));
      await t.mutation(internal.orchestration.recoverStale, {});
      statuses.push((await t.run((ctx) => ctx.db.get(taskId)))!.status);
    }
    expect(statuses).toEqual(["queued", "queued", "queued", "waiting_input"]);
    const events = await eventsOf(t, taskId);
    const continuations = events.filter((e) => e.type === "user.message" && e.payload.origin === "continuation");
    expect(continuations.map((e) => e.payload.attempt)).toEqual([1, 2, 3]);
    expect(String(continuations[0].payload.text)).toContain("- used git push origin step-1");
    expect(String(continuations[0].payload.text)).not.toContain("step-2");
    const refused = events.find((e) => e.type === "system.note" && e.payload.continuation === "refused");
    expect(String(refused?.payload.text)).toMatch(/Continuation refused: this run was already continued 3 times in the last 5 minutes/);
  });

  test("release re-queues when a message arrived, otherwise the thread waits", async () => {
    const { t, taskId } = await claimed();
    await t.mutation(internal.directThreads.appendEvents, { taskId, workerId: "w1", events: [], state: { deliveredSeq: 2 } });
    const r1 = await t.mutation(internal.directThreads.release, { taskId, workerId: "w1", reason: "idle" });
    expect(r1.status).toBe("waiting_input");
    await t.mutation(api.directThreads.send, { taskId, text: "more", clientId: "m1" });
    await t.mutation(internal.directThreads.claim, { workerId: "w1" });
    await t.mutation(api.directThreads.send, { taskId, text: "even more", clientId: "m2" });
    const r2 = await t.mutation(internal.directThreads.release, { taskId, workerId: "w1", reason: "idle" });
    expect(r2.status).toBe("queued");
  });
});

describe("directApprovalPolicy", () => {
  test("rules: code writes always ask; auto_edits allows edits inside the worktree only", () => {
    const edit = (paths: string[], extra: object = {}) => ({ acpKind: "edit", title: "Edit", paths, workspaceRoot: "/ws/p", ...extra });
    expect(directApprovalPolicy({ mode: "auto_edits", request: edit(["/ws/p/a.ts"]) }).action).toBe("auto");
    expect(directApprovalPolicy({ mode: "auto_edits", request: edit(["/etc/passwd"]) }).action).toBe("ask");
    expect(directApprovalPolicy({ mode: "full_access", request: edit(["/ws/p/.husky/pre-commit"], { codeWrite: true }) }).action).toBe("ask");
    expect(directApprovalPolicy({ mode: "supervised", request: edit(["/ws/p/a.ts"], { ruleKey: "acp:edit" }), allowRules: ["acp:edit"] }).action).toBe("auto");
    // Push never automatic, not even with a matching thread rule.
    const push = { acpKind: "execute", title: "git push", argv: ["git", "push"], ruleKey: "r" };
    expect(directApprovalPolicy({ mode: "full_access", request: push, allowRules: ["r"] }).action).toBe("ask");
    expect(directApprovalPolicy({ mode: "full_access", request: push }).offerAlways).toBe(false);
  });
});
