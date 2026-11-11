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
import { approvalTrayItem } from "@/api/convex/lib/decisionTray";
import { TRAY_BTN_PRIMARY, TRAY_BTN_SECONDARY, TRAY_BTN_TEXT } from "./chat/DecisionsTray";

type Approval = {
  _id: string;
  kind: string;
  summary: string;
  taskId: string;
  status: string;
  payload?: any;
  _creationTime?: number;
  offerAlways?: boolean;
};

export type CommandDecision = "allow" | "always" | "always_exact" | "deny";

const KIND_LABEL: Record<string, string> = {
  apply_changes: "Apply changes",
  git_push: "Git push",
  run_command: "Run command",
  run_unconfined: "Run without the sandbox",
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
export default function ApprovalCard(
  props: Parameters<typeof GenericApprovalCard>[0] & { onRespond?: (approvalId: string, decision: CommandDecision) => unknown }
) {
  if (props.approval.kind === "plan") return <PlanCard data={{ taskId: props.approval.taskId }} />;
  if ((props.approval.kind === "run_command" || props.approval.kind === "run_unconfined") && props.onRespond) {
    return <CommandApprovalCard approval={props.approval} taskTitle={props.taskTitle} agentRole={props.agent?.role} onRespond={props.onRespond} />;
  }
  return <GenericApprovalCard {...props} />;
}

/**
 * Inline copy of a waiting command (the composer tray shows the same row):
 * the exact command, Allow / Always allow / Deny. Both read the same live
 * approval, so a decision in either place resolves both.
 */
function CommandApprovalCard({
  approval,
  taskTitle,
  agentRole,
  onRespond,
}: {
  approval: Approval;
  taskTitle?: string;
  agentRole?: string;
  onRespond: (approvalId: string, decision: CommandDecision) => unknown;
}) {
  const toast = useToast();
  const [acting, setActing] = useState<CommandDecision | null>(null);
  const item = approvalTrayItem({ ...approval, _creationTime: approval._creationTime ?? 0, agentRole, taskTitle });
  const run = async (decision: CommandDecision) => {
    setActing(decision);
    try {
      await onRespond(approval._id, decision);
    } catch (err) {
      toast("error", "Decision not saved", err instanceof Error ? err.message : undefined);
    } finally {
      setActing(null);
    }
  };
  return (
    <div className="mt-1 max-w-2xl rounded-xl border border-line bg-panel px-4 py-3">
      <p className="text-[13px] font-semibold text-ink">{item.title}</p>
      {item.meta && <p className="mt-0.5 text-[12px] text-ink-3">{item.meta}</p>}
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12.5px] text-ink">{item.code}</pre>
      {item.warning && <p className="mt-1.5 text-[12px] text-ink-2">Selalu ditanyakan: {item.warning.toLowerCase()}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {item.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            disabled={acting !== null}
            onClick={() => void run(action.id as CommandDecision)}
            className={action.primary ? TRAY_BTN_PRIMARY : action.id === "deny" ? TRAY_BTN_TEXT : TRAY_BTN_SECONDARY}
          >
            {acting === action.id ? "Saving…" : action.label}
          </button>
        ))}
      </div>
    </div>
  );
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
  // L2: the worker flags staged secrets (`flags: ["secret_detected"]`).
  const secretFindings = secretDetectedFindings(approval.payload);

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
          <span className={`ml-auto basis-full text-right text-[12px] sm:basis-auto ${MUTED}`}>
            {acting !== null
              ? "Processing your decision…"
              : lastAction === "hold"
                ? "Held — stays pending in the task timeline"
                : "Waits for your decision"}
          </span>
        </>
      }
    >
      {secretFindings && (
        <div role="alert" className={`border-t ${CARD_DIVIDER} px-4 py-3 text-[13px]`}>
          <p className="font-semibold text-[#d83a3a]">Possible secret in these changes</p>
          <ul className={`mt-1 list-disc pl-5 ${MUTED}`}>
            {secretFindings.map((finding) => (
              <li key={finding.filePath}>
                <span className="font-mono text-ink">{finding.filePath}</span>
                {finding.reasons.length > 0 ? ` — ${finding.reasons.join(", ")}` : ""}
              </li>
            ))}
          </ul>
          <p className={`mt-1 ${MUTED}`}>Auto-approval is off for this batch. Check the diff before you approve.</p>
        </div>
      )}
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

/** Staged-secret findings on an approval payload, or null when it carries no `secret_detected` flag. */
export function secretDetectedFindings(payload: unknown): { filePath: string; reasons: string[] }[] | null {
  const p = payload as { flags?: unknown; secretFindings?: unknown } | null | undefined;
  if (!p || !Array.isArray(p.flags) || !p.flags.includes("secret_detected")) return null;
  const raw = Array.isArray(p.secretFindings) ? p.secretFindings : [];
  const findings = raw
    .map((f: any) => ({
      filePath: typeof f?.filePath === "string" ? f.filePath : "",
      reasons: Array.isArray(f?.reasons) ? f.reasons.filter((r: unknown): r is string => typeof r === "string") : [],
    }))
    .filter((f) => f.filePath);
  return findings.length > 0 ? findings : [{ filePath: "(staged files)", reasons: [] }];
}
