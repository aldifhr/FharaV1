"use client";
// Paradev A4 (plan audit/paradev-plan-2026-11-11.md, P-A): the footer of the
// Changes pane that holds the draft count and sends every draft as one
// review round. Refusals are shown as plain sentences, never as a badge.
import { draftCountText, refusalText, sendLabel, sentText, type SendRefusal } from "@/lib/lineComments";

type Props = {
  draftCount: number;
  sending: boolean;
  /** The round this pane sent last (shown until a new draft is added). */
  lastRound: number | null;
  refusal: SendRefusal | null;
  error?: string | null;
  onSend: () => void;
};

export default function DraftCommentsBar({ draftCount, sending, lastRound, refusal, error, onSend }: Props) {
  if (draftCount === 0 && lastRound == null && !refusal && !error) return null;
  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-panel px-4 py-2.5" data-testid="draft-comments-bar">
      <span className="text-[13px] text-ink" data-testid="draft-count" aria-live="polite">
        {draftCount === 0 && lastRound != null ? sentText(lastRound) : draftCountText(draftCount)}
      </span>
      {draftCount > 0 && lastRound != null && <span className="text-[12px] text-ink-3">{sentText(lastRound)}</span>}
      {(refusal || error) && (
        <span className="basis-full text-[12.5px] text-ink-2 sm:basis-auto" role="alert">
          {refusal ? refusalText(refusal) : error}
        </span>
      )}
      {draftCount > 0 && (
        <button
          type="button"
          onClick={onSend}
          disabled={sending}
          title="Sends every draft as one review round (Mod+Shift+Enter)"
          className="ml-auto rounded-lg bg-ink px-3 py-1.5 text-[12.5px] font-medium text-canvas disabled:opacity-50"
        >
          {sending ? "Sending…" : sendLabel(draftCount)}
        </button>
      )}
    </div>
  );
}
