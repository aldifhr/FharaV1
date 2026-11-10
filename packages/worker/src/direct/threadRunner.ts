// Ported from threadbear (https://github.com/mikecann/threadbear), runner/src/runner.ts @ 43fa197.
// MIT License, Copyright (c) 2026 Mike Cann. See THIRD_PARTY_NOTICES.md.
/**
 * The direct thread turn state machine (threadbear T2, P5).
 *
 * Ported, not copied, from threadbear runner/src/runner.ts (sendTo,
 * startTurn, deliver, startSession, onOutput, completeTurn, interrupt,
 * onExited) and the ideas in docs/protocol.md, MIT License, Copyright (c)
 * 2026 Mike Cann (see THIRD_PARTY_NOTICES.md). Fhara keeps Convex as the
 * source of truth: every event goes through the store (directThreads.ts),
 * which assigns the gapless sequence.
 *
 * Rules carried over:
 * - Every engine callback checks `generation`: output from a dead or
 *   replaced engine process is dropped.
 * - A message while a turn is live is steered into the same turn
 *   (`turn.steered`), and the turn completes only once the engine has
 *   answered it too (`queuedTurns === 0`).
 * - Stop: session/cancel, open cards expire, then a 10 s grace; a turn the
 *   engine has not ended by then is failed as interrupted and the engine is
 *   killed.
 * - A session that can't be resumed is retried once, fresh, with a handoff
 *   note built from the thread's own events.
 * - Deltas are transient: coalesced per item and written to hot stream rows
 *   at most every ~300 ms; the persisted event replaces the hot row.
 * - The budget gate (rule 6) runs before every prompt, before any process
 *   is spawned for a new turn.
 */
import type { AcpOutput, NormalizedEvent } from "@/vendor/threadbear/acp/normalize";
import { handoffNote, type HandoffEvent } from "./handoff";
import type { ToolGateAnswer, ToolGateCall } from "./toolGate";
import {
  SessionNotFoundError,
  type DirectEngine,
  type DirectSession,
  type TurnResult,
  type TurnUsage,
  type UserInput,
} from "./types";

export const INTERRUPT_GRACE_MS = 10_000;
export const STREAM_FLUSH_MS = 300;
export const APPROVAL_POLL_MS = 750;

export type DirectStatePatch = {
  status?: "idle" | "starting" | "running" | "waiting" | "stopped" | "error";
  sessionId?: string | null;
  turnId?: string | null;
  engine?: "opencode-acp" | "api-loop";
  deliveredSeq?: number;
  idleSince?: number | null;
  error?: string | null;
  stoppedMidTurn?: boolean;
};

export type StoredEvent = { type: string; eventKey?: string; payload: Record<string, unknown> };

/** Everything the runner reads and writes: Convex in production, memory in tests. */
export interface DirectStore {
  appendEvents(events: StoredEvent[], state?: DirectStatePatch): Promise<number[]>;
  flushStream(seq: number, items: { itemId: string; kind: "text" | "reasoning" | "output"; text: string }[]): Promise<void>;
  clearStreams(): Promise<void>;
  requestApproval(input: {
    itemId: string;
    request: ToolGateCall["description"]["request"];
    input: string;
  }): Promise<{ status: "auto" | "pending"; approvalId: string; reason: string }>;
  approvalState(approvalId: string): Promise<{ status: string; decision: string | null; note: string | null; taskStatus: string | null } | null>;
  cancelApproval(approvalId: string, reason: string): Promise<void>;
  /** The thread's events so far (for a handoff note). */
  loadEvents(): Promise<HandoffEvent[]>;
  recordUsage(usage: TurnUsage): Promise<void>;
}

export interface ThreadRunnerOptions {
  taskId: string;
  cwd: string;
  engine: DirectEngine;
  store: DirectStore;
  /** Role persona and workspace rules, said once to a new session. */
  preamble?: string;
  model?: string;
  /** An engine session to resume (tasks.direct.sessionId). */
  sessionId?: string;
  /** Rule 6: throws (BudgetExhaustedError) when the next prompt is over budget. */
  budgetGate?: () => void;
  interruptGraceMs?: number;
  streamFlushMs?: number;
  approvalPollMs?: number;
  now?: () => number;
  newTurnId?: () => string;
  log?: (...args: unknown[]) => void;
}

