"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import MessageText from "@/components/chat/MessageText";
import { turnFooterText } from "@/lib/threadbear/eventText";
import type { TranscriptRow } from "@/lib/threadbear/types";
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

function Row({ row, actions }: { row: TranscriptRow; actions: RowActions }) {
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
      return <ToolRow row={row} taskId={actions.taskId} turnOpen={actions.turnOpen} />;
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
      return (
        <p className={`border-t border-line pt-1.5 text-[12px] ${row.outcome === "failed" || row.outcome === "timed_out" ? "text-danger" : "text-ink-3"}`}>
          {turnFooterText(row.outcome, row.durationMs, row.error)}
          {row.tokens ? ` · ${row.tokens.toLocaleString()} tokens` : ""}
        </p>
      );
    case "note":
      return <p className={`text-center text-[12px] ${row.tone === "danger" ? "text-danger" : "text-ink-3"}`}>{row.text}</p>;
  }
}

/** The direct-thread transcript, oldest first (rows from lib/threadbear/reducer). */
export default function TranscriptRows({ rows, actions }: { rows: TranscriptRow[]; actions: RowActions }) {
  return (
    <ol className="grid gap-3">
      {rows.map((row) => (
        <li key={row.key} data-seq={row.seq}>
          <Row row={row} actions={actions} />
        </li>
      ))}
    </ol>
  );
}
