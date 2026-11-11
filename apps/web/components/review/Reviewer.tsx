"use client";

/**
 * Reviewer observer UI: Second Opinion (subtask / chat reply) and Shadow
 * Agent notes. Everything here is read-only except two explicit actions:
 * asking for an opinion, and "Replan with this note" on a concerns /
 * disagree verdict. Nothing is applied automatically.
 */
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "@/components/Toasts";
import { SHADOW_KIND_LABELS, VERDICT_LABELS, type OpinionVerdict, type ShadowNoteKind } from "@/api/convex/lib/reviewer/opinion";

type TaskReview = NonNullable<FunctionReturnType<typeof api.reviewer.listForTask>>;
export type Opinion = TaskReview["opinions"][number];

const VERDICT_TONE: Record<OpinionVerdict, { text: string; dot: string }> = {
  agree: { text: "text-ink", dot: "bg-ink-3" },
  concerns: { text: "text-warn", dot: "bg-warn" },
  disagree: { text: "text-destructive", dot: "bg-destructive" },
};

const OUTCOME_COPY: Record<string, string> = {
  replanned: "Sent to the planner: the plan is being redone with this note.",
  requeued: "Sent to the planner: the task was re-queued with this note.",
  steered: "Sent to the running task as a steer.",
};

function errorText(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  // Convex wraps server errors; keep the user-facing part.
  const match = /Uncaught Error: (.*?)(?:\n|$)/.exec(err.message);
  return match ? match[1] : err.message;
}

function Evidence({ evidence }: { evidence: Opinion["evidence"] }) {
  if (evidence.length === 0) return null;
  return (
    <ul className="mt-1.5 space-y-0.5">
      {evidence.map((e, i) => (
        <li key={`${e.file}-${e.line ?? 0}-${i}`} className="flex min-w-0 gap-2 text-[12.5px]">
          <span className="shrink-0 font-mono text-ink-2">
            {e.file}
            {e.line ? `:${e.line}` : ""}
          </span>
          {e.note && <span className="min-w-0 truncate text-ink-3">{e.note}</span>}
        </li>
      ))}
    </ul>
  );
}

