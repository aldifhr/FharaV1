// Nuphos N4: session restore diagnostics, transient vs permanent wording,
// and live-session admission at DIRECT_MAX_LIVE.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpEngine } from "@/direct/acpSession";
import { DirectThreads, pickEvictable, type DirectThreadsDeps } from "@/direct/index";
import { PERMANENT_RESTORE_NOTE, TRANSIENT_RESTORE_NOTE, isTransientRestoreError } from "@/direct/restore";
import { ThreadRunner, type DirectStatePatch, type DirectStore, type StoredEvent } from "@/direct/threadRunner";
import type { DirectEngine, StartSessionOptions } from "@/direct/types";
import { AcpExitedError, silentLogger } from "@/vendor/threadbear/acp/connection";

const FAKE = path.resolve(import.meta.dirname, "fakeAcpAgent.mjs");

type Row = { seq: number; type: string; payload: Record<string, unknown>; eventKey?: string };

class Store implements DirectStore {
  events: Row[] = [];
  state: DirectStatePatch = {};
  patches: DirectStatePatch[] = [];
  userMessage(text: string) {
    const seq = this.events.length + 1;
    this.events.push({ seq, type: "user.message", payload: { text } });
    return { seq, text };
  }
  async appendEvents(events: StoredEvent[], state?: DirectStatePatch) {
    const seqs: number[] = [];
    for (const e of events) {
      const dup = e.eventKey ? this.events.find((r) => r.eventKey === e.eventKey) : undefined;
      if (dup) {
        seqs.push(dup.seq);
        continue;
      }
      const seq = this.events.length + 1;
      this.events.push({ seq, type: e.type, payload: e.payload, eventKey: e.eventKey });
      seqs.push(seq);
    }
    if (state) {
      this.patches.push(state);
      this.state = { ...this.state, ...state };
    }
    return seqs;
  }
  async flushStream() {}
  async clearStreams() {}
  async requestApproval() {
    return { status: "auto" as const, approvalId: "a1", reason: "Full access" };
  }
  async approvalState() {
    return null;
  }
  async cancelApproval() {}
  async loadEvents() {
    return this.events.map((e) => ({ type: e.type, sequence: e.seq, payload: e.payload }));
  }
  async recordUsage() {}
  of(type: string) {
    return this.events.filter((e) => e.type === type);
  }
}

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fhara-restore-"));
  tmpDirs.push(dir);
  return dir;
}
const runners: ThreadRunner[] = [];
afterEach(async () => {
  for (const r of runners.splice(0)) await r.close("test end");
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** The fake ACP agent, with every session start's options recorded. */
function engine(cwd: string, env: Record<string, string> = {}) {
  const inner = new AcpEngine({
    binary: process.execPath,
    args: [FAKE],
    env: { ...process.env, ...env },
    log: silentLogger,
    workspaceRoot: cwd,
    timings: { sessionMs: 300 },
  });
  const starts: StartSessionOptions[] = [];
  const e: DirectEngine = { name: inner.name, start: (o, s) => (starts.push(o), inner.start(o, s)) };
  return { engine: e, starts };
}

describe("session restore (Nuphos N4)", () => {
  it("a resume timeout keeps the sessionId, says it will retry, and the next message resumes the same session", async () => {
    const cwd = tmp();
    const hang = path.join(cwd, "hang");
    fs.writeFileSync(hang, "");
    const store = new Store();
    const { engine: eng, starts } = engine(cwd, { FAKE_ACP_RESUME_HANG: hang });
    const runner = new ThreadRunner({ taskId: "t1", cwd, engine: eng, store, sessionId: "ses_known", streamFlushMs: 20 });
    runners.push(runner);

    await runner.deliver(store.userMessage("hello"));
    await runner.idle();
    await runner.drain();

    const note = store.of("system.note").map((e) => String(e.payload.text));
    expect(note).toContain(TRANSIENT_RESTORE_NOTE);
    expect(TRANSIENT_RESTORE_NOTE).toMatch(/kept.*next message will try it again/);
    expect(note).not.toContain(PERMANENT_RESTORE_NOTE);
    expect(store.of("turn.completed").pop()?.payload.outcome).toBe("failed");
    // Never cleared.
    expect(store.patches.some((p) => p.sessionId === null)).toBe(false);

    const [first] = store.of("session.restore");
    expect(first.payload).toMatchObject({ op: "resume", outcome: "failed", failure: "transient" });
    const phases = first.payload.phases as Array<{ name: string; ok: boolean; elapsedMs: number }>;
    expect(phases.map((p) => [p.name, p.ok])).toEqual([
      ["initialize", true],
      ["identify", true],
      ["open", false],
    ]);
    expect(phases.every((p) => p.elapsedMs >= 0)).toBe(true);
    expect(typeof first.payload.pid).toBe("number");
    // Phases only: no prompt, no agent text, no error message.
    expect(Object.keys(first.payload).sort()).toEqual(["attemptId", "durationMs", "failure", "op", "outcome", "phases", "pid", "startedAt"]);
    expect(JSON.stringify(first.payload)).not.toContain("hello");

    fs.rmSync(hang);
    await runner.deliver(store.userMessage("again"));
    await runner.idle();
    await runner.drain();
    expect(starts.map((s) => s.sessionId)).toEqual(["ses_known", "ses_known"]);
    expect(store.of("turn.completed").pop()?.payload.outcome).toBe("completed");
    const second = store.of("session.restore").pop()!;
    expect(second.payload).toMatchObject({ op: "resume", outcome: "completed" });
    expect((second.payload.phases as Array<{ name: string }>).map((p) => p.name)).toEqual(["initialize", "identify", "open", "ready"]);
    expect(second.payload.failure).toBeUndefined();
  }, 20_000);

  it("not-found is permanent: the id is dropped, a fresh session carries on with a handoff, both attempts are recorded", async () => {
    const cwd = tmp();
    const store = new Store();
    const { engine: eng, starts } = engine(cwd);
    const runner = new ThreadRunner({ taskId: "t2", cwd, engine: eng, store, sessionId: "ses_gone", preamble: "ROLE", streamFlushMs: 20 });
    runners.push(runner);

    await runner.deliver(store.userMessage("continue please"));
    await runner.idle();
    await runner.drain();

    expect(store.of("system.note").map((e) => String(e.payload.text))).toContain(PERMANENT_RESTORE_NOTE);
    expect(store.of("system.note").map((e) => String(e.payload.text))).not.toContain(TRANSIENT_RESTORE_NOTE);
    expect(store.patches.some((p) => p.sessionId === null)).toBe(true);
    expect(starts.map((s) => s.sessionId)).toEqual(["ses_gone", undefined]);
    expect(starts[1].preamble).toContain("ROLE");
    expect(store.of("turn.completed").pop()?.payload.outcome).toBe("completed");
    const rows = store.of("session.restore").map((e) => e.payload);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ op: "resume", outcome: "failed", failure: "not_found" });
    expect(rows[1]).toMatchObject({ op: "new", outcome: "completed" });
  }, 20_000);

  it("classifies timeouts and a lost agent as transient, anything else as not", () => {
    expect(isTransientRestoreError(new Error("The agent didn't answer session/resume within 90 s"))).toBe(true);
    expect(isTransientRestoreError(new AcpExitedError("The agent is not running."))).toBe(true);
    expect(isTransientRestoreError(new Error("timeout waiting for session/load"))).toBe(true);
    expect(isTransientRestoreError(new Error("Session not found: ses_x"))).toBe(false);
    expect(isTransientRestoreError(new Error("invalid params"))).toBe(false);
  });
});

