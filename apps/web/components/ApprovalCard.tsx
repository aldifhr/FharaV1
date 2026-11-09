"use client";
import { useState } from "react";
import { Bell, Check } from "lucide-react";
import { useToast } from "./Toasts";
import {
  BTN_OUTLINE,
  BTN_PRIMARY,
  BTN_TEXT,
  CARD_DIVIDER,
  CardHeader,
  CardShell,
  IconTile,
  MUTED,
  Pill,
  StatusWord,
  type StepStatus,
} from "./chat/cards/primitives";
import { clockTime } from "@/lib/format";
import PlanCard from "./chat/cards/PlanCard";

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
  plan: "Review plan",
};

type Handler = (approvalId: string) => unknown;

/** Verification metric → status word: green only for a real pass. */
function metricStatus(value: unknown): StepStatus {
  const v = String(value ?? "").toLowerCase();
  if (v === "passed" || v === "clean" || v === "ok") return "passed";
  if (v === "failed" || v === "error" || v === "errors") return "failed";
  if (v === "running") return "running";
  return "not_run";
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
/** Plan reviews have their own card (Plan Inspector); everything else renders below. */
export default function ApprovalCard(props: Parameters<typeof GenericApprovalCard>[0]) {
  if (props.approval.kind === "plan") return <PlanCard data={{ taskId: props.approval.taskId }} />;
  return <GenericApprovalCard {...props} />;
}

function GenericApprovalCard({
  approval,
  taskTitle,
  busy,
  onApprove,
  onReject,
  onHold,
  onReview,
  agent,
}: {
  /** Requesting agent, shown in the shared card header when known. */
  agent?: { role?: string } | null;
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
    <div className="min-w-0 px-4 py-3">
      <p className={`text-[12px] ${MUTED}`}>{label}</p>
      <div className="mt-1 truncate text-[15px] font-semibold" title={value == null ? "No result reported for this check" : undefined}>
        {neutral ? (
          <span className="text-ink">{value == null || value === "" ? "—" : String(value)}</span>
        ) : (
          <StatusWord
            status={metricStatus(value)}
            label={value == null || value === "" ? "Not run" : metricStatus(value) === "not_run" ? String(value) : undefined}
          />
        )}
      </div>
    </div>
  );

  const time = approval._creationTime
    ? clockTime(approval._creationTime)
    : null;

  return (
    <CardShell
      className="mt-1 max-w-2xl"
      agent={agent ? { role: agent.role, label: "asks for approval" } : null}
      header={
        <CardHeader
          icon={
            <IconTile tone="orange">
              <Bell size={15} />
            </IconTile>
          }
          title={approval.summary}
          subtitle={[KIND_LABEL[approval.kind] ?? approval.kind, taskTitle, time].filter(Boolean).join(" · ")}
          pill={<Pill tone="orange">Needs you</Pill>}
        />
      }
      actions={
        <>
          <button type="button" disabled={disabled} onClick={() => void run("approve", onApprove)} className={BTN_PRIMARY}>
            <Check size={14} aria-hidden="true" /> {acting === "approve" ? "Approving…" : approveLabel}
          </button>
          {onReview && (
            <button type="button" disabled={disabled} onClick={() => onReview(approval.taskId)} className={BTN_OUTLINE}>
              Review diff
            </button>
          )}
          <button type="button" disabled={disabled} onClick={() => void run("hold", onHold)} className={BTN_TEXT}>
            Hold
          </button>
          {confirmReject ? (
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={disabled}
                onClick={() => void run("reject", onReject)}
                className={`${BTN_PRIMARY} bg-[#d83a3a] hover:bg-[#c02f2f]`}
              >
                Confirm reject
              </button>
              <button type="button" onClick={() => setConfirmReject(false)} className={BTN_TEXT}>
                Keep
              </button>
            </span>
          ) : (
            <button type="button" disabled={disabled} onClick={() => setConfirmReject(true)} className={BTN_TEXT}>
              Reject
            </button>
          )}
          <span className={`ml-auto text-[12px] ${MUTED}`}>
            {acting !== null
              ? "Processing your decision…"
              : lastAction === "hold"
                ? "Held — stays pending in the task timeline"
                : "Waits for your decision"}
          </span>
        </>
      }
    >
      {metrics && (
        // Only what the worker reported: a missing check reads "Not run" in
        // grey, never a green "passed".
        <div className={`grid grid-cols-2 border-t sm:grid-cols-4 ${CARD_DIVIDER} [&>*]:border-line dark:[&>*]:border-white/[0.07] [&>*:nth-child(2n)]:border-l sm:[&>*:not(:first-child)]:border-l [&>*:nth-child(n+3)]:border-t sm:[&>*:nth-child(n+3)]:border-t-0`}>
          {metricCell("Files", metrics.files ?? null, true)}
          {metricCell("Build", metrics.build)}
          {metricCell("Tests", metrics.tests)}
          {metricCell("QA", metrics.qa)}
        </div>
      )}
    </CardShell>
  );
}
