"use client";
import { useState } from "react";
import { Bell, Check, GitBranch, Hand, Eye } from "lucide-react";
import { useToast } from "./Toasts";

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

type Handler = (approvalId: string) => unknown;

/** Colour for a verification metric: green only for a real pass. */
function metricTone(value: unknown): string {
  const v = String(value ?? "").toLowerCase();
  if (v === "passed" || v === "clean" || v === "ok") return "text-emerald-600 dark:text-emerald-400";
  if (v === "failed" || v === "error" || v === "errors") return "text-rose-600 dark:text-rose-400";
  return "text-gray-500 dark:text-gray-400";
}

/**
 * Approval card wired to the real backend mutations:
 * - Approve (`api.approvals.approve`) — labelled "Approve push" for
 *   `git_push` approvals,
 * - Review diff — opens the task (caller supplies `onReview`),
 * - Hold (`api.approvals.hold`) — records `approval.held` in the task
 *   timeline while the approval stays pending,
 * - Reject (`api.approvals.reject`) — asks for a second tap to confirm.
 *
 * Handlers may return a promise; a rejection surfaces as an error toast.
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
  onApprove: Handler;
  onReject: Handler;
  onHold: Handler;
  onReview?: (taskId: string) => void;
}) {
  const toast = useToast();
  const [acting, setActing] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const disabled = busy || acting !== null;
  const approveLabel = approval.kind === "git_push" ? "Approve push" : "Approve";
  const metrics = approval.payload?.metrics as Record<string, unknown> | undefined;

  const run = async (action: string, fn: Handler) => {
    setActing(action);
    setConfirmReject(false);
    try {
      await fn(approval._id);
      setLastAction(action);
    } catch (err) {
      toast("error", `Couldn't ${action} this request`, err instanceof Error ? err.message : "Please try again.");
    } finally {
      setActing(null);
    }
  };

  const metricCell = (label: string, value: unknown, neutral = false) => (
    <div className="px-3 text-center">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{label}</p>
      <p
        className={`mt-0.5 text-sm font-bold ${neutral ? "text-gray-800 dark:text-gray-100" : metricTone(value)}`}
        title={value == null ? "No result reported for this check" : undefined}
      >
        {value == null || value === "" ? "not run" : String(value)}
      </p>
    </div>
  );

  const btnBase =
    "flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-[13px] font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-[#635bff]/50 focus-visible:ring-offset-2 disabled:opacity-50 dark:focus-visible:ring-offset-gray-900";
  const btnSecondary = `${btnBase} border border-[#e5e3eb] bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800`;

  return (
    <div className="mt-1 overflow-hidden rounded-xl border border-[#f3d9b0] bg-[#fffaf2] dark:border-amber-900/60 dark:bg-amber-950/20">
      <div className="flex items-center gap-2.5 px-4 pt-3.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-400">
          <Bell size={16} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold dark:text-white">{approval.summary}</p>
          <p className="truncate text-xs text-gray-500 dark:text-gray-400">
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
      {metrics && (
        // Only show what the worker actually reported: a missing check reads
        // "not run" in neutral grey, never a green "passed".
        <div className="mx-4 mt-3 grid grid-cols-4 divide-x divide-amber-200/60 rounded-xl border border-amber-200/60 bg-white/70 py-2.5 shadow-sm dark:divide-amber-900/60 dark:border-amber-900/60 dark:bg-black/20">
          {metricCell("files", metrics.files ?? "—", true)}
          {metricCell("build", metrics.build)}
          {metricCell("tests", metrics.tests)}
          {metricCell("qa", metrics.qa)}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button
          type="button"
          disabled={disabled}
          onClick={() => void run("approve", onApprove)}
          className={`${btnBase} bg-[#635bff] text-white shadow-sm hover:bg-[#5346d8]`}
        >
          <Check size={14} aria-hidden="true" /> {acting === "approve" ? "Approving…" : approveLabel}
        </button>
        {onReview && (
          <button type="button" disabled={disabled} onClick={() => onReview(approval.taskId)} className={btnSecondary}>
            <Eye size={14} aria-hidden="true" /> Review diff
          </button>
        )}
        <button type="button" disabled={disabled} onClick={() => void run("hold", onHold)} className={btnSecondary}>
          <Hand size={14} aria-hidden="true" /> Hold
        </button>
        {confirmReject ? (
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={disabled}
              onClick={() => void run("reject", onReject)}
              className={`${btnBase} bg-red-600 text-white hover:bg-red-700`}
            >
              Confirm reject
            </button>
            <button
              type="button"
              onClick={() => setConfirmReject(false)}
              className="rounded-xl px-2.5 py-2 text-[13px] font-semibold text-gray-500 outline-none hover:text-gray-800 focus-visible:ring-2 focus-visible:ring-[#635bff]/50 dark:text-gray-400 dark:hover:text-gray-200"
            >
              Keep
            </button>
          </span>
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setConfirmReject(true)}
            className="rounded-xl px-2.5 py-2 text-[13px] font-semibold text-gray-500 outline-none hover:text-gray-800 focus-visible:ring-2 focus-visible:ring-[#635bff]/50 disabled:opacity-50 dark:text-gray-400 dark:hover:text-gray-200"
          >
            Reject
          </button>
        )}
        <span className="ml-auto flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
          <GitBranch size={11} aria-hidden="true" /> waits for your decision
        </span>
      </div>
      {acting === null && lastAction === "hold" && (
        <p role="status" className="px-4 pb-3 text-[11px] text-amber-700 dark:text-amber-400">
          Held. The approval stays pending and is recorded in the task timeline.
        </p>
      )}
      {acting !== null && (
        <p role="status" className="px-4 pb-3 text-[11px] text-gray-500 dark:text-gray-400">Processing your decision…</p>
      )}
    </div>
  );
}
