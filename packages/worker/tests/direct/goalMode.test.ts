// D8: goal mode for direct threads, over a scripted fake agent (no process).
import { afterEach, describe, expect, it } from "vitest";
import { applyGoalPatch, type DirectGoal } from "@/api/convex/lib/directGoalSchema";
import { mergeGoal, nextGoalStep, parseGoalMarker, roundOutcome } from "@/direct/goal";
import { ThreadRunner, type DirectStatePatch, type DirectStore, type StoredEvent } from "@/direct/threadRunner";
import type { DirectEngine, DirectSession, SessionSink, UserInput } from "@/direct/types";

type Row = { seq: number; type: string; payload: Record<string, unknown>; eventKey?: string };
type Reply = { text?: string; tool?: boolean; hang?: boolean };

/** The store, with the goal kept the way directThreads.appendEvents keeps it. */
class MemoryStore implements DirectStore {
  events: Row[] = [];
  state: DirectStatePatch = {};
  goal: DirectGoal | undefined;
  approvals = 0;
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
    if (state?.goal) this.goal = applyGoalPatch(this.goal, state.goal, Date.now());
    if (state) this.state = { ...this.state, ...state };
    return seqs;
  }
  async flushStream() {}
  async clearStreams() {}
  async requestApproval() {
    this.approvals++;
    return { status: "auto" as const, approvalId: `ap${this.approvals}`, reason: "Full access" };
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
    return this.events.filter((e) => e.type === type).map((e) => e.payload);
  }
}

/** One prompt at a time; a prompt sent mid-turn is a steer answered in the same turn (queuedTurns). */
class FakeAgent implements DirectEngine {
  readonly name = "opencode-acp" as const;
  prompts: string[] = [];
  toolAnswers: { prompt: string; decision: string }[] = [];
  constructor(private readonly reply: (prompt: string, n: number) => Reply) {}
  start(_opts: unknown, sink: SessionSink): DirectSession {
    const queue: UserInput[] = [];
    let busy = false;
    let hanging = false;
    let n = 0;
    const run = (input: UserInput) => {
      busy = true;
      const i = ++n;
      setTimeout(async () => {
        const r = this.reply(input.text, i);
        if (r.hang) return void (hanging = true);
        if (r.tool) {
          const ans = await sink.requestApproval({
            itemId: `tool${i}`,
            description: { request: { acpKind: "edit", title: "write a.txt" }, input: "{}" },
            signal: new AbortController().signal,
          } as never);
          this.toolAnswers.push({ prompt: input.text, decision: ans.decision });
        }
        sink.output({ kind: "event", event: { type: "assistant.text", itemId: `m${i}`, text: r.text ?? "ok" } });
        const pending = queue.length;
        sink.output({ kind: "result", result: { outcome: "completed", durationMs: 1, queuedTurns: pending } });
        if (pending) run(queue.shift()!);
        else busy = false;
      }, 15);
    };
    return {
      send: (input) => {
        this.prompts.push(input.text);
        if (busy) queue.push(input);
        else run(input);
      },
      interrupt: async () => {
        if (!hanging) return;
        hanging = false;
        busy = false;
        sink.output({ kind: "result", result: { outcome: "interrupted", durationMs: 1, queuedTurns: 0 } });
      },
      end: async () => undefined,
      kill: () => undefined,
    };
  }
}

const goal = (maxRounds: number, extra: Partial<DirectGoal> = {}): DirectGoal => ({
  id: "g1",
  objective: "make the tests pass",
  maxRounds,
  round: 0,
  phase: "active",
  rev: 1,
  setAt: 1,
  updatedAt: 1,
  ...extra,
});

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const isRound = (p: string) => p.startsWith("<goal_round>");
const isWrapup = (p: string) => p.startsWith("<goal_complete>") || p.startsWith("<goal_blocked>");