/** One second opinion: verdict, reason, evidence, and the replan action. */
export function OpinionItem({ opinion, label }: { opinion: Opinion; label?: string }) {
  const toast = useToast();
  const replan = useMutation(api.reviewer.replanWithOpinion);
  const [busy, setBusy] = useState(false);
  const verdict = opinion.verdict as OpinionVerdict | null;
  const tone = verdict ? VERDICT_TONE[verdict] : null;
  const canReplan =
    opinion.status === "done" &&
    opinion.target === "subtask" &&
    (verdict === "concerns" || verdict === "disagree") &&
    !opinion.replanRequestedAt;

  return (
    <div className="py-2.5">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
        {opinion.status === "running" ? (
          <span className="text-ink-3">Reviewer is reading…</span>
        ) : opinion.status === "error" ? (
          <span className="text-destructive">{opinion.error ?? "The review failed"}</span>
        ) : tone && verdict ? (
          <span className={`inline-flex items-center gap-1.5 font-medium ${tone.text}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
            {VERDICT_LABELS[verdict]}
          </span>
        ) : null}
        {label && <span className="min-w-0 truncate text-ink-3">{label}</span>}
        {opinion.status === "done" && opinion.tokens > 0 && (
          <span className="ml-auto shrink-0 tabular-nums text-[12px] text-ink-3">≈{opinion.tokens.toLocaleString("en-US")} tok</span>
        )}
      </p>
      {opinion.reason && opinion.status === "done" && <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{opinion.reason}</p>}
      <Evidence evidence={opinion.evidence} />
      {opinion.replanOutcome && <p className="mt-1.5 text-[12.5px] text-ink-3">{OUTCOME_COPY[opinion.replanOutcome] ?? "Sent to the planner."}</p>}
      {canReplan && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const result = await replan({ opinionId: opinion._id });
              toast("success", "Note sent to the planner", OUTCOME_COPY[result.outcome]);
            } catch (err) {
              toast("error", "Couldn't send the note", errorText(err));
            } finally {
              setBusy(false);
            }
          }}
          className="mt-2 inline-flex h-7 items-center rounded-lg border border-line bg-panel px-2.5 text-[12.5px] font-medium text-ink outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50"
        >
          {busy ? "Sending…" : "Replan with this note"}
        </button>
      )}
    </div>
  );
}

/** "Second opinion" text action for one finished subtask. */
export function SecondOpinionButton({ taskId, subtaskKey, className = "" }: { taskId: string; subtaskKey: string; className?: string }) {
  const toast = useToast();
  const request = useMutation(api.reviewer.requestSubtaskOpinion);
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async (event) => {
        event.stopPropagation();
        setBusy(true);
        try {
          await request({ taskId: taskId as never, subtaskKey });
          toast("info", "Asked the Reviewer", "The second opinion shows under Reviewer when it's ready.");
        } catch (err) {
          toast("error", "Couldn't ask the Reviewer", errorText(err));
        } finally {
          setBusy(false);
        }
      }}
      className={`text-[12.5px] text-ink-3 underline-offset-2 outline-none hover:text-ink hover:underline focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50 ${className}`}
    >
      {busy ? "Asking…" : "Second opinion"}
    </button>
  );
}

/** Shadow agent switch for one task. */
function ShadowToggle({ taskId, enabled }: { taskId: string; enabled: boolean }) {
  const toast = useToast();
  const set = useMutation(api.reviewer.setTaskShadow);
  const [busy, setBusy] = useState(false);
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-2">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await set({ taskId: taskId as never, enabled: !enabled });
          } catch (err) {
            toast("error", "Couldn't change the shadow agent", errorText(err));
          } finally {
            setBusy(false);
          }
        }}
        className={`relative h-4 w-7 shrink-0 rounded-full outline-none transition focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50 ${enabled ? "bg-ink" : "bg-line-strong"}`}
      >
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-panel transition-[left] ${enabled ? "left-3.5" : "left-0.5"}`} />
      </button>
      Shadow agent
    </label>
  );
}

function SubHeading({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mt-4 flex items-baseline gap-2 text-[12.5px] text-ink-3 first:mt-0">
      <span className="font-medium text-ink-2">{children}</span>
      {aside}
    </div>
  );
}

/**
 * Reviewer section for a task: second opinions on its subtasks and the
 * shadow agent's notes, with the shadow toggle. Used in the task thread and
 * on /runs/[taskId].
 */
export function ReviewerSection({
  taskId,
  subtaskTitles,
  heading,
}: {
  taskId: string;
  subtaskTitles: Record<string, string>;
  heading: (aside: React.ReactNode) => React.ReactNode;
}) {
  const data = useQuery(api.reviewer.listForTask, { taskId: taskId as never });
  if (!data) return null;
  const notes = data.shadow.flatMap((row) =>
    row.notes.map((note, i) => ({ id: `${row._id}-${i}`, subtaskKey: row.subtaskKey, ...note }))
  );
  const shadowRunning = data.shadow.filter((row) => row.status === "running").length;
  const shadowErrors = data.shadow.filter((row) => row.status === "error");
  const shadowSkipped = data.shadow.find((row) => row.status === "skipped");
  const title = (key: string | null) => (key ? subtaskTitles[key] ?? key : undefined);

  return (
    <section>
      {heading(<ShadowToggle taskId={taskId} enabled={data.shadowAgent} />)}
      {data.opinions.length > 0 && (
        <>
          <SubHeading>Second opinions</SubHeading>
          <ul className="divide-y divide-line">
            {data.opinions.map((opinion) => (
              <li key={opinion._id}>
                <OpinionItem opinion={opinion} label={title(opinion.subtaskKey)} />
              </li>
            ))}
          </ul>
        </>
      )}
      {(data.shadowAgent || data.shadow.length > 0) && (
        <>
          <SubHeading
            aside={
              <span className="tabular-nums">
                {data.shadowBudget.notes}/{data.shadowBudget.maxNotes} notes · ≈{data.shadowBudget.tokens.toLocaleString("en-US")} of{" "}
                {data.shadowBudget.tokenCap.toLocaleString("en-US")} tok
              </span>
            }
          >
            Shadow notes
          </SubHeading>
          {notes.length === 0 ? (
            <p className="py-2.5 text-[13px] text-ink-3">
              {shadowRunning > 0
                ? "The Reviewer is reading the latest subtask…"
                : data.shadowAgent
                  ? "No notes yet. The Reviewer reads each subtask when it completes; it never changes the run."
                  : "No notes."}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {notes.map((note) => (
                <li key={note.id} className="py-2.5">
                  <p className="flex items-baseline gap-2 text-[12.5px]">
                    <span className={`font-medium ${note.kind === "risk" ? "text-warn" : note.kind === "missed_requirement" ? "text-destructive" : "text-ink-2"}`}>
                      {SHADOW_KIND_LABELS[note.kind as ShadowNoteKind]}
                    </span>
                    {note.subtaskKey && <span className="min-w-0 truncate text-ink-3">{title(note.subtaskKey)}</span>}
                  </p>
                  <p className="mt-0.5 text-[13.5px] leading-relaxed text-ink">{note.text}</p>
                  <Evidence evidence={note.evidence} />
                </li>
              ))}
            </ul>
          )}
          {shadowRunning > 0 && notes.length > 0 && <p className="text-[12.5px] text-ink-3">Reading the latest subtask…</p>}
          {shadowErrors.length > 0 && (
            <p className="text-[12.5px] text-ink-3">
              {shadowErrors.length} shadow {shadowErrors.length === 1 ? "review" : "reviews"} failed: {shadowErrors[shadowErrors.length - 1].error}
            </p>
          )}
          {shadowSkipped && <p className="text-[12.5px] text-ink-3">The shadow agent stopped: {shadowSkipped.reason ?? "budget reached"}.</p>}
        </>
      )}
    </section>
  );
}

type ChatOpinion = FunctionReturnType<typeof api.reviewer.listForChat>[number];

/** Chat second opinions of a project, keyed by message id (one subscription per chat). */
export function useChatOpinions(projectId: string | undefined): Map<string, ChatOpinion> {
  const rows = useQuery(api.reviewer.listForChat, projectId ? { projectId: projectId as never } : "skip");
  const map = new Map<string, ChatOpinion>();
  for (const row of rows ?? []) if (row.messageId) map.set(row.messageId, row);
  return map;
}

/** The Reviewer's second opinion under a chat reply. */
export function ChatOpinionLine({ opinion }: { opinion: ChatOpinion }) {
  return (
    <div className="mt-2 max-w-[42rem] border-l-2 border-line pl-3">
      <p className="text-[12px] text-ink-3">Reviewer second opinion</p>
      <OpinionItem opinion={opinion as Opinion} />
    </div>
  );
}

/** Ask for a chat reply's second opinion (used by the message ⋯ menu). */
export function useRequestMessageOpinion() {
  const toast = useToast();
  const request = useMutation(api.reviewer.requestMessageOpinion);
  return (messageId: string) =>
    request({ messageId: messageId as never }).then(
      () => toast("info", "Asked the Reviewer", "The second opinion shows under this reply."),
      (err) => toast("error", "Couldn't ask the Reviewer", errorText(err))
    );
}
