/**
 * Direct thread engine contract (threadbear T2; the shape follows
 * threadbear runner/src/adapters/types.ts AgentAdapter / AgentSession /
 * SessionSink, re-written for Fhara: one engine per live thread, the
 * runner (threadRunner.ts) owns everything else).
 */
import type { AcpOutput, NormalizedEvent } from "@/vendor/threadbear/acp/normalize";
import type { RestoreRecord } from "./restore";
import type { ToolGateAnswer, ToolGateCall } from "./toolGate";

export type { NormalizedEvent };

/** timed_out: the turn watchdog stopped it (threadRunner.ts; never an engine's own result). */
export type TurnOutcome = "completed" | "interrupted" | "failed" | "timed_out";

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  costUsd?: number;
  model?: string;
}

export interface TurnResult {
  outcome: TurnOutcome;
  durationMs: number;
  error?: string;
  /** auth: the agent needs a sign-in. */
  errorKind?: "auth";
  usage?: TurnUsage;
  /** Prompts still held by the engine (steers not yet answered). */
  queuedTurns: number;
}

export interface UserInput {
  /** The user.message sequence this prompt carries. */
  seq: number;
  text: string;
}

/** What an engine reports to its runner. */
export interface SessionSink {
  output(out: AcpOutput | { kind: "session"; sessionId: string; model?: string } | { kind: "result"; result: TurnResult }): void;
  /** A tool call wants a decision; resolves once answered or cancelled. */
  requestApproval(call: ToolGateCall): Promise<ToolGateAnswer>;
  /**
   * A frame from the agent arrived mid-turn (the turn watchdog's liveness
   * signal); progress when it advanced the turn (text, a tool, a plan), not
   * a heartbeat or usage broadcast.
   */
  activity?(progress: boolean): void;
  /** A session start (new, resume or load) ended: its phases, no content (Nuphos N4). */
  restore?(record: RestoreRecord): void;
  /** The engine ended (error: it crashed or could not start). */
  exited(error?: Error): void;
}

export interface StartSessionOptions {
  taskId: string;
  cwd: string;
  /** Resume this engine session (session/resume or session/load). */
  sessionId?: string;
  /** Said once, before the first prompt of a new session (role, handoff). */
  preamble?: string;
  model?: string;
}

/** A live engine session: one per live thread. */
export interface DirectSession {
  /** Queue a prompt: it runs now, or after the running one (a steer). */
  send(input: UserInput): void;
  /** session/cancel: the turn should end with outcome "interrupted". */
  interrupt(): Promise<void>;
  /** Graceful end (idle release). */
  end(): Promise<void>;
  /** Kill straight away (a frozen agent after the interrupt grace). */
  kill(): void;
}

export interface DirectEngine {
  readonly name: "opencode-acp" | "api-loop";
  start(options: StartSessionOptions, sink: SessionSink): DirectSession;
}

/** The engine could not find the session to resume: retry fresh with a handoff. */
export class SessionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionNotFoundError";
  }
}
