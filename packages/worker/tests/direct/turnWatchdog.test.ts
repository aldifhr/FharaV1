// Nuphos N3: the two-window turn watchdog for direct-thread ACP turns.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpEngine } from "@/direct/acpSession";
import { directWatchdog } from "@/direct";
import { ThreadRunner, type DirectStatePatch, type DirectStore, type StoredEvent, type TurnWatchdogConfig } from "@/direct/threadRunner";
import type { DirectEngine, SessionSink } from "@/direct/types";
import { silentLogger, type AcpProcessHooks } from "@/vendor/threadbear/acp/connection";
import { isTurnProgressUpdate, TurnWatchdog, type TurnTimeoutReason } from "@/vendor/nuphos/turnTimers";

const FAKE = path.resolve(import.meta.dirname, "fakeAcpAgent.mjs");

type Row = { seq: number; type: string; payload: Record<string, unknown>; eventKey?: string };

class MemoryStore implements DirectStore {
  events: Row[] = [];
  state: DirectStatePatch = {};
  approvals = new Map<string, string>();
  private n = 0;
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
    if (state) this.state = { ...this.state, ...state };
    return seqs;
  }
  async flushStream() {}
  async clearStreams() {}
  async requestApproval() {
    const approvalId = `ap${++this.n}`;
    this.approvals.set(approvalId, "pending");
    return { status: "pending" as const, approvalId, reason: "Supervised" };
  }
  async approvalState(approvalId: string) {
    const status = this.approvals.get(approvalId);
    return status ? { status, decision: null, note: null, taskStatus: "running" } : null;
  }
  async cancelApproval(approvalId: string) {
    if (this.approvals.get(approvalId) === "pending") this.approvals.set(approvalId, "cancelled");
  }
  async loadEvents() {
    return this.events.map((e) => ({ type: e.type, sequence: e.seq, payload: e.payload }));
  }
  async recordUsage() {}
  completed() {
    return this.events.filter((e) => e.type === "turn.completed").map((e) => e.payload);
  }
  notes() {
    return this.events.filter((e) => e.type === "system.note").map((e) => e.payload);
  }
}

describe("isTurnProgressUpdate (copied from Nuphos)", () => {
  it.each(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"])("%s is progress", (sessionUpdate) => {
    expect(isTurnProgressUpdate({ sessionId: "s", update: { sessionUpdate } })).toBe(true);
  });
  it.each(["usage_update", "session_info_update", "available_commands_update", "runtime_state"])("%s is liveness only", (sessionUpdate) => {
    expect(isTurnProgressUpdate({ sessionId: "s", update: { sessionUpdate } })).toBe(false);
  });
  it("rejects malformed params", () => {
    expect(isTurnProgressUpdate(undefined)).toBe(false);
    expect(isTurnProgressUpdate({ sessionId: "s" })).toBe(false);
  });
});

