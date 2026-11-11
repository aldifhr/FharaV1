/**
 * Session restore diagnostics for ACP direct threads (Nuphos N4, idea #6).
 *
 * Pattern only, after the Nuphos runtime's "Session restoration
 * diagnostics" and openab's transient/permanent split for session loads
 * (see THIRD_PARTY_NOTICES.md for both projects); nothing is copied.
 *
 * Every session start (new, resume or load) is one attempt. Its phases are
 * timed and the outcome is reported to the runner, which stores it as a
 * `session.restore` task event. No content: no prompts, no agent text and
 * no error messages, only phase names, timings, the op, the agent pid and
 * a failure class.
 */
import { AcpExitedError } from "@/vendor/threadbear/acp/connection";

export type RestoreOp = "new" | "resume" | "load";
export type RestorePhaseName = "initialize" | "identify" | "open" | "model" | "ready";
/** not_found: permanent (fresh session plus handoff). transient: the id is kept and retried. */
export type RestoreFailure = "not_found" | "transient" | "auth" | "failed";

export type RestorePhase = { name: RestorePhaseName; at: number; elapsedMs: number; ok: boolean };

export type RestoreRecord = {
  attemptId: string;
  op: RestoreOp;
  pid?: number;
  startedAt: number;
  phases: RestorePhase[];
  outcome: "running" | "completed" | "failed";
  failure?: RestoreFailure;
  durationMs: number;
};

// Failures that say the agent could not be reached in time, not that the
// session is gone: the saved id stays and the next message tries it again.
const TRANSIENT = /didn't answer \S+ within|timed? ?out|timeout waiting|channel closed|connection (?:reset|closed)|ECONNRESET|EPIPE/i;

export function isTransientRestoreError(e: unknown): boolean {
  if (e instanceof AcpExitedError) return true;
  return TRANSIENT.test(e instanceof Error ? e.message : String(e));
}

/** The saved session could not be reached (timeout, agent gone mid-load): kept, retried on the next message. */
export class SessionResumeTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionResumeTransientError";
  }
}

/** What the person reads when the saved session could not be reached. */
export const TRANSIENT_RESTORE_NOTE =
  "Couldn't reach the saved agent session (it didn't answer in time), so this message wasn't run. The session is kept, and the next message will try it again.";

/** What the person reads when the saved session is gone for good. */
export const PERMANENT_RESTORE_NOTE =
  "The saved agent session no longer exists, so a new session carries on with a summary of this thread.";

let counter = 0;

export class RestoreRecorder {
  private record: RestoreRecord;
  private done = false;

  constructor(
    op: RestoreOp,
    private readonly now: () => number = Date.now,
    attemptId = `restore-${now().toString(36)}-${(++counter).toString(36)}`
  ) {
    const startedAt = now();
    this.record = { attemptId, op, startedAt, phases: [], outcome: "running", durationMs: 0 };
  }

  set op(op: RestoreOp) {
    this.record.op = op;
  }

  set pid(pid: number | undefined) {
    if (pid) this.record.pid = pid;
  }

  get finished(): boolean {
    return this.done;
  }

  phase(name: RestorePhaseName, ok = true): void {
    if (this.done) return;
    const at = this.now();
    this.record.phases.push({ name, at, elapsedMs: Math.max(0, at - this.record.startedAt), ok });
  }

  /** Ends the attempt; returns the record once (later calls return undefined). */
  finish(outcome: "completed" | "failed", failure?: RestoreFailure): RestoreRecord | undefined {
    if (this.done) return undefined;
    this.done = true;
    this.record.outcome = outcome;
    if (failure) this.record.failure = failure;
    this.record.durationMs = Math.max(0, this.now() - this.record.startedAt);
    return this.snapshot();
  }

  snapshot(): RestoreRecord {
    return { ...this.record, phases: this.record.phases.map((p) => ({ ...p })) };
  }
}
