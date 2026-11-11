// Adapted from threadbear (https://github.com/mikecann/threadbear), runner/src/handoff-history.ts @ 43fa197.
// MIT License, Copyright (c) 2026 Mike Cann. See THIRD_PARTY_NOTICES.md.
//
// Changes for Fhara: events are Fhara taskEvents rows ({type, sequence,
// payload}); the agent-message and end_turn special cases are dropped;
// findLast is a loop (ES2022 target). The history in the note is fenced as
// untrusted (apps/api/convex/lib/untrustedContent.ts, from Nuphos).

// The "Recent messages" part of a handoff note: what a fresh session is
// told about the thread so far when the old one can't be resumed. Messages
// and the work between them (commands with a little of their output, files
// edited, errors), not just the chat, so a model taking over mid-task knows
// what was already tried. The last user message, the last reply and the
// thread's first message go in first; the rest fill the budget from newest
// to oldest. Shown in the order they happened.

import { fenceUntrusted, UNTRUSTED_NOTE } from "@/api/convex/lib/untrustedContent";

export const HANDOFF_BUDGET = 16000;
const MESSAGE_CHARS = 2000;
const OUTPUT_CHARS = 300;

/** The part of a taskEvents row the handoff reads. */
export type HandoffEvent = { type: string; sequence?: number; payload?: unknown };

type Item = { seq: number; text: string; role: "user" | "assistant" | "work" };

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const str = (v: unknown) => (typeof v === "string" ? v : "");

// One item per message, tool call (with its result folded in) and edited
// file, oldest first. Messages at or after `skipFromSeq` are left out: they
// follow the note.
export function historyItems(events: HandoffEvent[], skipFromSeq?: number): Item[] {
  const items: Item[] = [];
  const calls = new Map<string, Item>();
  const edited = new Set<string>();
  const lastText = new Map<string, number>();
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.type === "assistant.text") lastText.set(str(p.itemId), e.sequence ?? 0);
  }
  for (const e of events) {
    const seq = e.sequence ?? 0;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.type === "user.message") {
      if (skipFromSeq !== undefined && seq >= skipFromSeq) continue;
      items.push({ seq, role: "user", text: `User: ${clip(str(p.text), MESSAGE_CHARS)}` });
    } else if (e.type === "assistant.text") {
      if (str(p.text).trim() && lastText.get(str(p.itemId)) === seq) items.push({ seq, role: "assistant", text: `Assistant: ${clip(str(p.text), MESSAGE_CHARS)}` });
    } else if (e.type === "tool.call") {
      const item: Item = { seq, role: "work", text: `Tool: ${clip(str(p.title) || str(p.name), 200)}` };
      calls.set(str(p.itemId), item);
      items.push(item);
    } else if (e.type === "tool.result") {
      const call = calls.get(str(p.itemId));
      const out = str(p.text).trim();
      const ok = p.ok !== false;
      if (call && (out || !ok)) call.text += `\n  ${ok ? "→" : "failed:"} ${clip(out, OUTPUT_CHARS).replace(/\n/g, "\n    ")}`;
    } else if (e.type === "edit.diff") {
      // Once per file per edit: the same file edited again later shows again.
      const key = `${str(p.itemId)}:${str(p.path)}`;
      if (edited.has(key)) continue;
      edited.add(key);
      items.push({ seq, role: "work", text: `Edited: ${str(p.path)}` });
    } else if (e.type === "turn.completed" && (p.outcome === "failed" || p.outcome === "timed_out") && str(p.error)) {
      items.push({ seq, role: "work", text: `Error: ${clip(str(p.error), 500)}` });
    }
  }
  return items;
}

// The items that fit in `budget` characters, in the order they happened,
// and how many were left out.
export function selectHistory(items: Item[], budget = HANDOFF_BUDGET): { lines: string[]; omitted: number } {
  const picked = new Set<Item>();
  let left = budget;
  const take = (item: Item | undefined) => {
    if (!item || picked.has(item)) return true;
    const cost = item.text.length + 2;
    if (cost > left) return false;
    left -= cost;
    picked.add(item);
    return true;
  };
  const last = (role: Item["role"]) => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].role === role) return items[i];
    return undefined;
  };
  take(last("user"));
  take(last("assistant"));
  take(items.find((i) => i.role === "user"));
  for (let i = items.length - 1; i >= 0; i--) if (!take(items[i])) break;
  // A gap (the first message, then the recent end) is marked, so the
  // model doesn't read two far-apart items as one exchange.
  const lines: string[] = [];
  let gap = false;
  for (const i of items) {
    if (!picked.has(i)) gap = lines.length > 0 || gap;
    else {
      if (gap) lines.push("[…]");
      gap = false;
      lines.push(i.text);
    }
  }
  return { lines, omitted: items.length - picked.size };
}

/**
 * The whole handoff note a fresh session opens with, or "" when there is no
 * history. The history is fenced (N6): it carries tool output and earlier
 * messages, so nothing in it may close the block or pose as instruction.
 */
export function handoffNote(events: HandoffEvent[], skipFromSeq?: number): string {
  const { lines, omitted } = selectHistory(historyItems(events, skipFromSeq));
  if (!lines.length) return "";
  return [
    "This conversation continues in a new agent session; the earlier one could not be resumed.",
    `Recent messages and work${omitted ? ` (${omitted} older item(s) left out)` : ""}:`,
    fenceUntrusted("earlier-session", lines.join("\n"), UNTRUSTED_NOTE),
  ].join("\n");
}
