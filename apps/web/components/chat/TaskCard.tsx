import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/api/convex/_generated/api";
import { roleLabel } from "@/lib/agentRoles";
import { ArrowUpRight, Bell, Check, CheckCircle2, Loader2, RotateCcw, XCircle } from "lucide-react";
import OptionCards from "./OptionCards";
import { BTN_OUTLINE, BTN_PRIMARY, CARD_SURFACE, MUTED, Pill, RoleAvatar } from "./cards/primitives";
import { useToast } from "../Toasts";
import { isClosedStatus } from "@/lib/taskStatus";
import { normalizePermissionMode } from "@/api/convex/lib/permissionModes";
import { refusalCopy } from "@/lib/taskInput";

const errorText = (err: unknown) => (err instanceof Error ? err.message : "Please try again.");

export default function TaskCard({
  task,
  subtasks,
  pending,
  onOpen,
  agents,
  approvalMode,
  assignees,
}: {
  task: any;
  subtasks: any[];
  pending: any[];
  onOpen: (taskId: string) => void;
  agents: any[];
  approvalMode: "ask" | "auto";
  /** Owners named at assignment (assignment card); else the running subtask's agent. */
  assignees?: Array<{ agentId: string; name: string; role: string }>;
}) {
  const toast = useToast();
  const retryTask = useMutation(api.tasks.retry);
  const answerQuestion = useMutation(api.tasks.answerQuestion);
  const [retrying, setRetrying] = useState(false);
  const [answer, setAnswer] = useState("");
  const [answering, setAnswering] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const doneSubs = subtasks.filter((s) => s.status === "completed").length;
  const needsYou =
    task.status === "needs_approval" ||
    task.status === "waiting_input" ||
    pending.length > 0;
  const waitingForInput = task.status === "waiting_input" && Boolean(task.pendingQuestion);
  const options: string[] = Array.isArray(task.pendingOptions) ? task.pendingOptions : [];
  const hasOptions = options.length >= 2;
  const isFailed = task.status === "failed" || task.status === "rejected";
  const sendAnswer = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || answering) return;
    setAnswering(true);
    try {
      setRefusal(null);
      const res = await answerQuestion({ taskId: task._id as any, answer: trimmed, question: task.pendingQuestion });
      // Refused by the input guard: keep the text and say why, inline.
      if (!res.applied) {
        setRefusal(refusalCopy(res.reason));
        return;
      }
      setAnswer("");
    } catch (err) {
      // Keep the typed answer so the user can resend it.
      toast("error", "Couldn't send answer", errorText(err));
    } finally {
      setAnswering(false);
    }
  };
  const badgeTone =
    task.status === "done"
      ? ("green" as const)
      : task.status === "failed" || task.status === "rejected"
        ? ("red" as const)
        : needsYou
          ? ("orange" as const)
          : task.status === "queued"
            ? ("gray" as const)
            : ("blue" as const);
  const badgeLabel =
    task.status === "done"
      ? "Done"
      : task.status === "failed"
        ? "Failed"
        : task.status === "rejected"
          ? "Rejected"
          : needsYou
            ? "Needs you"
            : task.status === "queued"
              ? "Queued"
              : "In progress";
  const progress = subtasks.length ? Math.round((doneSubs / subtasks.length) * 100) : task.status === "done" ? 100 : 0;
  // Compact card: like the reference, the meta line names the agent
  // currently working the task (first running subtask, else first).
  const primarySubtask = subtasks.find((s) => s.status === "running") ?? subtasks[0];
  const primaryAgent = agents.find((a) => a._id === (primarySubtask as any)?.assignedAgentId);
  const owners =
    primaryAgent
      ? [{ agentId: String(primaryAgent._id), role: primaryAgent.role as string }]
      : (assignees ?? []).map((a) => ({ agentId: a.agentId, role: a.role }));
  const statusIcon = needsYou
    ? <Bell size={16} className="shrink-0 text-[#e5671f] dark:text-orange-400" />
    : task.status === "done"
      ? <CheckCircle2 size={16} className="shrink-0 text-[#1f9d55] dark:text-emerald-400" />
      : task.status === "failed" || task.status === "rejected"
        ? <XCircle size={16} className="shrink-0 text-[#d83a3a] dark:text-rose-400" />
        : <Loader2 size={16} strokeWidth={2.5} className="shrink-0 animate-spin text-[#2f6fe0] dark:text-blue-400" />;

  return (
    <div className="space-y-1.5">
      <div
        onClick={() => onOpen(task._id)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen(task._id);
          }
        }}
        aria-label={`Open task ${task.title}`}
        className={`${CARD_SURFACE} max-w-xl cursor-pointer outline-none transition hover:border-brand/40 focus-visible:ring-2 focus-visible:ring-brand/40 dark:hover:border-white/20`}
      >
        <div className="flex items-center gap-2.5 px-4 pt-3.5">
          {statusIcon}
          <p className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{task.title}</p>
          <ArrowUpRight size={16} aria-hidden="true" className="shrink-0 text-ink-3" />
        </div>
        <div className={`flex flex-wrap items-center gap-x-1.5 gap-y-1 px-4 pb-3 pt-2 text-[12px] ${MUTED}`}>
          {owners.slice(0, 3).map((owner) => (
            <span key={owner.agentId} className="inline-flex items-center gap-1.5">
              <RoleAvatar role={owner.role} size={18} />
              <span className="text-ink-2">{roleLabel(owner.role)}</span>
            </span>
          ))}
          {task.branchName && (
            <>
              <span aria-hidden="true">·</span>
              <span className="max-w-[14rem] truncate rounded-md bg-hover px-1.5 py-0.5 font-mono text-[11px] text-ink-2">
                {task.branchName}
              </span>
            </>
          )}
          {subtasks.length > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>{doneSubs} of {subtasks.length} steps</span>
            </>
          )}
          <span className="ml-auto">
            <Pill tone={badgeTone}>{badgeLabel}</Pill>
          </span>
        </div>
        <div className="mx-4 mb-3 h-1 overflow-hidden rounded-full bg-hover" role="progressbar" aria-label="Task progress" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded-full transition-all ${task.status === "done" ? "bg-[#1f9d55]" : "bg-[#2f6fe0]"}`} style={{ width: `${progress}%` }} />
        </div>
      </div>
      {waitingForInput && (
        <div className={`${CARD_SURFACE} max-w-xl px-4 py-3`}>
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-[13px] font-semibold text-ink">The team asked you</p>
            <Pill tone="orange">Needs you</Pill>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-2">{task.pendingQuestion}</p>
          {hasOptions ? (
            <OptionCards
              options={options.map((option, index) => ({
                id: String.fromCharCode(65 + index),
                title: option,
                summary: "",
                preview: "plain",
              }))}
              disabled={answering}
              compact
              onPick={(option) => void sendAnswer(option.title)}
            />          ) : (
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void sendAnswer(answer);
                  }
                }}
                aria-label="Answer the team"
                placeholder="Reply to continue the task…"
                className="min-w-0 flex-1 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-base text-ink placeholder:text-ink-3 focus:border-brand/40 focus:outline-none sm:text-[13px] dark:bg-transparent"
              />
              <button
                type="button"
                disabled={answering || answer.trim().length === 0}
                onClick={() => void sendAnswer(answer)}
                className={BTN_PRIMARY}
              >
                <Check size={14} /> Send
              </button>
            </div>
          )}
          {refusal && (
            <p role="status" className="mt-1.5 text-[12.5px] text-ink-3">
              {refusal}
            </p>
          )}
        </div>
      )}
      {isFailed && (
        <div className={`${CARD_SURFACE} max-w-xl px-4 py-3 text-[13px]`}>
          <p className="font-semibold text-[#c43333] dark:text-rose-300">{task.status === "rejected" ? "Task rejected" : "Task failed"}{task.errorMessage ? `: ${task.errorMessage}` : ""}</p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={retrying}
              onClick={async () => {
                setRetrying(true);
                try {
                  await retryTask({ taskId: task._id as any });
                } catch (err) {
                  toast("error", "Couldn't retry task", errorText(err));
                } finally {
                  setRetrying(false);
                }
              }}
              className={BTN_PRIMARY}
            >
              <RotateCcw size={14} className={retrying ? "animate-spin" : ""} /> Retry task
            </button>
            <button type="button" onClick={() => onOpen(task._id)} className={BTN_OUTLINE}>
              View thread
            </button>
          </div>
        </div>
      )}
      {/* Approve lives on the ApprovalCard(s) rendered below this card —
          one control per approval, not a second button for pending[0]. */}
      {!isClosedStatus(task.status) && pending.length === 0 && task.status !== "done" && approvalMode === "ask" && normalizePermissionMode(task.permissionMode) === "supervised" && (
        <p className={`pl-1 text-[11px] ${MUTED}`}>Team is working. You will get an Approve card here before any change is applied.</p>
      )}
    </div>
  );
}
