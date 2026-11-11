/**
 * Direct thread engine contract (threadbear T2; the shape follows
 * threadbear runner/src/adapters/types.ts AgentAdapter / AgentSession /
 * SessionSink, re-written for Fhara: one engine per live thread, the
 * runner (threadRunner.ts) owns everything else).
 */
import type { AcpOutput, NormalizedEvent } from "@/vendor/threadbear/acp/normalize";
import type { RestoreRecord } from "./restore";
import type { AcpMcpServer } from "./mcpDeclare";
import type { ApprovalCancelReason, ToolGateAnswer, ToolGateCall } from "./toolGate";

export type { ApprovalCancelReason };

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

/** One cancelled permission request, as the engine reports it. */
export interface PermissionCancel {
  itemId: string;
  reason: ApprovalCancelReason;
  message?: string;
  approvalId?: string;
  /** The store already wrote approval.resolved for it (a card it closed). */
  recorded?: boolean;
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
  /** A permission request was answered "cancelled" (or expired): the reason, for approval.resolved. */
  permissionCancelled?(cancel: PermissionCancel): void;
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
  /** Nuphos N10: MCP servers declared on session/new|resume|load (values are secrets: never logged). */
  mcpServers?: AcpMcpServer[];
  /** Nuphos N10: reasoning effort (tasks.direct.effort); applied at boot, so re-applied on every resume. */
  effort?: string | null;
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
  /** Nuphos N10: a new effort; applied before the next prompt, never mid-turn. */
  setEffort?(effort: string | null): void;
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
