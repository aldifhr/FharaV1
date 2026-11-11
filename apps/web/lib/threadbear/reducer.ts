/**
 * Threadbear T3: direct-thread events → transcript rows.
 *
 * Pattern from threadbear `web/src/transcript.ts` (https://github.com/mikecann/threadbear,
 * MIT, Copyright (c) 2026 Mike Cann; see THIRD_PARTY_NOTICES.md): fold the persisted event
 * stream in sequence order, merge each item's later events (a tool's result, a card's
 * answer) into the row its first event opened, then lay the hot streaming rows on top.
 * Written for Fhara's event payloads; no code copied.
 *
 * Rules the tests hold:
 *   - rows come out in sequence order whatever order the events arrive in;
 *   - an approval or question card is never dropped: a resolution without its request
 *     still makes a row, and a pending card from `approvals.listByTask` that fell
 *     outside the live window is added;
 *   - the newest assistant text is always a row (a hot stream shows until its item is
 *     persisted, then the persisted text replaces it).
 *
 * Pure: no React, no Convex. N8's folds (activity, turn, repeated failures) run on the
 * rows this returns.
 */
import { noteFromEvent, plainText, recordOf } from "./eventText";
import type {
  ApprovalRow,
  ApprovalState,
  Hunk,
  OptimisticMessage,
  PendingCard,
  QuestionRow,
  StreamRow,
  ThreadEvent,
  ToolRow,
  TranscriptRow,
  UserRow,
} from "./types";

export type ReduceInput = {
  events: readonly ThreadEvent[];
  streams?: readonly StreamRow[];
  optimistic?: readonly OptimisticMessage[];
  pendingCards?: readonly PendingCard[];
};