describe("live-session admission at DIRECT_MAX_LIVE (Nuphos N4)", () => {
  it("pickEvictable takes the oldest idle session, never a busy or closing one", () => {
    expect(
      pickEvictable([
        { taskId: "running", lastActivity: 1, busy: true, closing: false },
        { taskId: "closing", lastActivity: 2, busy: false, closing: true },
        { taskId: "idle-new", lastActivity: 9, busy: false, closing: false },
        { taskId: "idle-old", lastActivity: 5, busy: false, closing: false },
      ])?.taskId
    ).toBe("idle-old");
    expect(pickEvictable([{ taskId: "w", lastActivity: 1, busy: true, closing: false }])).toBeUndefined();
  });

  function threads(claims: string[]) {
    const released: string[] = [];
    const claimDirectThread = vi.fn(async () => {
      const id = claims.shift();
      return id ? ({ taskId: id } as never) : null;
    });
    const api = {
      claimDirectThread,
      releaseDirectThread: vi.fn(async ({ taskId }: { taskId: string }) => {
        released.push(String(taskId));
        return { status: "waiting_input" };
      }),
    };
    const agentPids = { installExitHook() {}, sweep: async () => [], reapOwn: async () => undefined };
    const deps = {
      api,
      workerId: "w1",
      workspaceRoot: tmp(),
      policy: {},
      leaseMs: 60_000,
      log: () => undefined,
      shutdownSignal: new AbortController().signal,
      agentPids,
    } as unknown as DirectThreadsDeps;
    const dt = new DirectThreads(deps);
    const inner = dt as unknown as { live: Map<string, unknown>; start: (c: { taskId: string }) => Promise<void> };
    const closed: string[] = [];
    const add = (taskId: string, busy: boolean, lastActivity: number) =>
      inner.live.set(taskId, {
        taskId,
        runner: { busy, close: async () => void closed.push(taskId) },
        lastActivity,
        handledInterrupt: 0,
        deliveredSeq: 0,
        closing: false,
      });
    inner.start = async (c) => void add(String(c.taskId), false, Date.now());
    return { dt, add, released, closed, claimDirectThread };
  }

  it("at the cap, a new claim releases the oldest idle thread; a running or waiting one is never chosen", async () => {
    const { dt, add, released, closed } = threads(["new"]);
    // The cap is 4 (the default). The two busy ones are the oldest.
    add("running", true, 1); // a turn in flight
    add("waiting", true, 2); // a turn parked on an approval card
    add("idle-old", false, 10);
    add("idle-new", false, 20);
    expect(await dt.tick()).toBe(true);
    expect(released).toEqual(["idle-old"]);
    expect(closed).toEqual(["idle-old"]);
    expect(dt.activeTaskIds().sort()).toEqual(["idle-new", "new", "running", "waiting"]);
  });

  it("at the cap with nothing idle, no claim is made and nothing is released", async () => {
    const { dt, add, released, claimDirectThread } = threads(["new"]);
    for (const [i, id] of ["a", "b", "c", "d"].entries()) add(id, true, i);
    expect(await dt.tick()).toBe(false);
    expect(claimDirectThread).not.toHaveBeenCalled();
    expect(released).toEqual([]);
    expect(dt.size).toBe(4);
  });

  it("below the cap nothing is released", async () => {
    const { dt, add, released } = threads(["new"]);
    add("idle", false, 1);
    expect(await dt.tick()).toBe(true);
    expect(released).toEqual([]);
    expect(dt.size).toBe(2);
  });
});