describe("TurnWatchdog (fake timers)", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  const make = (opts: { inactivityMs: number; progressMs: number; approvalCapMs?: number }) => {
    const fired: { reason: TurnTimeoutReason; windowMs: number }[] = [];
    const w = new TurnWatchdog(opts, (reason, windowMs) => fired.push({ reason, windowMs }));
    w.start();
    return { w, fired };
  };

  it("silence trips no_output at the inactivity window, once", () => {
    const { fired } = make({ inactivityMs: 1000, progressMs: 5000 });
    vi.advanceTimersByTime(999);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([{ reason: "no_output", windowMs: 1000 }]);
    vi.advanceTimersByTime(60_000);
    expect(fired).toHaveLength(1);
  });

  it("heartbeats keep inactivity alive but trip no_progress at the progress window", () => {
    const { w, fired } = make({ inactivityMs: 1000, progressMs: 5000 });
    for (let t = 0; t < 4500; t += 500) {
      vi.advanceTimersByTime(500);
      w.frame(false);
    }
    vi.advanceTimersByTime(499);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([{ reason: "no_progress", windowMs: 5000 }]);
  });

  it("real progress keeps the turn alive indefinitely", () => {
    const { w, fired } = make({ inactivityMs: 1000, progressMs: 5000 });
    for (let i = 0; i < 100; i++) {
      vi.advanceTimersByTime(900);
      w.frame(true);
    }
    expect(fired).toEqual([]);
    w.stop();
  });

  it("an approval wait is exempt up to the cap; resume re-arms both windows", () => {
    const { w, fired } = make({ inactivityMs: 1000, progressMs: 5000, approvalCapMs: 20_000 });
    vi.advanceTimersByTime(500);
    w.pause();
    vi.advanceTimersByTime(19_000);
    expect(fired).toEqual([]);
    w.resume();
    vi.advanceTimersByTime(999);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([{ reason: "no_output", windowMs: 1000 }]);
  });

  it("an approval wait past the cap trips, and reports it was waiting", () => {
    const { w, fired } = make({ inactivityMs: 1000, progressMs: 5000, approvalCapMs: 20_000 });
    w.pause();
    vi.advanceTimersByTime(20_000);
    expect(fired).toEqual([{ reason: "no_progress", windowMs: 20_000 }]);
    expect(w.paused).toBe(true);
  });

  it("0 turns a window off", () => {
    const off = make({ inactivityMs: 0, progressMs: 0 });
    expect(off.w.enabled).toBe(false);
    vi.advanceTimersByTime(10 ** 9);
    expect(off.fired).toEqual([]);
    const progressOnly = make({ inactivityMs: 0, progressMs: 3000 });
    vi.advanceTimersByTime(3000);
    expect(progressOnly.fired).toEqual([{ reason: "no_progress", windowMs: 3000 }]);
  });
});

describe("ThreadRunner watchdog over a scripted engine (fake timers)", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  function scripted() {
    const sinks: SessionSink[] = [];
    const calls = { interrupt: 0, kill: 0 };
    const engine: DirectEngine = {
      name: "opencode-acp",
      start(_o, sink) {
        sinks.push(sink);
        return {
          send() {},
          async interrupt() {
            calls.interrupt++;
          },
          async end() {},
          kill() {
            calls.kill++;
          },
        };
      },
    };
    return { engine, sinks, calls };
  }

  const watchdog: TurnWatchdogConfig = { inactivityMs: 60_000, progressMs: 120_000, approvalCapMs: 600_000 };

  it("silent agent: note, cancel, then kill after the grace; the turn is timed_out (no_output) and the thread carries on", async () => {
    const store = new MemoryStore();
    const { engine, sinks, calls } = scripted();
    const runner = new ThreadRunner({ taskId: "t1", cwd: "/tmp", engine, store, interruptGraceMs: 10_000, watchdog });
    await runner.deliver(store.userMessage("go"));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls.interrupt).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(store.notes()[0]).toMatchObject({ watchdog: { reason: "no_output", windowMs: 60_000 } });
    expect(String(store.notes()[0].text)).toMatch(/sent nothing for 1 min.*Send a message to continue/);
    expect(calls.interrupt).toBe(1);
    expect(calls.kill).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await runner.drain();
    expect(calls.kill).toBe(1);
    expect(store.completed()).toEqual([expect.objectContaining({ outcome: "timed_out", reason: "no_output", windowMs: 60_000 })]);
    expect(String(store.completed()[0].error)).toMatch(/Send a message to continue/);
    expect(store.state).toMatchObject({ status: "idle", turnId: null });
    expect(runner.busy).toBe(false);
    // Usable: the next message starts a new session and completes normally.
    await runner.deliver(store.userMessage("again"));
    expect(sinks).toHaveLength(2);
    sinks[1].output({ kind: "result", result: { outcome: "completed", durationMs: 1, queuedTurns: 0 } });
    await flush();
    await runner.drain();
    expect(store.completed().at(-1)).toMatchObject({ outcome: "completed" });
    await runner.close();
  });

  it("heartbeat-only agent: no_progress; an agent that honours the cancel is not killed", async () => {
    const store = new MemoryStore();
    const { engine, sinks, calls } = scripted();
    const runner = new ThreadRunner({ taskId: "t1", cwd: "/tmp", engine, store, interruptGraceMs: 10_000, watchdog });
    await runner.deliver(store.userMessage("go"));
    for (let t = 0; t < 120_000; t += 30_000) {
      await vi.advanceTimersByTimeAsync(30_000);
      sinks[0].activity?.(false);
    }
    await flush();
    expect(calls.interrupt).toBe(1);
    sinks[0].output({ kind: "result", result: { outcome: "interrupted", durationMs: 1, queuedTurns: 0 } });
    await flush();
    await runner.drain();
    expect(store.completed()).toEqual([expect.objectContaining({ outcome: "timed_out", reason: "no_progress", windowMs: 120_000 })]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls.kill).toBe(0);
    await runner.close();
  });

  it("progress frames keep a long, slow turn alive (a 5–8 min replan with frames)", async () => {
    const store = new MemoryStore();
    const { engine, sinks, calls } = scripted();
    const runner = new ThreadRunner({ taskId: "t1", cwd: "/tmp", engine, store, watchdog });
    await runner.deliver(store.userMessage("go"));
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(50_000);
      sinks[0].activity?.(true);
    }
    expect(calls.interrupt).toBe(0);
    sinks[0].output({ kind: "result", result: { outcome: "completed", durationMs: 1, queuedTurns: 0 } });
    await flush();
    await runner.drain();
    expect(store.completed()[0]).toMatchObject({ outcome: "completed" });
    await runner.close();
  });

  it("no watchdog option: a silent turn is never stopped", async () => {
    const store = new MemoryStore();
    const { engine, calls } = scripted();
    const runner = new ThreadRunner({ taskId: "t1", cwd: "/tmp", engine, store });
    await runner.deliver(store.userMessage("go"));
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(calls.interrupt).toBe(0);
    expect(runner.busy).toBe(true);
    await runner.close();
  });
});

