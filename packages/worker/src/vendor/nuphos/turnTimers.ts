// Copied from Nuphos (https://github.com/nuphos/nuphos), apps/backend/src/lib/claude-code-preview/openab-acp-timers.ts @ a210a05.
// Copyright 2026 Zeabur Inc. Licensed under the Apache License, Version 2.0
// (http://www.apache.org/licenses/LICENSE-2.0). See THIRD_PARTY_NOTICES.md.
//
// Modified by Fhara, 2026-11: `TURN_PROGRESS_UPDATES` and
// `isTurnProgressUpdate` are kept as they were. `createCallTimer` (one
// setTimeout per pending JSON-RPC call, re-armed by `refreshSessionTimers`)
// becomes `TurnWatchdog`, one per direct-thread turn: the same two windows
// (inactivity: any frame; progress: only turn-advancing frames, heartbeats
// don't count) applied as a single timer, plus a pause while the turn waits
// on an approval card (openab `candidate_awaiting_permission`, bounded by a
// cap) and a callback naming which window ran out instead of a thrown
// OpenAbTimeoutError. `refreshSessionTimers` is dropped (the runner re-arms).

const TURN_PROGRESS_UPDATES = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'async_task_spawned',
  'async_task_progress',
  'async_task_state_update',
]);

/** Heartbeats, usage and session-state broadcasts are liveness, not progress. */
export function isTurnProgressUpdate(params: unknown): boolean {
  if (!params || typeof params !== 'object') return false;
  const update = (params as { update?: unknown }).update;

  if (!update || typeof update !== 'object') return false;

  return TURN_PROGRESS_UPDATES.has(String((update as { sessionUpdate?: unknown }).sessionUpdate));
}

/** Which window ran out: no frame at all, or frames but no turn progress. */
export type TurnTimeoutReason = 'no_output' | 'no_progress';

export type TurnWatchdogOptions = {
  /** Any frame restarts it. 0: off. */
  inactivityMs: number;
  /** Only progress restarts it. 0: off. */
  progressMs: number;
  /** Longest a turn parked on an approval card is exempt. 0: no cap. */
  approvalCapMs?: number;
  now?: () => number;
};

/**
 * Two windows for one turn, applied as a single timer. `fire` is called at
 * most once, with the window that ran out (and how long it was).
 */
export class TurnWatchdog {
  private timer?: ReturnType<typeof setTimeout>;
  private lastFrame: number;
  private lastProgress: number;
  private pausedAt: number | null = null;
  private pauses = 0;
  private fired = false;
  private readonly now: () => number;

  constructor(
    private readonly opts: TurnWatchdogOptions,
    private readonly fire: (reason: TurnTimeoutReason, windowMs: number) => void,
  ) {
    this.now = opts.now ?? Date.now;
    this.lastFrame = this.lastProgress = this.now();
  }

  get enabled(): boolean {
    return this.opts.inactivityMs > 0 || this.opts.progressMs > 0;
  }

  get done(): boolean {
    return this.fired;
  }

  /** Parked on an approval card (also after the cap tripped there). */
  get paused(): boolean {
    return this.pausedAt !== null;
  }

  /** Starts (or restarts) both windows from now. */
  start(): void {
    this.lastFrame = this.lastProgress = this.now();
    this.arm();
  }

  /** A frame arrived; `progress` when it advanced the turn. */
  frame(progress = false): void {
    if (this.fired) return;
    const t = this.now();
    this.lastFrame = t;
    if (progress) this.lastProgress = t;
    if (this.pausedAt === null) this.arm();
  }

  /** The turn waits on the person (an approval card): exempt, up to the cap. */
  pause(): void {
    if (this.fired) return;
    if (this.pauses++ === 0) this.pausedAt = this.now();
    this.arm();
  }

  /** The card was answered: both windows start again from now. */
  resume(): void {
    if (this.fired || this.pauses === 0) return;
    if (--this.pauses > 0) return;
    this.pausedAt = null;
    this.start();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.fired = true;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.fired || !this.enabled) return;
    const { inactivityMs, progressMs } = this.opts;
    const cap = this.opts.approvalCapMs ?? 0;
    const t = this.now();
    let due: number;
    if (this.pausedAt !== null) {
      if (cap <= 0) return;
      due = this.pausedAt + cap;
    } else {
      due = Number.POSITIVE_INFINITY;
      if (inactivityMs > 0) due = Math.min(due, this.lastFrame + inactivityMs);
      if (progressMs > 0) due = Math.min(due, this.lastProgress + progressMs);
    }
    this.timer = setTimeout(() => this.check(), Math.max(0, due - t));
    this.timer.unref?.();
  }

  private check(): void {
    this.timer = undefined;
    if (this.fired) return;
    const t = this.now();
    const { inactivityMs, progressMs } = this.opts;
    if (this.pausedAt !== null) {
      const cap = this.opts.approvalCapMs ?? 0;
      if (cap > 0 && t - this.pausedAt >= cap) return this.trip('no_progress', cap);
      return this.arm();
    }
    if (inactivityMs > 0 && t - this.lastFrame >= inactivityMs) return this.trip('no_output', inactivityMs);
    if (progressMs > 0 && t - this.lastProgress >= progressMs) return this.trip('no_progress', progressMs);
    this.arm();
  }

  private trip(reason: TurnTimeoutReason, windowMs: number): void {
    this.stop();
    this.fire(reason, windowMs);
  }
}
