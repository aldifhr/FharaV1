
import { useState } from "react";
import { Link } from "@/lib/spaRouter";
import { useMutation, useQuery } from "@fhara/runtime/react";
import { Sparkles } from "lucide-react";
import { api } from "@fhara/runtime/api";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import { StatusTag, type StatusTone } from "@/components/ui/status-tag";
import { relativeTime } from "@/lib/runFormat";
import { MEMORY_CONTENT_MAX, MEMORY_TITLE_MAX, type MemoryScope } from "@/api/functions/lib/memory";

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
const OP_TONE: Record<Suggestion["op"], StatusTone> = { add: "active", update: "neutral", forget: "danger" };

const field =
  "w-full rounded-lg border border-line bg-transparent px-3 py-2 text-[13px] text-ink outline-none transition focus:border-ink-3";
const quiet = "h-7 rounded-field border border-line bg-panel px-2.5 text-[12px] text-ink-2 transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40";

export default function MemorySuggestions({ scope, projectId }: { scope: MemoryScope; projectId?: string }) {
  const rows = useQuery(
    api.memorySuggestions.list,
    scope === "agent" || (scope === "project" && !projectId)
      ? "skip"
      : { scope, ...(scope === "project" ? { projectId: projectId as never } : {}) },
  ) as Suggestion[] | undefined;
  if (!rows || rows.length === 0) return null;
  return (
    <section className="mt-4 overflow-hidden rounded-2xl border border-line bg-panel shadow-card" aria-label="Suggested memories">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-inset text-ink-3"><Sparkles size={14} /></span>
          <div>
            <h2 className="text-[13.5px] font-medium text-ink">Suggested</h2>
            <p className="mt-0.5 text-[12px] text-ink-3">Proposed after a task · nothing saved until you accept</p>
          </div>
        </div>
        <span className="text-[12px] tabular-nums text-ink-3">{rows.length} pending</span>
      </div>
      <ul className="divide-y divide-line">
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
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1 max-sm:basis-full">
        <div className="flex flex-wrap items-center gap-2">
          <StatusTag tone={OP_TONE[row.op]}>{OP_LABEL[row.op]}</StatusTag>
          <span className="text-[12px] tabular-nums text-ink-3">{relativeTime(row.createdAt)}</span>
        </div>
        {editing ? (
          <div className="mt-2 grid gap-2">
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
          <div className="mt-2">
            <p className="break-words text-[13.5px] font-medium text-ink">{row.title}</p>
            {row.op !== "forget" && <p className="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] text-ink-2">{row.content}</p>}
          </div>
        )}
        <p className="mt-1 text-[12px] text-ink-3">
          {row.reason ? `${row.reason} · ` : ""}
          <Link href={`/runs/${row.taskId}`} className="underline decoration-line underline-offset-2 transition hover:text-ink">
            From a task
          </Link>
        </p>
        {error && (
          <p role="alert" className="mt-1 text-[12.5px] text-danger">
            {error}
          </p>
        )}
      </div>
      <div className="ml-auto flex shrink-0 gap-1.5">
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