describe("goal mode in the direct runner (fake agent)", () => {
  const runners: ThreadRunner[] = [];
  afterEach(async () => {
    for (const r of runners.splice(0)) await r.close("test end");
  });
  const make = (store: MemoryStore, agent: FakeAgent, extra: Partial<ConstructorParameters<typeof ThreadRunner>[0]> = {}) => {
    const r = new ThreadRunner({ taskId: "t1", cwd: "/tmp", engine: agent, store, streamFlushMs: 5, ...extra });
    runners.push(r);
    return r;
  };
  const start = (store: MemoryStore, runner: ThreadRunner, g: DirectGoal, held = false) => {
    store.goal = g;
    runner.setGoalState(g, held);
  };

  it("3 rounds, then GOAL: complete → one wrap-up turn whose tool request is refused → idle", async () => {
    const store = new MemoryStore();
    const agent = new FakeAgent((p, n) =>
      isWrapup(p) ? { text: "All done: tests pass.", tool: true } : n === 3 ? { text: "Verified.\nGOAL: complete" } : { text: `round ${n}: more to do` }
    );
    const runner = make(store, agent);
    start(store, runner, goal(10));
    await waitFor(() => store.goal?.wrappedUp === true && !runner.busy);
    expect(agent.prompts.map((p) => (isRound(p) ? "round" : isWrapup(p) ? "wrapup" : "other"))).toEqual(["round", "round", "round", "wrapup"]);
    expect(agent.prompts[0]).toContain("Round: 1/10");
    expect(agent.prompts[2]).toContain("Round: 3/10");
    expect(agent.prompts[3]).toMatch(/^<goal_complete>/);
    expect(store.goal).toMatchObject({ phase: "complete", round: 3, wrappedUp: true });
    // The wrap-up asked for a tool: refused in-process, no approval row.
    expect(agent.toolAnswers).toEqual([{ prompt: agent.prompts[3], decision: "deny" }]);
    expect(store.approvals).toBe(0);
    expect(store.of("turn.completed")).toHaveLength(4);
    expect(store.of("turn.started").map((p) => p.goal)).toEqual(["round", "round", "round", "wrapup"]);
    // Goal prompts never move deliveredSeq (that is for user messages).
    expect(store.state.deliveredSeq).toBeUndefined();
    await new Promise((r) => setTimeout(r, 60));
    expect(agent.prompts).toHaveLength(4); // idle: nothing more
    runner.setGoalState(store.goal!, false);
    await new Promise((r) => setTimeout(r, 60));
    expect(agent.prompts).toHaveLength(4);
  });

  it("running out of rounds blocks the goal with round-limit, then wraps up", async () => {
    const store = new MemoryStore();
    const agent = new FakeAgent(() => ({ text: "still going" }));
    const runner = make(store, agent);
    start(store, runner, goal(2));
    await waitFor(() => store.goal?.wrappedUp === true && !runner.busy);
    expect(agent.prompts.filter(isRound)).toHaveLength(2);
    expect(store.goal).toMatchObject({ phase: "blocked", round: 2, blockedReason: { code: "round-limit" } });
    expect(agent.prompts[2]).toMatch(/^<goal_blocked>/);
    expect(store.of("goal.updated").map((p) => p.action)).toEqual(["round", "round", "blocked", "wrapped-up"]);
  });

  it("a user message mid-round is a steer in the same turn, not a new round", async () => {
    const store = new MemoryStore();
    const agent = new FakeAgent((p, n) => (isWrapup(p) ? { text: "bye" } : n === 2 ? { text: "noted\nGOAL: complete" } : { text: "working" }));
    const runner = make(store, agent);
    start(store, runner, goal(5));
    await waitFor(() => store.of("turn.started").length === 1);
    await runner.deliver(store.userMessage("also update the README"));
    await waitFor(() => store.goal?.wrappedUp === true && !runner.busy);
    expect(store.of("turn.steered")).toHaveLength(1);
    expect(agent.prompts.filter(isRound)).toHaveLength(1);
    expect(agent.prompts[1]).toBe("also update the README");
    expect(store.goal).toMatchObject({ phase: "complete", round: 1 });
    expect(store.of("turn.started")).toHaveLength(2); // the round (with its steer) and the wrap-up
  });

  it("the G3 hold starts no round; lifting it goes on", async () => {
    const store = new MemoryStore();
    const agent = new FakeAgent((p) => (isWrapup(p) ? { text: "bye" } : { text: "GOAL: complete" }));
    const runner = make(store, agent);
    start(store, runner, goal(3), true);
    await new Promise((r) => setTimeout(r, 80));
    runner.setGoalState(store.goal!, true);
    expect(agent.prompts).toEqual([]);
    expect(store.of("system.note").map((p) => p.text)).toEqual([expect.stringMatching(/automation is held/)]); // said once
    runner.setGoalState(store.goal!, false);
    await waitFor(() => store.goal?.wrappedUp === true && !runner.busy);
    expect(agent.prompts.filter(isRound)).toHaveLength(1);
  });

  it("an N3 watchdog timeout blocks the goal, with no wrap-up turn", async () => {
    const store = new MemoryStore();
    const agent = new FakeAgent((_p, n) => (n === 2 ? { hang: true } : { text: "progress" }));
    const runner = make(store, agent, { watchdog: { inactivityMs: 120, progressMs: 2000 }, interruptGraceMs: 2000 });
    start(store, runner, goal(5));
    await waitFor(() => store.goal?.phase === "blocked" && !runner.busy);
    expect(store.goal).toMatchObject({ round: 2, wrappedUp: true, blockedReason: { code: "timeout" } });
    expect(store.goal?.blockedReason?.message).toMatch(/sent nothing/);
    expect(store.of("turn.completed").map((p) => p.outcome)).toEqual(["completed", "timed_out"]);
    await new Promise((r) => setTimeout(r, 60));
    expect(agent.prompts.filter(isWrapup)).toHaveLength(0);
  });

  it("Stop during a round pauses the goal", async () => {
    const store = new MemoryStore();
    const agent = new FakeAgent(() => ({ hang: true }));
    const runner = make(store, agent);
    start(store, runner, goal(5));
    await waitFor(() => store.of("turn.started").length === 1);
    await new Promise((r) => setTimeout(r, 40));
    await runner.interrupt();
    await waitFor(() => store.goal?.phase === "paused" && !runner.busy);
    expect(agent.prompts).toHaveLength(1);
  });
});

