import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpEngine } from "@/direct/acpSession";
import { ApiLoopEngine } from "@/direct/apiLoopSession";
import { ThreadRunner, type DirectStatePatch, type DirectStore, type StoredEvent } from "@/direct/threadRunner";
import type { DirectEngine, SessionSink, StartSessionOptions } from "@/direct/types";
import { silentLogger } from "@/vendor/threadbear/acp/connection";
import { opencodeConfig, opencodeEnv } from "@/vendor/threadbear/acp/agents";
import { BudgetExhaustedError } from "@/utils/budgetError";

const FAKE = path.resolve(import.meta.dirname, "fakeAcpAgent.mjs");

type Row = { seq: number; type: string; payload: Record<string, unknown>; eventKey?: string };

/** In-memory stand-in for directThreads.ts: gapless seqs, eventKey dedupe, approval rows. */
class MemoryStore implements DirectStore {
  events: Row[] = [];
  state: DirectStatePatch = {};
  streams = new Map<string, string>();
  approvals = new Map<string, { status: string; decidedBy?: string; itemId: string; kind: string }>();
  usage: Array<{ inputTokens: number; outputTokens: number }> = [];
  mode: "ask" | "full" = "ask";
  private n = 0;

  userMessage(text: string): { seq: number; text: string } {
    const seq = this.events.length + 1;
    this.events.push({ seq, type: "user.message", payload: { text } });
    return { seq, text };
  }
  async appendEvents(events: StoredEvent[], state?: DirectStatePatch): Promise<number[]> {
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
      const itemId = e.payload.itemId as string | undefined;
      if (itemId) this.streams.delete(itemId);
    }
    if (state) this.state = { ...this.state, ...state };
    return seqs;
  }
  async flushStream(_seq: number, items: { itemId: string; text: string }[]) {
    for (const i of items) this.streams.set(i.itemId, i.text);
  }
  async clearStreams() {
    this.streams.clear();
  }
  async requestApproval(input: { itemId: string; request: { acpKind: string } }) {
    const approvalId = `ap${++this.n}`;
    const kind = input.request.acpKind === "execute" ? "run_command" : "tool_call";
    if (this.mode === "full") {
      this.approvals.set(approvalId, { status: "approved", decidedBy: "auto", itemId: input.itemId, kind });
      return { status: "auto" as const, approvalId, reason: "Full access" };
    }
    this.approvals.set(approvalId, { status: "pending", itemId: input.itemId, kind });
    return { status: "pending" as const, approvalId, reason: "Supervised" };
  }
  async approvalState(approvalId: string) {
    const row = this.approvals.get(approvalId);
    return row ? { status: row.status, decision: null, note: null, taskStatus: "running" } : null;
  }
  async cancelApproval(approvalId: string) {
    const row = this.approvals.get(approvalId);
    if (row && row.status === "pending") row.status = "cancelled";
  }
  async loadEvents() {
    return this.events.map((e) => ({ type: e.type, sequence: e.seq, payload: e.payload }));
  }
  async recordUsage(u: { inputTokens: number; outputTokens: number }) {
    this.usage.push(u);
  }
  types(): string[] {
    return this.events.map((e) => e.type);
  }
}

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fhara-direct-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function acp(cwd: string, env: Record<string, string> = {}) {
  return new AcpEngine({ binary: process.execPath, args: [FAKE], env: { ...process.env, ...env }, log: silentLogger, workspaceRoot: cwd });
}

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("direct thread runner over a fake ACP agent", () => {
  const runners: ThreadRunner[] = [];
  afterEach(async () => {
    for (const r of runners.splice(0)) await r.close("test end");
  });
  const make = (store: MemoryStore, cwd: string, extra: Partial<ConstructorParameters<typeof ThreadRunner>[0]> = {}) => {
    const r = new ThreadRunner({ taskId: "t1", cwd, engine: acp(cwd), store, approvalPollMs: 20, streamFlushMs: 20, ...extra });
    runners.push(r);
    return r;
  };

  it("two turns persist user.message → turn.started → tool.call → edit.diff → tool.result → assistant.text → turn.completed with gapless seqs", async () => {
    const cwd = tmp();
    const store = new MemoryStore();
    store.mode = "full";
    const runner = make(store, cwd);
    await runner.deliver(store.userMessage("edit a.txt"));
    await runner.idle();
    await runner.drain();
    await runner.deliver(store.userMessage("hello again"));
    await runner.idle();
    await runner.drain();
    const types = store.types();
    expect(types.slice(0, 7)).toEqual(["user.message", "turn.started", "tool.call", "edit.diff", "tool.result", "assistant.text", "turn.completed"]);
    expect(types.slice(7)).toEqual(["user.message", "turn.started", "reasoning", "assistant.text", "turn.completed"]);
    expect(store.events.map((e) => e.seq)).toEqual(store.events.map((_, i) => i + 1));
    expect(fs.readFileSync(path.join(cwd, "a.txt"), "utf8")).toBe("hi\n");
    const diff = store.events.find((e) => e.type === "edit.diff")!;
    expect(diff.payload.path).toBe(path.join(cwd, "a.txt"));
    expect((diff.payload.hunks as unknown[]).length).toBe(1);
    // Full access is still a recorded row (rule 5).
    expect([...store.approvals.values()]).toEqual([expect.objectContaining({ status: "approved", decidedBy: "auto", kind: "tool_call" })]);
    const done = store.events.filter((e) => e.type === "turn.completed");
    expect(done.map((e) => e.payload.outcome)).toEqual(["completed", "completed"]);
    expect(done[0].payload.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(store.usage).toHaveLength(2);
    // The second turn resumed the same session (one session id recorded).
    expect(store.state.sessionId).toMatch(/^ses_fake_/);
    // The preamble was said once, on the first prompt only.
    const echo = store.events.filter((e) => e.type === "assistant.text").pop()!;
    expect(String(echo.payload.text)).toBe("Echo: hello again");
  });

  it("a steer during a turn joins the same turnId and the turn ends after both are answered", async () => {
    const cwd = tmp();
    const store = new MemoryStore();
    const runner = make(store, cwd);
    await runner.deliver(store.userMessage("slow"));
    const turnId = runner.currentTurnId;
    await runner.deliver(store.userMessage("and this"));
    await runner.idle();
    await runner.drain();
    const steered = store.events.find((e) => e.type === "turn.steered")!;
    expect(steered.payload.turnId).toBe(turnId);
    const started = store.events.filter((e) => e.type === "turn.started");
    const done = store.events.filter((e) => e.type === "turn.completed");
    expect(started).toHaveLength(1);
    expect(done).toHaveLength(1);
    expect(done[0].payload).toMatchObject({ turnId, outcome: "completed", answered: [1, 3] });
    const texts = store.events.filter((e) => e.type === "assistant.text").map((e) => String(e.payload.text));
    expect(texts[0]).toBe("slow done");
    expect(texts[1]).toBe("Echo: and this");
    expect(done[0].seq).toBe(store.events.length);
  });

  it("ask mode: a permission request makes a pending card and blocks until answered", async () => {
    const cwd = tmp();
    const store = new MemoryStore();
    const runner = make(store, cwd);
    await runner.deliver(store.userMessage("edit b.txt"));
    await waitFor(() => store.approvals.size === 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(store.types()).not.toContain("tool.result");
    expect(fs.existsSync(path.join(cwd, "b.txt"))).toBe(false);
    expect(store.state.status).toBe("waiting");
    const [id, row] = [...store.approvals.entries()][0];
    expect(row.status).toBe("pending");
    store.approvals.set(id, { ...row, status: "approved" });
    await runner.idle();
    await runner.drain();
    expect(fs.readFileSync(path.join(cwd, "b.txt"), "utf8")).toBe("hi\n");
    expect(store.events.find((e) => e.type === "tool.result")?.payload.ok).toBe(true);
  });

  it("a denied card answers reject_once and the agent goes on", async () => {
    const cwd = tmp();
    const store = new MemoryStore();
    const runner = make(store, cwd);
    await runner.deliver(store.userMessage("run npm test"));
    await waitFor(() => store.approvals.size === 1);
    const [id, row] = [...store.approvals.entries()][0];
    store.approvals.set(id, { ...row, status: "rejected" });
    await runner.idle();
    await runner.drain();
    expect(store.events.find((e) => e.type === "tool.result")?.payload.ok).toBe(false);
    expect(store.events.filter((e) => e.type === "turn.completed")[0].payload.outcome).toBe("completed");
  });

  it("interrupt ends the turn as interrupted when the agent honours session/cancel, and expires the open card", async () => {
    const cwd = tmp();
    const store = new MemoryStore();
    const runner = make(store, cwd);
    await runner.deliver(store.userMessage("wait-cancel"));
    await new Promise((r) => setTimeout(r, 200));
    await runner.interrupt();
    await runner.idle();
    await runner.drain();
    expect(store.events.filter((e) => e.type === "turn.completed")[0].payload.outcome).toBe("interrupted");
  });

  it("interrupt → interrupted within the grace even if the agent ignores session/cancel; later output is dropped", async () => {
    const cwd = tmp();
    const store = new MemoryStore();
    const runner = make(store, cwd, { interruptGraceMs: 300 });
    await runner.deliver(store.userMessage("hang"));
    await new Promise((r) => setTimeout(r, 200));
    const gen = runner.liveGeneration;
    const started = Date.now();
    await runner.interrupt();
    await runner.idle();
    await runner.drain();
    expect(Date.now() - started).toBeLessThan(10_000);
    const done = store.events.filter((e) => e.type === "turn.completed");
    expect(done).toHaveLength(1);
    expect(done[0].payload).toMatchObject({ outcome: "interrupted" });
    expect(runner.liveGeneration).toBeGreaterThan(gen);
    // A new message starts a fresh session and works.
    await runner.deliver(store.userMessage("after"));
    await runner.idle();
    await runner.drain();
    expect(store.events.filter((e) => e.type === "turn.completed").pop()?.payload.outcome).toBe("completed");
  });

  it("a session that can't be resumed is retried once, fresh, with a handoff note", async () => {
    const cwd = tmp();
    const store = new MemoryStore();
    store.userMessage("an earlier question");
    await store.appendEvents([{ type: "assistant.text", payload: { itemId: "old", text: "an earlier answer" } }]);
    const runner = make(store, cwd, { sessionId: "ses_gone", preamble: "ROLE PREAMBLE" });
    await runner.deliver(store.userMessage("continue please"));
    await runner.idle();
    await runner.drain();
    const echo = String(store.events.filter((e) => e.type === "assistant.text").pop()!.payload.text);
    expect(echo).toContain("ROLE PREAMBLE");
    expect(echo).toContain("User: an earlier question");
    expect(echo).toContain("Assistant: an earlier answer");
    expect(echo).not.toContain("User: continue please");
    expect(echo.trim().endsWith("continue please")).toBe(true);
    expect(store.events.filter((e) => e.type === "turn.completed").pop()?.payload.outcome).toBe("completed");
    expect(store.types()).toContain("system.note");
  });

  it("the budget gate refuses a prompt over budget before any process is spawned", async () => {
    const cwd = tmp();
    const store = new MemoryStore();
    let starts = 0;
    const engine: DirectEngine = {
      name: "opencode-acp",
      start(o: StartSessionOptions, s: SessionSink) {
        starts++;
        return acp(cwd).start(o, s);
      },
    };
    const runner = new ThreadRunner({
      taskId: "t1",
      cwd,
      engine,
      store,
      budgetGate: () => {
        throw new BudgetExhaustedError("token budget spent (2000000/2000000)" as never);
      },
    });
    runners.push(runner);
    await runner.deliver(store.userMessage("hello"));
    await runner.drain();
    expect(starts).toBe(0);
    const done = store.events.find((e) => e.type === "turn.completed")!;
    expect(done.payload.outcome).toBe("failed");
    expect(String(done.payload.error)).toMatch(/Budget/);
  });
});

describe("generation guard", () => {
  it("output from a replaced engine session is dropped", async () => {
    const store = new MemoryStore();
    const sinks: SessionSink[] = [];
    const engine: DirectEngine = {
      name: "opencode-acp",
      start(_o, sink) {
        sinks.push(sink);
        return { send() {}, async interrupt() {}, async end() {}, kill() {} };
      },
    };
    const runner = new ThreadRunner({ taskId: "t1", cwd: "/tmp", engine, store, interruptGraceMs: 30 });
    await runner.deliver(store.userMessage("one"));
    await runner.interrupt(); // the fake never ends the turn: grace kills it
    await runner.idle();
    await runner.deliver(store.userMessage("two"));
    expect(sinks).toHaveLength(2);
    const before = store.events.length;
    sinks[0].output({ kind: "event", event: { type: "assistant.text", itemId: "stale", text: "from the dead engine" } });
    sinks[0].output({ kind: "result", result: { outcome: "completed", durationMs: 1, queuedTurns: 0 } });
    await runner.drain();
    expect(store.events.length).toBe(before);
    sinks[1].output({ kind: "event", event: { type: "assistant.text", itemId: "live", text: "fresh" } });
    sinks[1].output({ kind: "result", result: { outcome: "completed", durationMs: 1, queuedTurns: 0 } });
    await runner.idle();
    await runner.drain();
    expect(store.events.some((e) => e.payload.itemId === "stale")).toBe(false);
    expect(store.events.some((e) => e.payload.itemId === "live")).toBe(true);
    await runner.close();
  });

  it("deltas go to hot stream rows, and the persisted item replaces its row", async () => {
    const store = new MemoryStore();
    const sinks: SessionSink[] = [];
    const engine: DirectEngine = {
      name: "opencode-acp",
      start(_o, sink) {
        sinks.push(sink);
        return { send() {}, async interrupt() {}, async end() {}, kill() {} };
      },
    };
    const runner = new ThreadRunner({ taskId: "t1", cwd: "/tmp", engine, store, streamFlushMs: 20 });
    await runner.deliver(store.userMessage("go"));
    sinks[0].output({ kind: "delta", delta: { type: "assistant.text.delta", itemId: "a", text: "Hel" } });
    sinks[0].output({ kind: "delta", delta: { type: "assistant.text.delta", itemId: "a", text: "lo" } });
    await waitFor(() => store.streams.get("a") === "Hello");
    sinks[0].output({ kind: "event", event: { type: "assistant.text", itemId: "a", text: "Hello" } });
    sinks[0].output({ kind: "result", result: { outcome: "completed", durationMs: 1, queuedTurns: 0 } });
    await runner.idle();
    await runner.drain();
    expect(store.streams.size).toBe(0);
    await runner.close();
  });
});

describe("api-loop fallback engine", () => {
  it("runs a turn through the same state machine with the role's model", async () => {
    const store = new MemoryStore();
    const engine = new ApiLoopEngine({
      model: "m1",
      provider: {
        async complete() {
          return { content: "unused" };
        },
        async stream(messages, onChunk) {
          onChunk("Hi ");
          onChunk("there");
          return { content: `Hi there (${messages.length} msgs)`, inputTokens: 5, outputTokens: 2 };
        },
      },
    });
    const runner = new ThreadRunner({ taskId: "t1", cwd: "/tmp", engine, store, preamble: "You are the backend." });
    await runner.deliver(store.userMessage("hello"));
    await runner.idle();
    await runner.drain();
    expect(store.types()).toEqual(["user.message", "turn.started", "assistant.text", "turn.completed"]);
    expect(store.events[2].payload.text).toBe("Hi there (2 msgs)");
    expect(store.events[3].payload).toMatchObject({ outcome: "completed", usage: { inputTokens: 5, outputTokens: 2, model: "m1" } });
    await runner.close();
  });
});

describe("opencode env for ACP", () => {
  it("disables the project's config, asks for everything on every agent, never passes --auto, and keeps loopback off the proxy", () => {
    const env = opencodeEnv({ base: { provider: { fhara: {} }, model: "fhara/m" }, source: { NO_PROXY: "corp.example" } });
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    expect(env.NO_PROXY).toBe("corp.example,127.0.0.1,localhost,::1");
    const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.permission["*"]).toBe("ask");
    expect(cfg.permission.bash["git push*"]).toBe("deny");
    for (const agent of ["build", "plan", "general", "explore"]) expect(cfg.agent[agent].permission["*"]).toBe("ask");
    expect(cfg.model).toBe("fhara/m");
    expect(opencodeConfig({ noTools: true }).permission).toEqual({ "*": "deny" });
  });

  it("turns off OpenCode's own skill discovery and denies the skill tool on every agent (skills S1)", () => {
    const env = opencodeEnv({ source: {} });
    expect(env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("1");
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE).toBe("1");
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS).toBe("1");
    const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.permission.skill).toBe("deny");
    for (const agent of ["build", "plan", "general", "explore"]) expect(cfg.agent[agent].permission.skill).toBe("deny");
  });
});
