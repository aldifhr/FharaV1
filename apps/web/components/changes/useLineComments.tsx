"use client";
// Paradev A4 (plan audit/paradev-plan-2026-11-11.md, P-A): line comments on
// the Changes pane. Owns the gutter selection, the open composer, the draft
// mutations and the review round; ChangesPane only spreads `fileProps` onto
// each DiffCard and renders the DraftCommentsBar. Idea from Paradev's
// useDiffCommentComposer/useDiffAnnotations; the code is Fhara's.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import type { ChangesForTask } from "@/api/convex/changes";
import {
  annotationRow,
  parseDiff,
  rangeLabel,
  selectRow,
  selectionBounds,
  selectionRange,
  type LineSelection,
  type SendRefusal,
} from "@/lib/lineComments";
import { matchesChord, useKeybindings } from "@/lib/keybindings";
import { LineComment, LineCommentComposer, type LineCommentRow } from "./LineCommentComposer";

const errorText = (err: unknown) => (err instanceof Error ? err.message.replace(/^.*Uncaught Error: /s, "").split("\n")[0] : "Please try again.");

export function useLineComments(taskId: string, view: ChangesForTask | null | undefined) {
  const bindings = useKeybindings();
  const comments = useQuery(api.diffComments.listForTask, { taskId: taskId as any }) as LineCommentRow[] | undefined;
  const addDraft = useMutation(api.diffComments.addDraft);
  const editDraft = useMutation(api.diffComments.editDraft);
  const deleteDraft = useMutation(api.diffComments.deleteDraft);
  const sendRound = useMutation(api.diffComments.sendRound);
  const [selection, setSelection] = useState<LineSelection | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [lastRound, setLastRound] = useState<number | null>(null);
  const [refusal, setRefusal] = useState<SendRefusal | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const source = view?.source === "branch" ? "branch" : "proposed";
  // The same HEAD listForTask compares against, so a new draft is never outdated.
  const anchorSha = view?.source === "branch" ? (view.pr?.headSha ?? view.commit?.sha) : undefined;
  const commentable = view?.source === "branch" || view?.source === "proposed";
  const visible = useMemo(() => (comments ?? []).filter((c) => c.status === "draft" || c.status === "sent"), [comments]);
  const draftCount = visible.filter((c) => c.status === "draft").length;

  const closeComposer = useCallback(() => {
    setSelection(null);
    setEditingId(null);
    setComposerError(null);
  }, []);

  const send = useCallback(async () => {
    if (sending || draftCount === 0) return;
    setSending(true);
    setRefusal(null);
    setSendError(null);
    try {
      const res = await sendRound({ taskId: taskId as any });
      if (res.sent) setLastRound(res.round);
      else setRefusal(res.reason);
    } catch (err) {
      setSendError(errorText(err));
    } finally {
      setSending(false);
    }
  }, [sending, draftCount, sendRound, taskId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchesChord(e, bindings.sendRound)) return;
      e.preventDefault();
      void send();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bindings.sendRound, send]);

  const guarded = async (fn: () => Promise<unknown>, onDone?: () => void) => {
    setBusy(true);
    setComposerError(null);
    try {
      await fn();
      onDone?.();
    } catch (err) {
      setComposerError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  /** Props for one file's DiffCard: gutter selection, highlight and the comments under their lines. */
  const fileProps = (path: string, oldPath: string | undefined, diff: string) => {
    if (!commentable) return {};
    const rows = parseDiff(diff);
    const byRow = new Map<number, LineCommentRow[]>();
    for (const c of visible) {
      if (c.path !== path) continue;
      const at = annotationRow(rows, c);
      byRow.set(at, [...(byRow.get(at) ?? []), c]);
    }
    const sel = selection?.path === path ? selection : null;
    const range = sel ? selectionRange(rows, sel) : null;
    const addNew = (body: string) => {
      if (!range) return;
      void guarded(
        () =>
          addDraft({
            taskId: taskId as any,
            path,
            ...(oldPath && oldPath !== path ? { oldPath } : {}),
            side: range.side,
            startLine: range.startLine,
            endLine: range.endLine,
            body,
            source,
            ...(anchorSha ? { anchorSha } : {}),
          }),
        () => {
          closeComposer();
          setLastRound(null);
          setRefusal(null);
        }
      );
    };
    const renderAnnotation = (index: number): ReactNode => {
      const here = byRow.get(index) ?? [];
      const composer = Boolean(range && range.endIndex === index);
      if (!here.length && !composer) return null;
      return (
        <div className="divide-y divide-line">
          {here.map((c) =>
            editingId === c._id ? (
              <LineCommentComposer
                key={c._id}
                label={`${path} ${rangeLabel(c)}`}
                initialBody={c.body}
                submitLabel="Save"
                busy={busy}
                error={composerError}
                onCancel={closeComposer}
                onSubmit={(body) => void guarded(() => editDraft({ commentId: c._id as any, body }), closeComposer)}
              />
            ) : (
              <LineComment
                key={c._id}
                comment={c}
                busy={busy}
                onEdit={() => {
                  setSelection(null);
                  setEditingId(c._id);
                }}
                onDelete={() => void guarded(() => deleteDraft({ commentId: c._id as any }))}
              />
            )
          )}
          {composer && range && sel && (
            <LineCommentComposer
              key={`new:${sel.anchor}:${sel.focus}`}
              label={`${path} ${rangeLabel(range)}`}
              busy={busy}
              error={composerError}
              onCancel={closeComposer}
              onSubmit={addNew}
            />
          )}
        </div>
      );
    };
    return {
      onLineClick: (index: number, shift: boolean) => {
        setEditingId(null);
        setComposerError(null);
        setSelection((prev) => selectRow(prev, path, index, shift));
      },
      selectedRange: sel ? selectionBounds(sel) : null,
      renderAnnotation,
    };
  };

  return { fileProps, draftCount, sending, lastRound, refusal, sendError, send };
}
