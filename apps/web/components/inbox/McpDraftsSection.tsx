
import { useState } from "react";
import { useMutation } from "@fhara/runtime/react";
import { ClipboardList } from "lucide-react";
import { Link } from "@/lib/spaRouter";
import { api } from "@fhara/runtime/api";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toasts";

export type McpDraft = {
  _id: string;
  projectId: string;
  projectName: string;
  title: string;
  command: string;
  reason: string;
};

/**
 * ui-g13: task drafts an agent saved through the Fhara MCP `task.create`
 * tool (G12b). Nothing runs until the user starts one: Start makes an
 * ordinary queued task (taskDrafts.start, the Create task path); Discard
 * asks first, then dismisses the draft.
 */
export default function McpDraftsSection({ drafts }: { drafts: McpDraft[] }) {
  const start = useMutation(api.taskDrafts.start);
  const dismiss = useMutation(api.taskDrafts.dismiss);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<McpDraft | null>(null);

  if (drafts.length === 0) return null;

  const startDraft = async (draft: McpDraft) => {
    setBusy(draft._id);
    try {
      await start({ draftId: draft._id as never });
      toast("success", "Task started");
    } catch (err) {
      toast("error", "Couldn't start the task", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const confirmDiscard = async () => {
    if (!discarding) return;
    setBusy(discarding._id);
    try {
      await dismiss({ draftId: discarding._id as never });
      toast("success", "Draft discarded");
      setDiscarding(null);
    } catch (err) {
      toast("error", "Couldn't discard the draft", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-inset text-ink-3">
          <ClipboardList size={14} />
        </span>
        <h3 className="text-[13.5px] font-medium text-ink">Task drafts</h3>
        <span className="ml-auto text-[12px] tabular-nums text-ink-3">{drafts.length}</span>
      </div>
      <ul className="divide-y divide-line">
        {drafts.map((d) => (
          <li key={d._id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-[14px] leading-snug">{d.title}</p>
              <p className="mt-0.5 truncate text-[12.5px] text-ink-3">
                Draft from MCP ·{" "}
                <Link href={`/project/${d.projectId}`} className="hover:text-ink">
                  {d.projectName}
                </Link>
                {d.reason ? ` · ${d.reason}` : ""}
              </p>
              {d.command.trim() && d.command.trim() !== d.title.trim() && (
                <p className="mt-1 line-clamp-2 text-[12.5px] text-ink-2">{d.command}</p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                disabled={busy === d._id}
                onClick={() => setDiscarding(d)}
                className="inline-flex h-8 items-center justify-center rounded-field px-2.5 text-[12.5px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40"
              >
                Discard
              </button>
              <button
                type="button"
                disabled={busy === d._id}
                onClick={() => void startDraft(d)}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-field bg-ink px-2.5 text-[12.5px] font-medium text-canvas outline-none transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40"
              >
                Start
              </button>
            </div>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        request={
          discarding
            ? {
                title: "Discard this draft?",
                message: `“${discarding.title}” will not run. The agent that saved it can create a new draft later.`,
                confirmLabel: "Discard",
              }
            : null
        }
        pending={busy !== null && busy === discarding?._id}
        onCancel={() => setDiscarding(null)}
        onConfirm={() => void confirmDiscard()}
      />
    </section>
  );
}