const seqOf = (e: ThreadEvent) => (typeof e.sequence === "number" ? e.sequence : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function decisionState(decision: unknown): ApprovalState {
  if (decision === "allow" || decision === "allowAlways") return "allowed";
  if (decision === "deny") return "denied";
  return "cancelled";
}

/** Events sorted by sequence, one per sequence (a later copy of the same sequence wins). */
export function orderEvents(events: readonly ThreadEvent[]): ThreadEvent[] {
  const bySeq = new Map<number, ThreadEvent>();
  const unsequenced: ThreadEvent[] = [];
  for (const e of events) {
    if (typeof e.sequence === "number") bySeq.set(e.sequence, e);
    else unsequenced.push(e);
  }
  return [...[...bySeq.values()].sort((a, b) => seqOf(a) - seqOf(b)), ...unsequenced];
}

export function reduceTranscript(input: ReduceInput): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const tools = new Map<string, ToolRow>();
  const cards = new Map<string, ApprovalRow>();
  const questions = new Map<string, QuestionRow>();
  const textItems = new Set<string>();
  const userBySeq = new Map<number, UserRow>();
  const clientIds = new Set<string>();
  let turnId: string | undefined;
  let lastSeq = 0;

  for (const e of orderEvents(input.events)) {
    const seq = seqOf(e);
    lastSeq = Math.max(lastSeq, seq);
    const p = recordOf(e.payload);
    const key = `e${seq}`;
    const itemId = str(p.itemId);
    switch (e.type) {
      case "user.message": {
        const row: UserRow = { kind: "user", key, seq, text: str(p.text), ...(str(p.clientId) ? { clientId: str(p.clientId) } : {}) };
        if (row.clientId) clientIds.add(row.clientId);
        userBySeq.set(seq, row);
        rows.push(row);
        break;
      }
      case "turn.started":
        turnId = str(p.turnId) || undefined;
        break;
      case "turn.steered": {
        const msg = userBySeq.get(Number(p.messageSeq));
        if (msg) msg.steered = true;
        break;
      }
      case "assistant.text":
      case "reasoning": {
        if (itemId) textItems.add(itemId);
        const kind = e.type === "assistant.text" ? "assistant" : "reasoning";
        rows.push({ kind, key, seq, itemId, text: str(p.text), turnId });
        break;
      }
      case "tool.call": {
        const row: ToolRow = {
          kind: "tool",
          key,
          seq,
          turnId,
          itemId,
          name: str(p.name),
          toolKind: str(p.kind) || "other",
          title: str(p.title) || str(p.name) || "Tool",
          input: recordOf(p.input),
        };
        if (itemId) tools.set(itemId, row);
        rows.push(row);
        break;
      }
      case "tool.result": {
        const result = { seq, ok: p.ok !== false, text: str(p.text), truncated: p.truncated === true, hasBody: p.hasBody === true, ...(typeof p.bytes === "number" ? { bytes: p.bytes } : {}) };
        const open = itemId ? tools.get(itemId) : undefined;
        if (open) open.result = result;
        else {
          // The call fell outside the loaded window: the result still shows.
          const row: ToolRow = { kind: "tool", key, seq, turnId, itemId, name: "", toolKind: "other", title: "Tool output", input: {}, result };
          if (itemId) tools.set(itemId, row);
          rows.push(row);
        }
        break;
      }
      case "edit.diff":
        rows.push({ kind: "diff", key, seq, turnId, itemId, path: str(p.path), hunks: Array.isArray(p.hunks) ? (p.hunks as Hunk[]) : [] });
        break;
      case "approval.requested":
        if (p.kind === "question") upsertQuestion(rows, questions, p, key, seq, turnId);
        else upsertCard(rows, cards, p, key, seq, turnId);
        break;
      case "approval.resolved":
        if (p.kind === "question") resolveQuestion(rows, questions, p, key, seq);
        else resolveCard(rows, cards, p, key, seq);
        break;
      case "plan.updated":
        rows.push({ kind: "plan", key, seq, turnId, entries: Array.isArray(p.entries) ? (p.entries as { text: string; status: string }[]) : [] });
        break;
      case "turn.completed": {
        const usage = recordOf(p.usage);
        const tokens = (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0);
        rows.push({
          kind: "turn",
          key,
          seq,
          turnId: str(p.turnId) || turnId,
          outcome: str(p.outcome) || "completed",
          durationMs: Number(p.durationMs) || 0,
          ...(str(p.error) ? { error: str(p.error) } : {}),
          ...(tokens ? { tokens } : {}),
        });
        turnId = undefined;
        break;
      }
      default: {
        const note = noteFromEvent(e.type, p);
        if (note) rows.push({ kind: "note", key, seq, turnId, ...note });
      }
    }
  }

  addPendingCards(rows, cards, input.pendingCards ?? []);
  const live = lastSeq + 1;
  addStreams(rows, tools, textItems, input.streams ?? [], live, turnId);
  for (const [i, m] of (input.optimistic ?? []).entries()) {
    if (clientIds.has(m.clientId)) continue;
    rows.push({ kind: "user", key: `o:${m.clientId}`, seq: live + 0.5 + i / 1000, text: m.text, clientId: m.clientId, sending: true });
  }
  return rows.sort((a, b) => a.seq - b.seq);
}

function upsertCard(rows: TranscriptRow[], cards: Map<string, ApprovalRow>, p: Record<string, unknown>, key: string, seq: number, turnId?: string) {
  const approvalId = str(p.approvalId);
  const known = approvalId ? cards.get(approvalId) : undefined;
  const fields = {
    approvalKind: str(p.kind) || "tool_call",
    title: str(p.title) || "Tool call",
    input: str(p.input),
    ...(str(p.reason) ? { reason: str(p.reason) } : {}),
    ...(str(p.itemId) ? { itemId: str(p.itemId) } : {}),
  };
  if (known) {
    // The resolution came first (a page loaded later): keep its state, fill in the request.
    Object.assign(known, fields, { seq, key });
    return;
  }
  const row: ApprovalRow = { kind: "approval", key, seq, turnId, approvalId, state: "pending", ...fields };
  if (approvalId) cards.set(approvalId, row);
  rows.push(row);
}

