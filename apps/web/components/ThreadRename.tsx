"use client";

import { Pencil } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { useMutation } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import type { Id } from "@/api/convex/_generated/dataModel";
import { renameDraft, withRenamedRow, type RenameRef } from "@/lib/threadRename";
import { useToast } from "./Toasts";

/**
 * Rename everywhere (Paradev B3): one mutation (`threads.rename`), one input.
 * The sidebar row, the task header and the chat header all use these. The
 * new title shows at once in every open view (optimistic update on the
 * thread list, the task and the active conversation), and a failed save
 * rolls back with a toast. Rename is not destructive, so nothing confirms.
 */
export function useRenameThread() {
  const toast = useToast();
  const rename = useMutation(api.threads.rename).withOptimisticUpdate((store, args) => {
    const title = args.title.replace(/\s+/g, " ").trim();
    const ref: RenameRef | null = args.taskId
      ? { taskId: String(args.taskId) }
      : args.conversationId
        ? { conversationId: String(args.conversationId) }
        : null;
    if (!title || !ref) return;
    for (const { args: listArgs, value } of store.getAllQueries(api.threads.list)) {
      if (Array.isArray(value)) store.setQuery(api.threads.list, listArgs, withRenamedRow(value as any[], ref, title) as any);
    }
    if (args.taskId) {
      const task = store.getQuery(api.tasks.get, { taskId: args.taskId });
      if (task) store.setQuery(api.tasks.get, { taskId: args.taskId }, { ...task, title });
    }
    if (args.conversationId) {
      for (const { args: activeArgs, value } of store.getAllQueries(api.conversations.getActive)) {
        if (value && String(value.conversation._id) === String(args.conversationId)) {
          store.setQuery(api.conversations.getActive, activeArgs, { ...value, conversation: { ...value.conversation, title } });
        }
      }
    }
  });
  return async (ref: RenameRef, title: string): Promise<boolean> => {
    try {
      await rename("taskId" in ref ? { taskId: ref.taskId as Id<"tasks">, title } : { conversationId: ref.conversationId as Id<"conversations">, title });
      return true;
    } catch (err) {
      toast("error", "Rename failed", err instanceof Error ? err.message : undefined);
      return false;
    }
  };
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

/**
 * The inline rename field. Enter saves, Esc cancels, leaving the field saves
 * (or cancels when the text is blank). An empty or whitespace title is
 * refused with a note and the field stays open.
 */
export function RenameInput({
  value,
  label,
  onSave,
  onDone,
  className = "",
}: {
  value: string;
  label: string;
  onSave: (title: string) => Promise<boolean>;
  onDone: () => void;
  className?: string;
}) {
  const [text, setText] = useState(value);
  const [empty, setEmpty] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = () => {
    settled.current = true;
    onDone();
  };

  const submit = (fromBlur: boolean) => {
    if (settled.current) return;
    const draft = renameDraft(text, value);
    if (draft.kind === "empty") {
      if (fromBlur) return finish();
      setEmpty(true);
      return;
    }
    finish();
    if (draft.kind === "save") void onSave(draft.title);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      submit(false);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish();
    }
  };

  return (
    <span className="block min-w-0" onClick={(e) => (e.preventDefault(), e.stopPropagation())} onMouseDown={stop} onDoubleClick={stop}>
      <input
        ref={inputRef}
        value={text}
        aria-label={label}
        aria-invalid={empty || undefined}
        maxLength={400}
        onChange={(e) => {
          setText(e.target.value);
          if (empty) setEmpty(false);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => submit(true)}
        className={`w-full min-w-0 rounded-md border bg-panel px-1.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${empty ? "border-ink" : "border-line"} ${className}`}
      />
      {empty && (
        <span role="alert" className="mt-0.5 block text-[12px] text-ink-2">
          A title can’t be empty.
        </span>
      )}
    </span>
  );
}

/**
 * A header title the user can rename: double-click it, or use the pencil
 * that shows on hover and focus. Used by the task header and the chat header.
 */
export function EditableTitle({
  title,
  renameRef,
  label,
  className = "",
}: {
  title: string;
  renameRef: RenameRef | null;
  /** "task" or "chat", for the field and button labels. */
  label: string;
  className?: string;
}) {
  const rename = useRenameThread();
  const [editing, setEditing] = useState(false);
  if (editing && renameRef) {
    return (
      <RenameInput
        value={title}
        label={`Rename ${label}`}
        onSave={(next) => rename(renameRef, next)}
        onDone={() => setEditing(false)}
        className={`h-7 ${className}`}
      />
    );
  }
  return (
    <span className="group/title flex min-w-0 items-center gap-1">
      <span
        className={`min-w-0 truncate ${className}`}
        title={renameRef ? `${title} (double-click to rename)` : title}
        onDoubleClick={renameRef ? () => setEditing(true) : undefined}
      >
        {title}
      </span>
      {renameRef && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label={`Rename ${label}`}
          title={`Rename ${label}`}
          className="shrink-0 rounded-md p-1 text-ink-3 opacity-0 outline-none transition hover:bg-hover hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-brand/40 group-hover/title:opacity-100"
        >
          <Pencil size={13} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
