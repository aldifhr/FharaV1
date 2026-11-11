"use client";
// Paradev A4 (plan audit/paradev-plan-2026-11-11.md, P-A): the inline line
// comment composer and one comment as it shows under its diff line. Idea
// from Paradev's AgentCommentComposer; markup and keys are Fhara's.
import { useEffect, useRef, useState } from "react";
import { commentStatusText, composerKeyAction, rangeLabel, type CommentSide } from "@/lib/lineComments";

type ComposerProps = {
  /** "a.ts L3-L5": what the comment is anchored to. */
  label: string;
  initialBody?: string;
  submitLabel?: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (body: string) => void;
  onCancel: () => void;
};

export function LineCommentComposer({ label, initialBody = "", submitLabel = "Add comment", busy, error, onSubmit, onCancel }: ComposerProps) {
  const [body, setBody] = useState(initialBody);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const submit = () => {
    if (body.trim() && !busy) onSubmit(body.trim());
  };
  return (
    <div className="space-y-2 px-4 py-3" data-testid="line-comment-composer">
      <label className="block text-[12px] text-ink-3" htmlFor="line-comment-body">
        Comment on {label}
      </label>
      <textarea
        id="line-comment-body"
        ref={ref}
        value={body}
        rows={3}
        maxLength={4000}
        placeholder="What should change here?"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          const action = composerKeyAction(
            { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing },
            body
          );
          if (!action) return;
          e.preventDefault();
          e.stopPropagation();
          if (action === "submit") submit();
          else onCancel();
        }}
        className="w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-ink"
      />
      {error && <p className="text-[12.5px] text-ink-2" role="alert">{error}</p>}
      <div className="flex items-center gap-2">
        <span className="mr-auto text-[11.5px] text-ink-3">⌘/Ctrl+Enter adds it; Esc closes an empty comment</span>
        <button type="button" onClick={onCancel} className="rounded-lg px-2.5 py-1 text-[12.5px] text-ink-2 hover:bg-hover hover:text-ink">
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !body.trim()}
          className="rounded-lg bg-ink px-2.5 py-1 text-[12.5px] font-medium text-canvas disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

export type LineCommentRow = {
  _id: string;
  path: string;
  side: CommentSide;
  startLine: number;
  endLine: number;
  body: string;
  status: string;
  round?: number;
  outdated?: boolean;
};

type CommentProps = {
  comment: LineCommentRow;
  busy?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
};

/** One comment under its line: body, then a plain status line (Draft, Sent in round N, Outdated). */
export function LineComment({ comment, busy, onEdit, onDelete }: CommentProps) {
  const draft = comment.status === "draft";
  return (
    <div className="space-y-1 px-4 py-2.5" data-testid="line-comment" data-comment-status={comment.status}>
      <p className="whitespace-pre-wrap text-[13px] text-ink">{comment.body}</p>
      <div className="flex items-center gap-3 text-[11.5px] text-ink-3">
        <span>
          {rangeLabel(comment)} · {commentStatusText(comment)}
        </span>
        {draft && onEdit && (
          <button type="button" disabled={busy} onClick={onEdit} className="text-ink-2 hover:text-ink disabled:opacity-50">
            Edit
          </button>
        )}
        {draft && onDelete && (
          <button type="button" disabled={busy} onClick={onDelete} className="text-ink-2 hover:text-ink disabled:opacity-50">
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
