"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import { relativeTime } from "@/lib/runFormat";
import { MEMORY_CONTENT_MAX, MEMORY_TITLE_MAX, type MemoryScope } from "@/api/convex/lib/memory";

/**
 * Plan L5: memories the team suggested after a task. Nothing is saved until
 * you accept; an accepted new memory starts unpinned (added only when it
 * matches a task). Accepting a "forget" deletes a memory, so it confirms.
 */

type Suggestion = {
  _id: string;
  taskId: string;
  op: "add" | "update" | "forget";
  title: string;
  content: string;
  reason?: string;
  createdAt: number;
};

const OP_LABEL: Record<Suggestion["op"], string> = { add: "New", update: "Update", forget: "Forget" };

const field =
  "w-full rounded-lg border border-line bg-transparent px-3 py-2 text-[13px] text-ink outline-none transition focus:border-ink-3";
const quiet = "rounded-lg px-2.5 py-1 text-[12.5px] text-ink-2 transition hover:bg-hover hover:text-ink disabled:opacity-40";

export default function MemorySuggestions({ scope, projectId }: { scope: MemoryScope; projectId?: string }) {
  const rows = useQuery(
    api.memorySuggestions.list,
    scope === "agent" || (scope === "project" && !projectId)
      ? "skip"
      : { scope, ...(scope === "project" ? { projectId: projectId as never } : {}) },
  ) as Suggestion[] | undefined;
  if (!rows || rows.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="mb-1 flex items-baseline gap-2 text-[13px] font-medium text-ink-2">
        Suggested
        <span className="tabular-nums text-ink-3">{rows.length}</span>
      </h2>
      <p className="mb-2 text-[12.5px] text-ink-3">
        Proposed by the team after a task. Nothing is saved until you accept; new memories start unpinned.
      </p>
      <ul className="divide-y divide-line border-y border-line">
        {rows.map((row) => (
          <SuggestionRow key={row._id} row={row} />
        ))}
      </ul>
    </section>
  );
}

function SuggestionRow({ row }: { row: Suggestion }) {
  const accept = useMutation(api.memorySuggestions.accept);
  const reject = useMutation(api.memorySuggestions.reject);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(row.title);
  const [content, setContent] = useState(row.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const doAccept = () =>
    run(() =>
      accept({
        suggestionId: row._id as never,
        ...(editing && row.op !== "forget" ? { title, content } : {}),
      }),
    );

  return (
    <li className="py-3 text-[12.5px]">
      <div className="flex items-baseline gap-3">
        <span className="w-14 shrink-0 text-ink-3">{OP_LABEL[row.op]}</span>
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="grid gap-2">
              <input
                aria-label="Title"
                value={title}
                maxLength={MEMORY_TITLE_MAX}
                onChange={(e) => setTitle(e.target.value)}
                className={field}
              />
              <textarea
                aria-label="Content"
                value={content}
                maxLength={MEMORY_CONTENT_MAX}
                rows={4}
                onChange={(e) => setContent(e.target.value)}
                className={`${field} resize-y font-mono leading-relaxed`}
              />
            </div>
          ) : (
            <>
              <p className="break-words text-[13.5px] font-medium text-ink">{row.title}</p>
              {row.op !== "forget" && <p className="mt-0.5 whitespace-pre-wrap break-words text-ink-2">{row.content}</p>}
            </>
          )}
          <p className="mt-1 text-[12px] text-ink-3">
            {row.reason ? `${row.reason} · ` : ""}
            <Link href={`/runs/${row.taskId}`} className="hover:text-ink">
              From a task
            </Link>{" "}
            · {relativeTime(row.createdAt)}
          </p>
          {error && (
            <p role="alert" className="mt-1 text-[12.5px] text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              row.op === "forget"
                ? setConfirm({ title: "Forget this memory?", message: `"${row.title}" will be deleted. Agents won't see it again.`, confirmLabel: "Forget" })
                : void doAccept()
            }
            className={`${quiet} text-ink`}
          >
            {editing ? "Save" : "Accept"}
          </button>
          {row.op !== "forget" && !editing && (
            <button type="button" disabled={busy} onClick={() => setEditing(true)} className={quiet}>
              Edit
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => (editing ? setEditing(false) : void run(() => reject({ suggestionId: row._id as never })))}
            className={quiet}
          >
            {editing ? "Cancel" : "Reject"}
          </button>
        </div>
      </div>
      <ConfirmDialog
        request={confirm}
        pending={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          await doAccept();
          setConfirm(null);
        }}
      />
    </li>
  );
}
