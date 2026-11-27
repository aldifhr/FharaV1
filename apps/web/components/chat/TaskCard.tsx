import { useMutation } from "@fhara/runtime/react";
import { useState } from "react";
import { api } from "@fhara/runtime/api";
import { roleLabel } from "@/lib/agentRoles";
import { ArrowUpRight, Bell, Check, CheckCircle2, Loader2, RotateCcw, XCircle } from "lucide-react";
import OptionCards from "./OptionCards";
import { BTN_OUTLINE, BTN_PRIMARY, RoleAvatar } from "./cards/primitives";
import { PanelCard, PanelCardBody, PanelCardHeader } from "../ui/panel-card";
import { StatusTag, type StatusTone } from "../ui/status-tag";
import { useToast } from "../Toasts";
import { refusalCopy } from "@/lib/taskInput";
import { dueDateLabel, isOverdue } from "@/lib/runFormat";
import { canRetryTask } from "@/lib/taskStatus";

const errorText = (err: unknown) => (err instanceof Error ? err.message : "Please try again.");

export default function TaskCard({
  task,
  subtasks,
  pending,
  onOpen,
  agents,
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
  const isCancelled = task.status === "cancelled";
  // Only failed tasks offer Retry; rejected and cancelled are final.
  const isFailed = task.status === "failed" || task.status === "rejected" || isCancelled;
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
  const statusTone: StatusTone =
    task.status === "done"
      ? "ok"
      : task.status === "failed" || task.status === "rejected"
        ? "danger"
        : task.status === "queued" || isCancelled
            ? "neutral"
            : "active";
  const statusLabel =
    task.status === "done"
      ? "Done"
      : task.status === "failed"
        ? "Failed"
        : task.status === "rejected"
          ? "Rejected"
          : isCancelled
            ? "Cancelled"
          : task.status === "queued"
            ? "Queued"
            : task.status === "waiting_input"
              ? "Waiting for you"
              : "In progress";
  const progress = subtasks.length ? Math.round((doneSubs / subtasks.length) * 100) : task.status === "done" ? 100 : 0;
  // Keep the assignment card focused on the active owner, like the chat reference.
  const primarySubtask = subtasks.find((s) => s.status === "running") ?? subtasks[0];
  const primaryAgent = agents.find((a) => a._id === (primarySubtask as any)?.assignedAgentId);
  const owners =
    primaryAgent
      ? [{ agentId: String(primaryAgent._id), role: primaryAgent.role as string }]
      : (assignees ?? []).map((a) => ({ agentId: a.agentId, role: a.role }));
  const routeRole: string | undefined =
    task.routingHint?.role ?? task.responseOwner ?? owners[0]?.role;
  const routeCapability: string | undefined =
    subtasks.find((s) => {
      const agent = agents.find((a) => a._id === (s as any).assignedAgentId);
      return Boolean((s as any).capability) && String(agent?.role ?? "") === routeRole;
    })?.capability ??
    (task.routingHint as any)?.domain ??
    (primarySubtask as any)?.capability ??
    subtasks.find((s) => Boolean((s as any).capability))?.capability;
  const routeFiles: string[] = Array.isArray(task.routingHint?.files)
    ? task.routingHint.files.filter((f: unknown): f is string => typeof f === "string").slice(0, 3)
    : [];
  const statusIcon = needsYou
    ? <Bell size={16} className="text-warn" />
    : task.status === "done"
      ? <CheckCircle2 size={16} className="text-ok" />
      : task.status === "failed" || task.status === "rejected"
        ? <XCircle size={16} className="text-danger" />
        : isCancelled
          ? <XCircle size={16} className="text-ink-3" />
        : <Loader2 size={16} strokeWidth={2.5} className="animate-spin text-ink-2" />;

  return (
    <div className="space-y-1.5">
      <PanelCard
        interactive
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
        className="max-w-3xl"
      >
        <PanelCardHeader
          kind={task.simulated ? "Simulation · no LLM calls" : undefined}
          icon={statusIcon}
          title={task.title}
          meta={
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {owners.length > 0 &&
                owners.slice(0, 3).map((owner) => (
                  <span key={owner.agentId} className="inline-flex items-center gap-1.5">
                    <RoleAvatar role={owner.role} size={18} />
                    <span className="text-ink-2">{roleLabel(owner.role)}</span>
                  </span>
                ))}
              {task.branchName && (
                <>
                  {owners.length > 0 && <span aria-hidden="true">·</span>}
                  <code className="max-w-36 truncate rounded-field bg-inset px-1.5 py-0.5 font-mono text-[11.5px] text-ink-3" title={task.branchName}>
                    {String(task.branchName).split("/").at(-1)}
                  </code>
                </>
              )}
              {task.dueAt && (
                <>
                  {(owners.length > 0 || task.branchName) && <span aria-hidden="true">·</span>}
                  <span
                    className={`text-[12px] ${isOverdue(task.dueAt, task.status === "done") ? "text-danger" : "text-ink-3"}`}
                    title="Due date"
                  >
                    due {dueDateLabel(task.dueAt)}
                  </span>
                </>
              )}
            </span>
          }
          aside={
            <>
              {needsYou && <StatusTag tone="warn">Needs you</StatusTag>}
              <StatusTag tone={statusTone}>{statusLabel}</StatusTag>
              <ArrowUpRight size={16} aria-hidden="true" className="text-ink-3" />
            </>
          }
        />
        <div className="mx-3.5 mb-3 h-1 overflow-hidden rounded-full bg-inset" role="progressbar" aria-label="Task progress" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded-full transition-all ${task.status === "done" ? "bg-ok" : "bg-brand"}`} style={{ width: `${progress}%` }} />
        </div>
        {(routeRole || routeCapability || routeFiles.length > 0 || task.responseOwner) && (
          <div className="mx-3.5 mb-3 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-3" aria-label="Task routing">
            {routeRole && (
              <span className="rounded-field bg-inset px-1.5 py-0.5">
                Assigned to <span className="text-ink-2">{roleLabel(routeRole)}</span>
              </span>
            )}
            {routeCapability && (
              <span className="rounded-field bg-inset px-1.5 py-0.5 font-mono">{String(routeCapability)}</span>
            )}
            {routeFiles.map((file) => (
              <code key={file} className="max-w-40 truncate rounded-field bg-inset px-1.5 py-0.5 font-mono" title={file}>
                {file}
              </code>
            ))}
            {task.responseOwner && (
              <span className="rounded-field bg-inset px-1.5 py-0.5">
                Owner: <span className="text-ink-2">{roleLabel(task.responseOwner)}</span>
              </span>
            )}
          </div>
        )}
      </PanelCard>
      {waitingForInput && (
        <PanelCard className="max-w-xl">
          <PanelCardHeader kind="Question" title="The team asked you" aside={<StatusTag tone="warn">Needs you</StatusTag>} />
          <PanelCardBody>
          <p className="whitespace-pre-wrap text-[13px] text-ink-2">{task.pendingQuestion}</p>
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
                className="min-w-0 flex-1 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-base text-ink placeholder:text-ink-3 focus:border-ink/30 focus:outline-none sm:text-[13px] dark:bg-transparent"
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
          </PanelCardBody>
        </PanelCard>
      )}
      {isFailed && (
        <PanelCard className="max-w-xl px-3.5 py-3 text-[13px]">
          <p className={isCancelled ? "font-semibold text-ink-2" : "font-semibold text-danger"}>{task.status === "rejected" ? "Task rejected" : isCancelled ? "Task cancelled" : "Task failed"}{task.errorMessage ? `: ${task.errorMessage}` : ""}</p>
          <div className="mt-2 flex items-center gap-2">
            {canRetryTask(task.status) && (
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
            )}
            <button type="button" onClick={() => onOpen(task._id)} className={BTN_OUTLINE}>
              View thread
            </button>
          </div>
        </PanelCard>
      )}
      {/* Approve lives on the ApprovalCard(s) rendered below this card —
          one control per approval, not a second button for pending[0]. */}
    </div>
  );
}
