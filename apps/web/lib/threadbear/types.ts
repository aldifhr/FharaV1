/**
 * Threadbear T3: the shapes the direct-thread transcript works on.
 *
 * `ThreadEvent` is a `taskEvents` row as `directThreads.tail` / `page`
 * return it (threadbear protocol event names, gapless per-task `sequence`).
 * `StreamRow` is a `threadStreams` hot row (`directThreads.streams`): text
 * still streaming for an item that is not persisted yet.
 *
 * Pure types: no React, no Convex imports, so node unit tests and N8's
 * fold rules (activity, turn, repeated failures) can import them.
 */

export type ThreadEvent = {
  _id?: string;
  sequence?: number;
  type: string;
  payload?: unknown;
  _creationTime?: number;
};

export type StreamRow = { itemId: string; kind: "text" | "reasoning" | "output"; text: string; seq: number };

/** A message sent from this tab that the tail has not returned yet. */
export type OptimisticMessage = { clientId: string; text: string };

/** A pending card from `approvals.listByTask`, so a card older than the live window is still shown. */
export type PendingCard = {
  _id: string;
  kind: string;
  summary: string;
  status: string;
  payload?: unknown;
  _creationTime?: number;
};

export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };

export type ApprovalState = "pending" | "allowed" | "denied" | "cancelled";
export type TurnOutcome = "completed" | "interrupted" | "failed" | "timed_out" | string;

type RowBase = {
  /** Stable React key. */
  key: string;
  /** Sort position: the event sequence (streams and optimistic rows sort after the tail). */
  seq: number;
  /** The turn this row belongs to, when known (N8 folds by it). */
  turnId?: string;
};

export type UserRow = RowBase & {
  kind: "user";
  text: string;
  clientId?: string;
  /** True until the tail returns the stored message. */
  sending?: boolean;
  /** Steer receipt: this message joined a turn that was already running. */
  steered?: boolean;
};
export type AssistantRow = RowBase & { kind: "assistant"; itemId: string; text: string; streaming?: boolean };
export type ReasoningRow = RowBase & { kind: "reasoning"; itemId: string; text: string; streaming?: boolean };
export type ToolResult = { seq: number; ok: boolean; text: string; truncated: boolean; hasBody: boolean; bytes?: number };
export type ToolRow = RowBase & {
  kind: "tool";
  itemId: string;
  name: string;
  toolKind: string;
  title: string;
  input: Record<string, unknown>;
  result?: ToolResult;
  /** Live output from a hot row while the tool runs. */
  liveOutput?: string;
};
export type DiffRow = RowBase & { kind: "diff"; itemId: string; path: string; hunks: Hunk[] };
export type ApprovalRow = RowBase & {
  kind: "approval";
  approvalId: string;
  itemId?: string;
  /** The approval kind: run_command, run_unconfined, tool_call, … */
  approvalKind: string;
  title: string;
  input: string;
  reason?: string;
  state: ApprovalState;
  /** The note on a resolved card (a reply that declined it, a cancel reason). */
  message?: string;
};
export type QuestionRow = RowBase & {
  kind: "question";
  questionId: string;
  itemId: string;
  question: string;
  options: string[];
  multiple?: boolean;
  answerer: "user" | "cto";
  reason?: string;
  state: "open" | "answered";
  answer?: string;
  answeredBy?: string;
};
export type NoteRow = RowBase & { kind: "note"; text: string; tone?: "neutral" | "danger" };
export type PlanRow = RowBase & { kind: "plan"; entries: { text: string; status: string }[] };
export type TurnFooterRow = RowBase & {
  kind: "turn";
  outcome: TurnOutcome;
  durationMs: number;
  error?: string;
  tokens?: number;
};

export type TranscriptRow =
  | UserRow
  | AssistantRow
  | ReasoningRow
  | ToolRow
  | DiffRow
  | ApprovalRow
  | QuestionRow
  | NoteRow
  | PlanRow
  | TurnFooterRow;
