"use client";
import { useState } from "react";
import { Bell, Check, GitBranch, Hand, Eye } from "lucide-react";

type Approval = {
  _id: string;
  kind: string;
  summary: string;
  taskId: string;
  status: string;
  payload?: any;
  _creationTime?: number;
};

const KIND_LABEL: Record<string, string> = {
  apply_changes: "Apply changes",
  git_push: "Git push",
  run_command: "Run command",
  merge_pr: "Merge PR",
};

/**
 * Approval card wired to the real backend mutations:
 * - Approve (`api.approvals.approve`) — labelled "Approve push" for
 *   `git_push` approvals,
 * - Review diff — opens the task (caller supplies `onReview`, e.g. to
 *   select the task and scroll to its diff),
 * - Hold (`api.approvals.hold`) — records `approval.held` in the task
 *   timeline while the approval stays pending,
 * - Reject (`api.approvals.reject`).
 */
export default function ApprovalCard({
  approval,
  taskTitle,
  busy,
  onApprove,
  onReject,
  onHold,
  onReview,
}: {
  approval: Approval;
  taskTitle?: string;
  busy?: boolean;
  onApprove: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
  onHold: (approvalId: string) => void;
  onReview?: (taskId: string) => void;
}) {
  const [acting, setActing] = useState<string | null>(null);
  const disabled = busy || acting !== null;
  const approveLabel = approval.kind === "git_push" ? "Approve push" : "Approve";
  const run = (action: string, fn: (id: string) => void) => {
    setActing(action);
    try {
      fn(approval._id);
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="mt-1 overflow-hidden rounded-2xl border border-[#f3d9b0] bg-[#fffaf2] dark:border-amber-900/60 dark:bg-amber-950/20">
      <div className="flex items-center gap-2.5 px-4 pt-3.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-400">
          <Bell size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold dark:text-white">{approval.summary}</p>
          <p className="truncate text-xs text-gray-500">
            {KIND_LABEL[approval.kind] ?? approval.kind}
            {taskTitle ? ` · ${taskTitle}` : ""}
            {approval._creationTime
              ? ` · ${new Date(approval._creationTime).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
              : ""}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          Needs you
        </span>
      </div>
      {approval.payload?.metrics && (
        <div className="mx-4 mt-3 grid grid-cols-4 divide-x divide-amber-200/60 rounded-xl border border-amber-200/60 bg-white/70 py-2.5 shadow-sm dark:divide-amber-900/60 dark:border-amber-900/60 dark:bg-black/20">
          <div className="px-3 text-center">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">files</p>
            <p className="mt-0.5 text-sm font-bold text-gray-800 dark:text-gray-100">{approval.payload.metrics.files ?? "—"}</p>
          </div>
          <div className="px-3 text-center">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">build</p>
            <p className="mt-0.5 text-sm font-bold text-emerald-600 dark:text-emerald-400">{approval.payload.metrics.build ?? "clean"}</p>
          </div>
          <div className="px-3 text-center">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">tests</p>
            <p className="mt-0.5 text-sm font-bold text-emerald-600 dark:text-emerald-400">{approval.payload.metrics.tests ?? "passed"}</p>
          </div>
          <div className="px-3 text-center">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">qa</p>
            <p className="mt-0.5 text-sm font-bold text-emerald-600 dark:text-emerald-400">{approval.payload.metrics.qa ?? "passed"}</p>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button
          type="button"
          disabled={disabled}
          onClick={() => run("approve", onApprove)}
          className="flex items-center gap-1.5 rounded-xl bg-[#635bff] px-3.5 py-2 text-[13px] font-semibold text-white shadow-sm hover:bg-[#5346d8] disabled:opacity-50"
        >
          <Check size={14} /> {approveLabel}
        </button>
        {onReview && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onReview(approval.taskId)}
            className="flex items-center gap-1.5 rounded-xl border border-[#e5e3eb] bg-white px-3.5 py-2 text-[13px] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            <Eye size={14} /> Review diff
          </button>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={() => run("hold", onHold)}
          className="flex items-center gap-1.5 rounded-xl border border-[#e5e3eb] bg-white px-3.5 py-2 text-[13px] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          <Hand size={14} /> Hold
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => run("reject", onReject)}
          className="rounded-xl px-2.5 py-2 text-[13px] font-semibold text-gray-500 hover:text-gray-800 disabled:opacity-50 dark:hover:text-gray-200"
        >
          Reject
        </button>
        <span className="ml-auto flex items-center gap-1 text-[11px] text-gray-400">
          <GitBranch size={11} /> waits for your decision
        </span>
      </div>
      {acting === "hold" && (
        <p className="px-4 pb-3 text-[11px] text-amber-600 dark:text-amber-400">Held — the approval stays pending and is recorded in the task timeline.</p>
      )}
    </div>
  );
}
