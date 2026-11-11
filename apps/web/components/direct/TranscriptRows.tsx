"use client";

import { useMemo, useState } from "react";
import { ChevronRight, RotateCcw } from "lucide-react";
import MessageText from "@/components/chat/MessageText";
import { durationText, turnFooterText } from "@/lib/threadbear/eventText";
import type { PresentedItem } from "@/lib/threadbear/activityFold";
import { presentTranscript } from "@/lib/threadbear/turnFold";
import { collapseRepeatedFailures, retryablePrompt } from "@/lib/threadbear/repeatedFailures";
import type { TranscriptRow, TurnFooterRow } from "@/lib/threadbear/types";
import ToolRow from "./ToolRow";
import DiffRow from "./DiffRow";
import { DirectApprovalCard, DirectQuestionCard } from "./DirectCards";

export type RowActions = {
  taskId: string;
  /** The newest turn is still open (tools without a result are running, not interrupted). */
  turnOpen: boolean;
  closed: boolean;
  onRespond: (approvalId: string, decision: "allow" | "deny") => Promise<unknown>;
  onAnswer: (text: string) => Promise<unknown>;
};

/** What a row needs from the transcript around it. */
type RowContext = {
  /** The outcome of each finished turn by turn id (a tool with no result words its interruption from it). */
  outcomes: ReadonlyMap<string, string>;
  /** The prompt "Retry last prompt" resends, shown on the newest failed footer only. */
  retry: { key: string; prompt: string } | null;
};

const FOLD_BUTTON =
  "flex items-center gap-1.5 rounded-field px-1.5 py-1 text-[13px] text-ink-3 outline-none hover:bg-hover hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-ink/30";

function Reasoning({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-[13px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-field px-1.5 py-1 text-ink-3 outline-none hover:bg-hover hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        <ChevronRight size={13} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        {streaming ? "Thinking…" : "Thought"}
      </button>
      {open && <p className="whitespace-pre-wrap pl-6 text-[12.5px] leading-5 text-ink-3">{text}</p>}
    </div>
  );
}

function Row({ row, actions, ctx }: { row: TranscriptRow; actions: RowActions; ctx: RowContext }) {
  switch (row.kind) {
    case "user":
      return (
        <div className="flex flex-col items-end gap-1">
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl bg-inset px-3.5 py-2 text-[14px] text-ink">{row.text}</div>
          {(row.sending || row.steered) && (
            <span className="text-[11.5px] text-ink-3">{row.sending ? "Sending…" : "Joined the running turn"}</span>
          )}
        </div>
      );
    case "assistant":
      return <MessageText content={row.text} isAnimating={row.streaming} size="sm" />;
    case "reasoning":
      return <Reasoning text={row.text} streaming={row.streaming} />;
    case "tool":
      return (
        <ToolRow
          row={row}
          taskId={actions.taskId}
          turnOpen={actions.turnOpen && !(row.turnId && ctx.outcomes.has(row.turnId))}
          turnOutcome={row.turnId ? ctx.outcomes.get(row.turnId) : undefined}
        />
      );
    case "diff":
      return <DiffRow row={row} />;
    case "approval":
      return <DirectApprovalCard row={row} onRespond={actions.onRespond} />;
    case "question":
      return <DirectQuestionCard row={row} onAnswer={actions.onAnswer} disabled={actions.closed} />;
    case "plan":
      return (
        <ul className="grid gap-0.5 rounded-field border border-line px-3 py-2 text-[13px]">
          <li className="text-caption pb-1">Plan</li>
          {row.entries.map((entry, i) => (
            <li key={i} className={entry.status === "completed" ? "text-ink-3 line-through" : entry.status === "in_progress" ? "text-ink" : "text-ink-2"}>
              {entry.text}
            </li>
          ))}
        </ul>
      );
    case "turn":
      return <TurnFooter row={row} actions={actions} retry={ctx.retry?.key === row.key ? ctx.retry.prompt : null} />;
    case "note":
      return <p className={`text-center text-[12px] ${row.tone === "danger" ? "text-danger" : "text-ink-3"}`}>{row.text}</p>;
  }
}

function TurnFooter({ row, actions, retry }: { row: TurnFooterRow; actions: RowActions; retry: string | null }) {
  const [busy, setBusy] = useState(false);
  const failed = row.outcome === "failed" || row.outcome === "timed_out";
  const onRetry = async () => {
    if (!retry) return;
    setBusy(true);
    try {
      await actions.onAnswer(retry);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-1.5 text-[12px]">
      <p className={failed ? "text-danger" : "text-ink-3"}>
        {turnFooterText(row.outcome, row.durationMs, row.error)}
        {row.repeats && row.repeats > 1 ? ` (${row.repeats} turns in a row)` : ""}
        {row.tokens ? ` · ${row.tokens.toLocaleString()} tokens` : ""}
      </p>
      {retry && !actions.closed && (
        <button
          type="button"
          onClick={() => void onRetry()}
          disabled={busy}
          className="flex items-center gap-1 rounded-field px-1.5 py-0.5 text-ink-2 outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50"
        >
          <RotateCcw size={12} />
          {busy ? "Sending…" : "Retry last prompt"}
        </button>
      )}
    </div>
  );
}

function foldLabel(item: Extract<PresentedItem, { kind: "fold" }>): string {
  if (item.fold === "turn") return item.durationMs ? `Worked for ${durationText(item.durationMs)}` : "Worked";
  const tools = item.rows.filter((r) => r.kind === "tool").length;
  return tools ? `Activity · ${tools} tool call${tools === 1 ? "" : "s"}` : "Activity";
}

/**
 * The direct-thread transcript, oldest first (rows from lib/threadbear/reducer).
 * N8: identical failure-only turns collapse to the latest, a finished turn
 * folds down to its answer, and routine work folds into "Activity" rows.
 * Failures and cards are never folded, and the newest text stays visible.
 */
export default function TranscriptRows({ rows, actions }: { rows: TranscriptRow[]; actions: RowActions }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const shown = useMemo(() => collapseRepeatedFailures(rows), [rows]);
  const items = useMemo(() => presentTranscript(shown), [shown]);
  const ctx = useMemo<RowContext>(() => {
    const outcomes = new Map<string, string>();
    for (const r of shown) if (r.kind === "turn" && r.turnId) outcomes.set(r.turnId, r.outcome);
    const prompt = retryablePrompt(shown, actions.turnOpen);
    const last = shown.at(-1);
    return { outcomes, retry: prompt && last ? { key: last.key, prompt } : null };
  }, [shown, actions.turnOpen]);
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <ol className="grid gap-3">
      {items.map((item) =>
        item.kind === "row" ? (
          <li key={item.row.key} data-seq={item.row.seq}>
            <Row row={item.row} actions={actions} ctx={ctx} />
          </li>
        ) : (
          <li key={item.key} data-seq={item.rows[0]?.seq}>
            <button type="button" onClick={() => toggle(item.key)} aria-expanded={open.has(item.key)} className={FOLD_BUTTON}>
              <ChevronRight size={13} className={`transition-transform ${open.has(item.key) ? "rotate-90" : ""}`} />
              {foldLabel(item)}
            </button>
            {open.has(item.key) && (
              <ol className="mt-2 grid gap-3 border-l border-line pl-3">
                {item.rows.map((row) => (
                  <li key={row.key} data-seq={row.seq}>
                    <Row row={row} actions={actions} ctx={ctx} />
                  </li>
                ))}
              </ol>
            )}
          </li>
        ),
      )}
    </ol>
  );
}