type Turn = {
  turnId: string;
  startedAt: number;
  messages: number[];
  interruptRequested: boolean;
  grace?: NodeJS.Timeout;
  usage?: TurnUsage;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function eventPayload(event: NormalizedEvent): StoredEvent {
  const { type, ...rest } = event;
  const itemId = "itemId" in event ? event.itemId : undefined;
  // One row per item per type: a retried append (same key) writes nothing new.
  const key = itemId ? `${type}:${itemId}${type === "edit.diff" ? `:${(event as { path: string }).path}` : ""}` : undefined;
  return { type, ...(key ? { eventKey: key } : {}), payload: rest as Record<string, unknown> };
}

export class ThreadRunner {
  private opts: ThreadRunnerOptions;
  private now: () => number;
  private generation = 0;
  private session?: DirectSession;
  private sessionId?: string;
  private turn?: Turn;
  private retriedFresh = false;
  private closed = false;
  // Persist queue: events go to the store in order, one append at a time.
  private outbox: StoredEvent[] = [];
  private persisting: Promise<void> = Promise.resolve();
  private lastSeq = 0;
  // Hot streams: the text so far per item, and which items changed.
  private streamText = new Map<string, { kind: "text" | "reasoning" | "output"; text: string }>();
  private dirty = new Set<string>();
  private flushTimer?: NodeJS.Timeout;
  private turnDone: Array<() => void> = [];

  constructor(opts: ThreadRunnerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.sessionId = opts.sessionId;
  }

  get busy(): boolean {
    return Boolean(this.turn);
  }

  get currentTurnId(): string | undefined {
    return this.turn?.turnId;
  }

  get liveGeneration(): number {
    return this.generation;
  }

  /** Resolves when no turn is live (tests, shutdown). */
  idle(): Promise<void> {
    if (!this.turn) return this.persisting;
    return new Promise((resolve) => this.turnDone.push(resolve));
  }

  // ── Messages ──────────────────────────────────────────────────────────

  /**
   * A user message the store has (seq). Steered into the live turn, or the
   * start of a new turn.
   */
  async deliver(input: UserInput): Promise<void> {
    if (this.closed) return;
    if (this.turn && this.session && !this.turn.interruptRequested) {
      if (!this.passesBudget()) {
        await this.persist([{ type: "system.note", payload: { text: "This message was not sent: the task's LLM budget is spent." } }], { deliveredSeq: input.seq });
        return;
      }
      this.turn.messages.push(input.seq);
      await this.persist(
        [{ type: "turn.steered", eventKey: `turn.steered:${input.seq}`, payload: { turnId: this.turn.turnId, messageSeq: input.seq } }],
        { deliveredSeq: input.seq }
      );
      this.session.send(input);
      return;
    }
    await this.startTurn(input);
  }

  private passesBudget(): string | true {
    try {
      this.opts.budgetGate?.();
      return true;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private async startTurn(input: UserInput): Promise<void> {
    const turnId = this.opts.newTurnId?.() ?? `turn-${input.seq}-${this.now().toString(36)}`;
    // Rule 6: before the prompt and before any process is started.
    const budget = this.passesBudget();
    if (budget !== true) {
      await this.persist(
        [
          { type: "turn.started", eventKey: `turn.started:${turnId}`, payload: { turnId, messageSeq: input.seq } },
          {
            type: "turn.completed",
            eventKey: `turn.completed:${turnId}`,
            payload: { turnId, outcome: "failed", durationMs: 0, error: `Budget: ${budget}` },
          },
        ],
        { deliveredSeq: input.seq, status: "idle", turnId: null, idleSince: this.now() }
      );
      return;
    }
    const turn: Turn = { turnId, startedAt: this.now(), messages: [input.seq], interruptRequested: false };
    this.turn = turn;
    await this.persist(
      [{ type: "turn.started", eventKey: `turn.started:${turnId}`, payload: { turnId, messageSeq: input.seq } }],
      { deliveredSeq: input.seq, status: this.session ? "running" : "starting", turnId, idleSince: null, stoppedMidTurn: false, error: null }
    );
    if (this.turn !== turn) return; // stopped while persisting
    if (!this.session) this.startSession(this.opts.preamble);
    this.session!.send(input);
  }

  // ── Engine ────────────────────────────────────────────────────────────

  private startSession(preamble: string | undefined): void {
    const gen = ++this.generation;
    this.session = this.opts.engine.start(
      { taskId: this.opts.taskId, cwd: this.opts.cwd, sessionId: this.sessionId, preamble, model: this.opts.model },
      {
        output: (out) => {
          if (gen !== this.generation) return; // a dead or replaced engine
          this.onOutput(out);
        },
        requestApproval: (call) => {
          if (gen !== this.generation) return Promise.resolve({ decision: "expired" as const });
          return this.requestApproval(call);
        },
        exited: (error) => {
          if (gen !== this.generation) return;
          void this.onExited(error);
        },
      }
    );
  }

  private onOutput(out: AcpOutput | { kind: "session"; sessionId: string; model?: string } | { kind: "result"; result: TurnResult }): void {
    switch (out.kind) {
      case "event": {
        const stored = eventPayload(out.event);
        const itemId = (out.event as { itemId?: string }).itemId;
        if (itemId && (out.event.type === "assistant.text" || out.event.type === "reasoning")) {
          this.streamText.delete(itemId);
          this.dirty.delete(itemId);
        }
        this.queue(stored);
        return;
      }
      case "delta": {
        const kind = out.delta.type === "reasoning.delta" ? "reasoning" : "text";
        const cur = this.streamText.get(out.delta.itemId) ?? { kind, text: "" };
        cur.text += out.delta.text;
        this.streamText.set(out.delta.itemId, cur);
        this.dirty.add(out.delta.itemId);
        this.scheduleFlush();
        return;
      }
      case "context":
        return;
      case "session":
        this.sessionId = out.sessionId;
        void this.persist([], { sessionId: out.sessionId, status: this.turn ? "running" : "idle" });
        return;
      case "result":
        void this.onResult(out.result);
        return;
    }
  }

  private async onResult(result: TurnResult): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    if (result.usage) {
      turn.usage = addUsage(turn.usage, result.usage);
      await this.opts.store.recordUsage(result.usage).catch((e) => this.opts.log?.("usage record failed", e));
    }
    // A steered message is still to be answered: same turn.
    if (result.queuedTurns > 0 && result.outcome === "completed" && !turn.interruptRequested) return;
    await this.completeTurn(turn, result.outcome, result.error);
  }

  private async completeTurn(turn: Turn, outcome: TurnResult["outcome"], error?: string): Promise<void> {
    if (this.turn !== turn) return;
    this.turn = undefined;
    if (turn.grace) clearTimeout(turn.grace);
    await this.flushStreams();
    this.streamText.clear();
    this.dirty.clear();
    const durationMs = Math.max(0, this.now() - turn.startedAt);
    await this.persist(
      [
        {
          type: "turn.completed",
          eventKey: `turn.completed:${turn.turnId}`,
          payload: {
            turnId: turn.turnId,
            outcome,
            durationMs,
            answered: turn.messages,
            ...(error ? { error: error.slice(0, 2000) } : {}),
            ...(turn.usage ? { usage: turn.usage } : {}),
          },
        },
      ],
      { status: "idle", turnId: null, idleSince: this.now() }
    );
    await this.opts.store.clearStreams().catch(() => undefined);
    const waiters = this.turnDone;
    this.turnDone = [];
    waiters.forEach((w) => w());
  }

  private async failTurn(message: string, outcome: TurnResult["outcome"] = "failed"): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    await this.completeTurn(turn, outcome, message);
  }

  private async onExited(error?: Error): Promise<void> {
    this.session = undefined;
    const turn = this.turn;
    if (!turn) return;
    if (error instanceof SessionNotFoundError && !this.retriedFresh) {
      // Once: a fresh session that is told the story so far, and the turn's
      // messages again.
      this.retriedFresh = true;
      this.sessionId = undefined;
      await this.persist(
        [{ type: "system.note", payload: { text: "The earlier agent session couldn't be resumed, so a new one carries on with a summary of this thread." } }],
        { sessionId: null }
      );
      let note = "";
      try {
        const events = await this.opts.store.loadEvents();
        note = handoffNote(events, turn.messages[0]);
      } catch (e) {
        this.opts.log?.("handoff history failed", e);
      }
      if (this.turn !== turn) return;
      this.startSession([this.opts.preamble, note].filter(Boolean).join("\n\n") || undefined);
      const events = await this.opts.store.loadEvents().catch(() => [] as HandoffEvent[]);
      for (const seq of turn.messages) {
        const text = String(((events.find((e) => e.sequence === seq)?.payload ?? {}) as { text?: unknown }).text ?? "");
        if (text) this.session!.send({ seq, text });
      }
      return;
    }
    await this.failTurn(error?.message ?? "The agent exited.", turn.interruptRequested ? "interrupted" : "failed");
  }

  // ── Stop ──────────────────────────────────────────────────────────────

  /**
   * session/cancel now; if the engine has not ended the turn within the
   * grace, the turn is failed as interrupted and the engine is killed.
   */
  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn || turn.interruptRequested) return;
    turn.interruptRequested = true;
    const session = this.session;
    turn.grace = setTimeout(() => {
      if (this.turn !== turn) return;
      this.opts.log?.("interrupt grace passed, killing the agent", this.opts.taskId);
      // Generation bump: whatever the frozen engine says later is dropped.
      this.generation++;
      this.session = undefined;
      session?.kill();
      void this.failTurn("Interrupted.", "interrupted");
    }, this.opts.interruptGraceMs ?? INTERRUPT_GRACE_MS);
    turn.grace.unref?.();
    if (!session) return void (await this.failTurn("Interrupted.", "interrupted"));
    try {
      await session.interrupt();
    } catch {
      // Failed before the agent was up: kill it.
      this.generation++;
      this.session = undefined;
      session.kill();
      await this.failTurn("Interrupted.", "interrupted");
    }
  }

  // ── Approvals (in-process; the lease stays with this worker) ──────────

  private async requestApproval(call: ToolGateCall): Promise<ToolGateAnswer> {
    await this.drain(); // the tool row lands before its card
    const asked = await this.opts.store.requestApproval({
      itemId: call.itemId,
      request: call.description.request,
      input: call.description.input,
    });
    if (asked.status === "auto") return { decision: "allow" };
    if (this.turn) await this.persist([], { status: "waiting" });
    try {
      for (;;) {
        if (call.signal.aborted) {
          await this.opts.store.cancelApproval(asked.approvalId, "Stopped").catch(() => undefined);
          return { decision: "expired" };
        }
        const state = await this.opts.store.approvalState(asked.approvalId).catch(() => null);
        if (state && state.status !== "pending") {
          if (state.status === "approved") return { decision: "allow" };
          if (state.status === "rejected") return { decision: "deny", ...(state.note ? { message: `The user denied this: ${state.note}` } : {}) };
          return { decision: "expired", ...(state.note ? { message: state.note } : {}) };
        }
        if (state?.taskStatus === "cancelled") {
          await this.opts.store.cancelApproval(asked.approvalId, "The thread was closed").catch(() => undefined);
          return { decision: "expired" };
        }
        await Promise.race([
          sleep(this.opts.approvalPollMs ?? APPROVAL_POLL_MS),
          new Promise<void>((resolve) => call.signal.addEventListener("abort", () => resolve(), { once: true })),
        ]);
      }
    } finally {
      if (this.turn) await this.persist([], { status: "running" }).catch(() => undefined);
    }
  }

  // ── Persistence ───────────────────────────────────────────────────────

  private queue(event: StoredEvent): void {
    this.outbox.push(event);
    void this.persist([]);
  }

  /** Appends queued events plus `events`, in order, with an optional state patch. */
  private persist(events: StoredEvent[], state?: DirectStatePatch): Promise<void> {
    this.outbox.push(...events);
    const run = this.persisting.then(async () => {
      let patch = state;
      // One append at a time, in order; whatever was queued meanwhile goes
      // in the next batch of this same run.
      while (this.outbox.length || patch) {
        const batch = this.outbox.splice(0, 100);
        const seqs = await this.opts.store.appendEvents(batch, patch);
        patch = undefined;
        for (const s of seqs) if (s > this.lastSeq) this.lastSeq = s;
      }
    });
    this.persisting = run.catch((e) => this.opts.log?.("persist failed", this.opts.taskId, e));
    return this.persisting;
  }

  /** Waits for everything queued to reach the store. */
  async drain(): Promise<void> {
    for (;;) {
      const before = this.persisting;
      await before;
      if (this.outbox.length) {
        await this.persist([]);
        continue;
      }
      if (before === this.persisting) return;
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushStreams();
    }, this.opts.streamFlushMs ?? STREAM_FLUSH_MS);
    this.flushTimer.unref?.();
  }

  private async flushStreams(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const items = [...this.dirty].flatMap((itemId) => {
      const s = this.streamText.get(itemId);
      return s ? [{ itemId, kind: s.kind, text: s.text }] : [];
    });
    this.dirty.clear();
    if (!items.length) return;
    await this.opts.store.flushStream(this.lastSeq, items).catch((e) => this.opts.log?.("stream flush failed", e));
  }

  // ── Ending ────────────────────────────────────────────────────────────

  /** Idle release or shutdown: the session ends; a live turn is failed. */
  async close(reason = "released"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const session = this.session;
    this.generation++;
    this.session = undefined;
    if (this.turn) await this.failTurn(`The agent session ended (${reason}).`, "interrupted");
    await session?.end().catch(() => session.kill());
    await this.drain();
  }
}

function addUsage(a: TurnUsage | undefined, b: TurnUsage): TurnUsage {
  if (!a) return { ...b };
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.cachedReadTokens || b.cachedReadTokens ? { cachedReadTokens: (a.cachedReadTokens ?? 0) + (b.cachedReadTokens ?? 0) } : {}),
    ...(b.costUsd !== undefined || a.costUsd !== undefined ? { costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) } : {}),
    ...(b.model ?? a.model ? { model: b.model ?? a.model } : {}),
  };
}