describe("goal helpers", () => {
  it("parses the marker on the last non-empty line only", () => {
    expect(parseGoalMarker("done\nGOAL: complete\n\n")).toEqual({ kind: "complete" });
    expect(parseGoalMarker("**GOAL: blocked: need the API key**")).toEqual({ kind: "blocked", reason: "need the API key" });
    expect(parseGoalMarker("GOAL: complete\nbut wait, one more thing")).toBeNull();
    expect(parseGoalMarker("the goal: complete soon")).toBeNull();
  });
  it("roundOutcome: timeout and failure block without wrap-up; no marker leaves it active", () => {
    expect(roundOutcome("timed_out", "slow", undefined)?.patch).toMatchObject({ phase: "blocked", wrappedUp: true, blockedReason: { code: "timeout" } });
    expect(roundOutcome("completed", undefined, "working")).toBeNull();
  });
  it("mergeGoal keeps this worker's rounds and terminal report against a stale poll; a user change wins", () => {
    const local = goal(5, { round: 3, phase: "complete" });
    expect(mergeGoal(local, goal(5, { round: 2 }))).toMatchObject({ round: 3, phase: "complete" });
    expect(mergeGoal(goal(5, { round: 2 }), goal(5, { round: 2, phase: "paused", rev: 2 }))?.phase).toBe("paused");
    expect(mergeGoal(local, null)).toBeNull();
    expect(nextGoalStep(goal(2, { round: 2 }), false)).toBe("round-limit");
    expect(nextGoalStep(goal(2), true)).toBe("held");
  });
});
