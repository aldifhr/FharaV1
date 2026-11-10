"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { GitBranch, Trash2 } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import IconRail from "@/components/IconRail";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toasts";
import { roleLabel } from "@/lib/agentRoles";
import { taskStatusLabel } from "@/lib/taskStatus";
import { formatDuration, formatTokens, relativeTime, statusDot } from "@/lib/runFormat";

/**
 * Runs: every task as an execution run, newest first, across projects
 * (or one project with `?project=<id>`). A row opens its trace.
 */
function RunsPage() {
  const projectId = useSearchParams().get("project") ?? undefined;
  const data = useQuery(api.runs.list, projectId ? { projectId: projectId as never, limit: 50 } : { limit: 50 });
  const removeTask = useMutation(api.tasks.remove);
  const toast = useToast();
  const [confirm, setConfirm] = useState<(ConfirmRequest & { run: () => Promise<void> }) | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const runs = data?.runs;
  const active = runs?.filter((r) => r.status === "running" || r.status === "queued").length ?? 0;
  const failed = runs?.filter((r) => r.status === "failed").length ?? 0;

  const deleteRun = (taskId: string, title: string) => {
    setConfirm({
      title: `Delete run "${title}"?`,
      message: "This run and all of its history will be deleted permanently.",
      confirmLabel: "Delete run",
      run: async () => {
        setDeleting(taskId);
        try {
          await removeTask({ taskId: taskId as never });
          toast("success", "Run deleted", title);
          setConfirm(null);
        } catch (err) {
          toast("error", "Failed to delete run", err instanceof Error ? err.message : "Failed to delete run");
        } finally {
          setDeleting(null);
        }
      },
    });
  };

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail projectId={projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-3xl">
          <header>
            {data?.projectName && <p className="truncate text-[13px] text-ink-3">{data.projectName}</p>}
            <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Runs</h1>
            <p className="mt-1 text-[15px] text-ink-2">
              {runs === undefined
                ? "Loading…"
                : runs.length === 0
                  ? "No runs yet"
                  : `${runs.length} recent ${runs.length === 1 ? "run" : "runs"}${active ? ` · ${active} running` : ""}${failed ? ` · ${failed} failed` : ""}`}
            </p>
            {projectId && (
              <Link href="/runs" className="mt-1 inline-block text-[13px] text-ink-3 hover:text-ink">
                Show all projects
              </Link>
            )}
          </header>

          {runs === undefined ? (
            <div className="mt-10 space-y-3" aria-label="Loading runs">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-xl bg-hover" />
              ))}
            </div>
          ) : runs.length === 0 ? (
            <div className="mt-16 flex flex-col items-center text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-hover text-ink-3">
                <GitBranch size={18} />
              </span>
              <p className="mt-4 text-[14px] text-ink-2">No runs yet.</p>
              <p className="mt-1 text-[13px] text-ink-3">Each task the team works on shows up here with its full trace.</p>
            </div>
          ) : (
            <ul className="mt-8 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
              {runs.map((r) => {
                const tokens = r.inputTokens + r.outputTokens;
                const meta = [
                  projectId ? null : r.projectName,
                  r.roles.length ? r.roles.map(roleLabel).join(", ") : null,
                  r.durationMs !== null ? formatDuration(r.durationMs) : taskStatusLabel(r.status),
                  tokens ? `${r.tokensEstimated ? "≈" : ""}${formatTokens(tokens)} tok` : null,
                  r.subtasksTotal ? `${r.subtasksDone}/${r.subtasksTotal} steps` : null,
                  r.errorCount ? `${r.errorCount} ${r.errorCount === 1 ? "error" : "errors"}` : null,
                ].filter(Boolean);
                return (
                  <li key={r.taskId} className="flex items-center">
                    <Link href={`/runs/${r.taskId}`} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 transition hover:bg-hover">
                      <span
                        title={taskStatusLabel(r.status)}
                        aria-label={taskStatusLabel(r.status)}
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(r.status)}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px]">{r.title}</p>
                        <p className="truncate text-[12.5px] text-ink-3">{meta.join(" · ")}</p>
                      </div>
                      <span className="shrink-0 text-[12.5px] tabular-nums text-ink-3">{relativeTime(r.createdAt)}</span>
                    </Link>
                    <button
                      type="button"
                      aria-label={`Delete run ${r.title}`}
                      title={r.status === "running" ? "Running runs can't be deleted" : "Delete run"}
                      disabled={r.status === "running" || deleting === r.taskId}
                      onClick={() => deleteRun(r.taskId, r.title)}
                      className="mr-3 shrink-0 rounded-lg p-2 text-ink-3 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-40"
                    >
                      <Trash2 size={16} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </main>
      <ConfirmDialog
        request={confirm}
        pending={deleting !== null}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void confirm?.run()}
      />
    </div>
  );
}

export default function RunsPageWrapper() {
  return (
    <Suspense fallback={null}>
      <RunsPage />
    </Suspense>
  );
}