describe("ThreadRunner watchdog over the fake ACP agent (real process, short windows)", () => {
  const runners: ThreadRunner[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const r of runners.splice(0)) await r.close("test end");
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const make = (store: MemoryStore, wd: TurnWatchdogConfig, extra: { hooks?: AcpProcessHooks; graceMs?: number } = {}) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fhara-n3-"));
    dirs.push(cwd);
    const engine = new AcpEngine({
      binary: process.execPath,
      args: [FAKE],
      env: { ...process.env, FAKE_ACP_HEARTBEAT_MS: "40" },
      log: silentLogger,
      workspaceRoot: cwd,
      ...(extra.hooks ? { processHooks: extra.hooks } : {}),
    });
    const r = new ThreadRunner({ taskId: "t1", cwd, engine, store, approvalPollMs: 20, streamFlushMs: 20, interruptGraceMs: extra.graceMs ?? 500, watchdog: wd });
    runners.push(r);
    return r;
  };
  const settle = async (r: ThreadRunner) => {
    await r.idle();
    await r.drain();
  };

  it("silent agent → no_output, cancel honoured, the next message works on the same session", async () => {
    const store = new MemoryStore();
    const r = make(store, { inactivityMs: 600, progressMs: 5000 });
    await r.deliver(store.userMessage("silent"));
    await settle(r);
    expect(store.completed()[0]).toMatchObject({ outcome: "timed_out", reason: "no_output" });
    await r.deliver(store.userMessage("hello"));
    await settle(r);
    expect(store.completed().at(-1)).toMatchObject({ outcome: "completed" });
  }, 20_000);

  it("heartbeat-only agent → no_progress (heartbeats don't count as progress)", async () => {
    const store = new MemoryStore();
    const r = make(store, { inactivityMs: 400, progressMs: 1000 });
    const started = Date.now();
    await r.deliver(store.userMessage("heartbeat"));
    await settle(r);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(store.completed()[0]).toMatchObject({ outcome: "timed_out", reason: "no_progress", windowMs: 1000 });
    expect(store.notes().some((n) => (n.watchdog as { reason?: string } | undefined)?.reason === "no_progress")).toBe(true);
  }, 20_000);

  it("an agent that ignores the cancel is killed through the pid registry hook; the thread stays usable", async () => {
    const store = new MemoryStore();
    const stopped: number[] = [];
    const hooks: AcpProcessHooks = {
      spawned() {},
      exited() {},
      async stop(pid) {
        stopped.push(pid);
        return false; // not recorded: the process signals its group itself
      },
    };
    const r = make(store, { inactivityMs: 400, progressMs: 800 }, { hooks, graceMs: 300 });
    await r.deliver(store.userMessage("heartbeat-hang"));
    await settle(r);
    expect(store.completed()[0]).toMatchObject({ outcome: "timed_out", reason: "no_progress" });
    expect(stopped).toHaveLength(1);
    await r.deliver(store.userMessage("after"));
    await settle(r);
    expect(store.completed().at(-1)).toMatchObject({ outcome: "completed" });
  }, 20_000);

  it("a turn waiting on an approval card is not timed out until the cap", async () => {
    const store = new MemoryStore();
    const r = make(store, { inactivityMs: 300, progressMs: 300, approvalCapMs: 5000 });
    await r.deliver(store.userMessage("run echo hi"));
    const until = Date.now() + 5000;
    while (store.approvals.size === 0 && Date.now() < until) await new Promise((res) => setTimeout(res, 20));
    expect(store.approvals.size).toBe(1);
    await new Promise((res) => setTimeout(res, 1200)); // 4× the windows
    expect(store.completed()).toEqual([]);
    store.approvals.set("ap1", "approved");
    await settle(r);
    expect(store.completed()[0]).toMatchObject({ outcome: "completed" });
  }, 20_000);

  it("past the cap, the approval wait times out and the card is cancelled", async () => {
    const store = new MemoryStore();
    const r = make(store, { inactivityMs: 300, progressMs: 300, approvalCapMs: 600 });
    await r.deliver(store.userMessage("run echo hi"));
    await settle(r);
    expect(store.completed()[0]).toMatchObject({ outcome: "timed_out", reason: "no_progress", windowMs: 600 });
    expect(String(store.completed()[0].error)).toMatch(/waited on an approval/);
    expect(store.approvals.get("ap1")).toBe("cancelled");
  }, 20_000);
});