function resolveCard(rows: TranscriptRow[], cards: Map<string, ApprovalRow>, p: Record<string, unknown>, key: string, seq: number) {
  const approvalId = str(p.approvalId);
  const state = decisionState(p.decision);
  const message = str(p.message) || str(p.reason) || undefined;
  const known = approvalId ? cards.get(approvalId) : undefined;
  if (known) {
    known.state = state;
    if (message) known.message = message;
    return;
  }
  const row: ApprovalRow = { kind: "approval", key, seq, approvalId, approvalKind: "tool_call", title: "Tool call", input: "", state, ...(message ? { message } : {}) };
  if (approvalId) cards.set(approvalId, row);
  rows.push(row);
}

function questionKey(p: Record<string, unknown>): string {
  return str(p.questionId) || str(p.itemId);
}

function upsertQuestion(rows: TranscriptRow[], questions: Map<string, QuestionRow>, p: Record<string, unknown>, key: string, seq: number, turnId?: string) {
  const id = questionKey(p);
  const fields = {
    question: str(p.question),
    options: Array.isArray(p.options) ? (p.options as unknown[]).map(String) : [],
    ...(p.multiple === true ? { multiple: true } : {}),
    answerer: (p.answerer === "cto" ? "cto" : "user") as "user" | "cto",
    ...(str(p.reason) ? { reason: str(p.reason) } : {}),
  };
  const known = id ? questions.get(id) : undefined;
  if (known) {
    // Re-shown for the user (the CTO declined): the same card moves to now, still open.
    Object.assign(known, fields, { seq, key });
    if (known.answer === undefined) known.state = "open";
    return;
  }
  const row: QuestionRow = { kind: "question", key, seq, turnId, questionId: id, itemId: str(p.itemId), state: "open", ...fields };
  if (id) questions.set(id, row);
  rows.push(row);
}

function resolveQuestion(rows: TranscriptRow[], questions: Map<string, QuestionRow>, p: Record<string, unknown>, key: string, seq: number) {
  const id = questionKey(p);
  const known = id ? questions.get(id) : undefined;
  const answer = str(p.answer);
  const by = str(p.by) || undefined;
  if (known) {
    Object.assign(known, { state: "answered", answer, ...(by ? { answeredBy: by } : {}) });
    return;
  }
  const row: QuestionRow = {
    kind: "question", key, seq, questionId: id, itemId: str(p.itemId), question: "", options: [], answerer: "user", state: "answered", answer, ...(by ? { answeredBy: by } : {}),
  };
  if (id) questions.set(id, row);
  rows.push(row);
}

/** A pending card the live window does not hold sorts first (it is older than the window). */
function addPendingCards(rows: TranscriptRow[], cards: Map<string, ApprovalRow>, pending: readonly PendingCard[]) {
  for (const card of pending) {
    if (card.status !== "pending" || cards.has(String(card._id))) continue;
    const p = recordOf(card.payload);
    const row: ApprovalRow = {
      kind: "approval",
      key: `a:${card._id}`,
      seq: -1,
      approvalId: String(card._id),
      approvalKind: card.kind,
      title: str(p.title) || card.summary,
      input: str(p.input),
      state: "pending",
      ...(str(p.reason) ? { reason: str(p.reason) } : {}),
      ...(str(p.itemId) ? { itemId: str(p.itemId) } : {}),
    };
    cards.set(row.approvalId, row);
    rows.push(row);
  }
}

function addStreams(rows: TranscriptRow[], tools: Map<string, ToolRow>, persisted: Set<string>, streams: readonly StreamRow[], live: number, turnId?: string) {
  const sorted = [...streams].sort((a, b) => a.seq - b.seq);
  sorted.forEach((s, i) => {
    if (s.kind === "output") {
      const tool = tools.get(s.itemId);
      if (tool && !tool.result) tool.liveOutput = s.text;
      return;
    }
    if (persisted.has(s.itemId) || !plainText(s.text)) return;
    rows.push({ kind: s.kind === "text" ? "assistant" : "reasoning", key: `s:${s.itemId}`, seq: live + i / 1000, itemId: s.itemId, text: s.text, streaming: true, turnId });
  });
}

/** The thread is mid-turn: a turn started with no completion after it. */
export function turnRunning(events: readonly ThreadEvent[]): boolean {
  let running = false;
  for (const e of orderEvents(events)) {
    if (e.type === "turn.started") running = true;
    else if (e.type === "turn.completed") running = false;
  }
  return running;
}
