"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import Link from "next/link";
import { api } from "@/api/convex/_generated/api";
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
    <section className="mt-10">
      <h2 className="mb-3 flex items-baseline gap-2 text-[13px] font-medium text-ink-2">
        Task drafts
        <span className="tabular-nums text-ink-3">{drafts.length}</span>
      </h2>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
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
                className="rounded-lg px-3 py-2 text-[13px] text-ink-2 transition hover:bg-hover disabled:opacity-50 sm:px-2.5 sm:py-1"
              >
                Discard
              </button>
              <button
                type="button"
                disabled={busy === d._id}
                onClick={() => void startDraft(d)}
                className="inline-flex items-center gap-1 rounded-lg bg-ink px-3 py-2 text-[13px] font-medium text-canvas transition hover:opacity-90 disabled:opacity-50 sm:px-2.5 sm:py-1"
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
