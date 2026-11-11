"use client";

import { useState } from "react";
import { PanelCard, PanelCardBody, PanelCardHeader } from "@/components/ui/panel-card";
import { StatusTag, type StatusTone } from "@/components/ui/status-tag";
import { BTN_OUTLINE, BTN_PRIMARY } from "@/components/chat/cards/primitives";
import type { ApprovalRow, ApprovalState, QuestionRow } from "@/lib/threadbear/types";

const KIND_LABEL: Record<string, string> = {
  run_command: "Run command",
  run_unconfined: "Run without the sandbox",
  tool_call: "Tool call",
  apply_changes: "Apply changes",
  git_push: "Git push",
  merge_pr: "Merge PR",
};

const STATE: Record<ApprovalState, { label: string; tone: StatusTone }> = {
  pending: { label: "Needs you", tone: "warn" },
  allowed: { label: "Allowed", tone: "ok" },
  denied: { label: "Denied", tone: "danger" },
  cancelled: { label: "Closed", tone: "neutral" },
};

/**
 * A direct thread's tool-call card (any approval kind, including
 * run_unconfined): the exact input, the reason it asks, Allow / Deny while
 * pending. Typing a message instead declines it with that message (the
 * server does that in directThreads.send).
 */
export function DirectApprovalCard({
  row,
  onRespond,
}: {
  row: ApprovalRow;
  onRespond: (approvalId: string, decision: "allow" | "deny") => Promise<unknown>;
}) {
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const state = STATE[row.state];
  const respond = async (decision: "allow" | "deny") => {
    setBusy(decision);
    try {
      await onRespond(row.approvalId, decision);
    } finally {
      setBusy(null);
    }
  };
  return (
    <PanelCard selected={row.state === "pending"}>
      <PanelCardHeader
        kind={KIND_LABEL[row.approvalKind] ?? "Approval"}
        title={row.title}
        meta={row.reason}
        aside={<StatusTag tone={state.tone}>{state.label}</StatusTag>}
      />
      {row.input && row.input !== row.title && (
        <PanelCardBody>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-ink">{row.input}</pre>
        </PanelCardBody>
      )}
      {row.state === "pending" ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-3.5 py-2.5">
          <button type="button" className={BTN_PRIMARY} disabled={busy !== null} onClick={() => void respond("allow")}>
            {busy === "allow" ? "Allowing…" : "Allow"}
          </button>
          <button type="button" className={BTN_OUTLINE} disabled={busy !== null} onClick={() => void respond("deny")}>
            {busy === "deny" ? "Denying…" : "Deny"}
          </button>
          <span className="text-[12px] text-ink-3">Or type a reply to decline it with your words.</span>
        </div>
      ) : (
        row.message && <p className="border-t border-line px-3.5 py-2 text-[12.5px] text-ink-3">{row.message}</p>
      )}
    </PanelCard>
  );
}

/**
 * The agent's own question (approval.requested {kind: "question"}). The
 * answer is the thread's next message: an option sends its label, or the
 * user types in the composer.
 */
export function DirectQuestionCard({ row, onAnswer, disabled }: { row: QuestionRow; onAnswer: (text: string) => Promise<unknown>; disabled: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const open = row.state === "open";
  const answer = async (text: string) => {
    setBusy(text);
    try {
      await onAnswer(text);
    } finally {
      setBusy(null);
    }
  };
  const meta = open ? (row.answerer === "cto" ? "The CTO is answering this. You can still answer." : row.reason || "Answer below, or pick an option.") : undefined;
  return (
    <PanelCard selected={open}>
      <PanelCardHeader
        kind="Question"
        title={<span className="whitespace-pre-wrap">{row.question || "The agent asked a question"}</span>}
        meta={meta}
        aside={<StatusTag tone={open ? "warn" : "ok"}>{open ? (row.answerer === "cto" ? "With the CTO" : "Needs you") : "Answered"}</StatusTag>}
      />
      {open && row.options.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-line px-3.5 py-2.5">
          {row.options.map((option) => (
            <button key={option} type="button" className={BTN_OUTLINE} disabled={disabled || busy !== null} onClick={() => void answer(option)}>
              {busy === option ? "Sending…" : option}
            </button>
          ))}
        </div>
      )}
      {!open && row.answer && (
        <p className="border-t border-line px-3.5 py-2 text-[12.5px] text-ink-2">
          {row.answeredBy === "cto" ? "The CTO answered: " : "Answer: "}
          {row.answer}
        </p>
      )}
    </PanelCard>
  );
}