describe("watchdog config (@fhara/config)", () => {
  it("defaults are generous: 20 min silence, 30 min without progress, 60 min approval exemption", () => {
    expect(directWatchdog({})).toEqual({ inactivityMs: 20 * 60_000, progressMs: 30 * 60_000, approvalCapMs: 60 * 60_000 });
  });
  it("0 turns a window off; blank keeps the default", () => {
    expect(directWatchdog({ DIRECT_INACTIVITY_MIN: "0", DIRECT_PROGRESS_MIN: "", DIRECT_WATCHDOG_APPROVAL_MIN: "0" })).toEqual({
      inactivityMs: 0,
      progressMs: 30 * 60_000,
      approvalCapMs: 0,
    });
  });
  it("the approval exemption stays above the card's own bound (Nuphos N5: the card expires first)", () => {
    // 5 < 30 + 1: raised, so a turn is never timed out while its card has time left.
    expect(directWatchdog({ DIRECT_WATCHDOG_APPROVAL_MIN: "5" }).approvalCapMs).toBe(31 * 60_000);
    expect(directWatchdog({ DIRECT_WATCHDOG_APPROVAL_MIN: "5", DIRECT_APPROVAL_MAX_MIN: "2" }).approvalCapMs).toBe(5 * 60_000);
    expect(directWatchdog({ DIRECT_WATCHDOG_APPROVAL_MIN: "90", DIRECT_APPROVAL_MAX_MIN: "120" }).approvalCapMs).toBe(121 * 60_000);
  });
});
