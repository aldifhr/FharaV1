"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ListChecks, Trash2, Undo2 } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import type { PlanCardData } from "@/api/convex/cardTypes";
import { roleLabel } from "@/lib/agentRoles";
import ConfirmDialog, { type ConfirmRequest } from "../../ConfirmDialog";
import { useToast } from "../../Toasts";
import { CARD_SURFACE, MUTED } from "./primitives";

/**
 * Plan Inspector card. Reads the live plan under review
 * (`planReview.forTask`) so edits and decisions show on the same card.
 * Approve runs the plan; Reject ends the task; Edit allows light changes
 * (title, description, role, remove) that are saved as a new plan version
 * and validated on the server; "Replan with note" asks the planner for a
 * new plan with the note appended.
 */

type Review = NonNullable<ReturnType<typeof useReview>>;
type PlanSubtask = NonNullable<Review["plan"]>["subtasks"][number];

function useReview(taskId: string | undefined) {
  return useQuery(api.planReview.forTask, taskId ? { taskId: taskId as never } : "skip");
}

type Draft = Record<
  string,
  { title: string; description: string; role: string | null; removed: boolean; criteria: Record<string, string> }
>;

/** Draft row for one subtask (plan 022: acceptance criteria text by gate id). */
function draftOf(s: PlanSubtask): Draft[string] {
  return {
    title: s.title,
    description: s.description,
    role: s.role,
    removed: false,
    criteria: Object.fromEntries((s.acceptance ?? []).map((gate) => [gate.id, gate.criterion])),
  };
}

/** Compact contract line: objective, then "Done when" with the gate criteria. */
function ContractSummary({ s }: { s: PlanSubtask }) {
  const gates = s.acceptance ?? [];
  if (!s.objective && gates.length === 0 && (s.constraints ?? []).length === 0) return null;
  return (
    <div className="mt-1 space-y-0.5 text-[12px] text-ink-2">
      {s.objective && (
        <p className="break-words">
          <span className="text-ink-3">Objective </span>
          {s.objective}
        </p>
      )}
      {(s.constraints ?? []).length > 0 && (
        <p className="break-words">
          <span className="text-ink-3">Keep </span>
          {s.constraints.join("; ")}
        </p>
      )}
      {gates.length > 0 && (
        <p className="break-words">
          <span className="text-ink-3">Done when </span>
          {gates.map((gate) => gate.criterion).join(" · ")}
        </p>
      )}
    </div>
  );
}

const BTN = "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-line-strong disabled:cursor-not-allowed disabled:opacity-40";
const BTN_SOLID = `${BTN} bg-ink text-canvas hover:opacity-90`;
const BTN_LINE = `${BTN} border border-line text-ink hover:bg-hover`;
const BTN_QUIET = `${BTN} px-2 text-ink-2 hover:text-ink`;
const FIELD = "w-full rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-line-strong";

function statusLine(review: Review): string | null {
  const a = review.approval;
  if (!a) return null;
  if (a.status === "pending") return null;
  if (a.status === "approved") return review.task.status === "done" ? "Approved · done" : "Approved";
  if (a.status === "rejected") return "Rejected";
  return review.task.status === "queued" || review.task.status === "running" ? "Replanning" : "Closed";
}

export default function PlanCard({ data }: { data: PlanCardData }) {
  const review = useReview(data.taskId);
  const approve = useMutation(api.approvals.approve);
  const reject = useMutation(api.approvals.reject);
  const editPlan = useMutation(api.planReview.editPlan);
  const replan = useMutation(api.planReview.replanWithNote);
  const toast = useToast();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<(ConfirmRequest & { run: () => Promise<void> }) | null>(null);

  const plan = review?.plan ?? null;
  const approval = review?.approval ?? null;
  const pending = approval?.status === "pending" && approval.planVersion === plan?.version;

  // Re-seed the draft whenever a new version arrives.
  useEffect(() => {
    if (!plan) return;
    const next: Draft = {};
    for (const s of plan.subtasks) next[s.key] = draftOf(s);
    setDraft(next);
    setErrors([]);
  }, [plan?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const titleByKey = useMemo(() => new Map((plan?.subtasks ?? []).map((s) => [s.key, s.title])), [plan]);

  if (review === undefined) {
    return <div className={`${CARD_SURFACE} h-24 animate-pulse`} aria-label="Loading plan" />;
  }
  if (!review || !plan) return null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      toast("error", "Plan review failed", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const ops = () => {
    const out: Array<
      | { op: "update"; key: string; title?: string; description?: string; acceptance?: Array<{ id: string; criterion: string }> }
      | { op: "reassign"; key: string; role: string }
      | { op: "remove"; key: string; dependents: "relink" }
    > = [];
    for (const s of plan.subtasks) {
      const d = draft[s.key];
      if (!d) continue;
      if (d.removed) {
        out.push({ op: "remove", key: s.key, dependents: "relink" });
        continue;
      }
      const title = d.title.trim() !== s.title ? d.title : undefined;
      const description = d.description.trim() !== s.description ? d.description : undefined;
      const acceptance = (s.acceptance ?? [])
        .filter((gate) => (d.criteria[gate.id] ?? gate.criterion).trim() !== gate.criterion)
        .map((gate) => ({ id: gate.id, criterion: d.criteria[gate.id] ?? gate.criterion }));
      if (title !== undefined || description !== undefined || acceptance.length > 0) {
        out.push({ op: "update", key: s.key, title, description, ...(acceptance.length > 0 ? { acceptance } : {}) });
      }
      if (d.role && d.role !== s.role) out.push({ op: "reassign", key: s.key, role: d.role });
    }
    return out;
  };
  const changes = editing ? ops() : [];

  const save = () =>
    run(async () => {
      if (!approval) return;
      const result = await editPlan({ approvalId: approval._id as never, ops: changes });
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      setErrors([]);
      setEditing(false);
      toast("success", `Saved as plan v${result.version}`);
    });

  const askReject = () =>
    setConfirm({
      title: "Reject this plan?",
      message: "The task ends as rejected and nothing runs. To get a different plan instead, use Replan with note.",
      confirmLabel: "Reject plan",
      icon: "stop",
      run: async () => {
        if (approval) await reject({ approvalId: approval._id as never });
      },
    });

  const askRemove = (s: PlanSubtask) => {
    const dependents = plan.subtasks.filter((o) => o.dependencies.includes(s.key) && !draft[o.key]?.removed);
    const toggle = () => setDraft((d) => ({ ...d, [s.key]: { ...d[s.key], removed: true } }));
    if (dependents.length === 0) {
      toggle();
      return;
    }
    setConfirm({
      title: `Remove “${s.title}”?`,
      message: `${dependents.map((o) => o.title).join(", ")} ${dependents.length === 1 ? "depends" : "depend"} on it. They will wait on its own dependencies instead. Nothing is saved until you press Save.`,
      confirmLabel: "Remove",
      run: async () => toggle(),
    });
  };

  const sendNote = () =>
    run(async () => {
      if (!approval) return;
      const result = await replan({ approvalId: approval._id as never, note });
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      setNote("");
      toast("info", "Replanning with your note");
    });

  const done = statusLine(review);
  const estimate = plan.estimate;

  return (
    <div className={`${CARD_SURFACE} max-w-2xl`}>
      <div className="flex items-start gap-2.5 px-4 py-3">
        <ListChecks size={16} className="mt-0.5 shrink-0 text-ink-3" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-ink">
            Plan v{plan.version}
            <span className="font-normal text-ink-3">
              {" "}· {plan.subtasks.length} {plan.subtasks.length === 1 ? "subtask" : "subtasks"}
              {plan.createdBy === "user" ? " · edited by you" : plan.createdBy === "fallback" ? " · fallback plan" : ""}
            </span>
          </p>
          <p className={`mt-0.5 break-words text-[12.5px] ${MUTED}`}>{plan.goal}</p>
          {plan.estimateLine && (
            <p className="mt-1 text-[12px] tabular-nums text-ink-2" title="An estimate from this project's recent runs, not a guarantee">
              {plan.estimateLine}
              {estimate && estimate.basis.fromDefault === estimate.subtaskCount ? <span className="text-ink-3"> · no history yet</span> : null}
            </p>
          )}
        </div>
        {done && <span className="shrink-0 text-[12px] text-ink-3">{done}</span>}
      </div>

      <ol className="border-t border-line">
        {plan.subtasks.map((s, index) => {
          const d = draft[s.key];
          const removed = d?.removed;
          return (
            <li key={s.key} className={`border-b border-line px-4 py-2.5 last:border-b-0 ${removed ? "opacity-50" : ""}`}>
              <div className="flex items-start gap-3">
                <span className="w-4 shrink-0 pt-0.5 text-right text-[12px] tabular-nums text-ink-3">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  {editing && d && !removed ? (
                    <div className="space-y-1.5">
                      <div className="flex gap-2">
                        <input
                          value={d.title}
                          onChange={(e) => setDraft((x) => ({ ...x, [s.key]: { ...x[s.key], title: e.target.value } }))}
                          className={FIELD}
                          aria-label={`Title of ${s.title}`}
                          maxLength={200}
                        />
                        <select
                          value={d.role ?? ""}
                          onChange={(e) => setDraft((x) => ({ ...x, [s.key]: { ...x[s.key], role: e.target.value || null } }))}
                          className={`${FIELD} w-36 shrink-0`}
                          aria-label={`Role for ${s.title}`}
                        >
                          {!d.role && <option value="">No role</option>}
                          {d.role && !review.enabledRoles.includes(d.role) && <option value={d.role}>{roleLabel(d.role)}</option>}
                          {review.enabledRoles.map((role) => (
                            <option key={role} value={role}>{roleLabel(role)}</option>
                          ))}
                        </select>
                      </div>
                      <textarea
                        value={d.description}
                        onChange={(e) => setDraft((x) => ({ ...x, [s.key]: { ...x[s.key], description: e.target.value } }))}
                        rows={3}
                        className={`${FIELD} resize-y`}
                        aria-label={`Description of ${s.title}`}
                        maxLength={4000}
                      />
                      {(s.acceptance ?? []).length > 0 && (
                        <div className="space-y-1">
                          <p className="text-[12px] text-ink-3">Done when</p>
                          {s.acceptance.map((gate) => (
                            <div key={gate.id} className="flex items-center gap-2">
                              <input
                                value={d.criteria[gate.id] ?? gate.criterion}
                                onChange={(e) =>
                                  setDraft((x) => ({
                                    ...x,
                                    [s.key]: { ...x[s.key], criteria: { ...x[s.key].criteria, [gate.id]: e.target.value } },
                                  }))
                                }
                                className={FIELD}
                                aria-label={`Acceptance criterion ${gate.id} of ${s.title}`}
                                maxLength={300}
                              />
                              <span className="w-20 shrink-0 text-[11.5px] text-ink-3">{gate.check.replace(/_/g, " ")}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      <p className="text-[13px] text-ink">
                        <span className="font-medium">{s.role ? roleLabel(s.role) : "Unassigned"}</span>
                        <span className="text-ink-3"> · </span>
                        <span className={removed ? "line-through" : ""}>{s.title}</span>
                      </p>
                      <p className="mt-0.5 text-[12px] text-ink-3">
                        {s.kind.replace(/_/g, " ")}
                        {s.dependencies.length > 0 && (
                          <> · after {s.dependencies.map((k) => titleByKey.get(k) ?? k).join(", ")}</>
                        )}
                      </p>
                      {s.allowedPaths.length > 0 && (
                        <p className="mt-0.5 truncate font-mono text-[11.5px] text-ink-3" title={s.allowedPaths.join("\n")}>
                          {s.allowedPaths.join("  ")}
                        </p>
                      )}
                      <ContractSummary s={s} />
                    </>
                  )}
                </div>
                {editing && pending && (
                  removed ? (
                    <button
                      type="button"
                      className={BTN_QUIET}
                      onClick={() => setDraft((x) => ({ ...x, [s.key]: { ...x[s.key], removed: false } }))}
                      aria-label={`Keep ${s.title}`}
                    >
                      <Undo2 size={14} />
                    </button>
                  ) : (
                    <button type="button" className={BTN_QUIET} onClick={() => askRemove(s)} aria-label={`Remove ${s.title}`}>
                      <Trash2 size={14} />
                    </button>
                  )
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {errors.length > 0 && (
        <ul className="border-t border-line px-4 py-2.5 text-[12.5px] text-red-600 dark:text-red-400">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      {pending && (
        <div className="space-y-2.5 border-t border-line px-4 py-3">
          {!editing && (
            <div className="flex gap-2">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Note for the planner (optional)"
                className={FIELD}
                maxLength={2000}
                aria-label="Note for the planner"
              />
              <button type="button" className={`${BTN_LINE} shrink-0`} disabled={busy || !note.trim()} onClick={sendNote}>
                Replan with note
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {editing ? (
              <>
                <button type="button" className={BTN_SOLID} disabled={busy || changes.length === 0} onClick={save}>
                  Save as v{plan.version + 1}
                </button>
                <button
                  type="button"
                  className={BTN_QUIET}
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setErrors([]);
                    const next: Draft = {};
                    for (const s of plan.subtasks) next[s.key] = draftOf(s);
                    setDraft(next);
                  }}
                >
                  Cancel
                </button>
                <span className="text-[12px] text-ink-3">
                  {changes.length === 0 ? "No changes yet" : `${changes.length} ${changes.length === 1 ? "change" : "changes"}`}
                </span>
              </>
            ) : (
              <>
                <button type="button" className={BTN_SOLID} disabled={busy} onClick={() => run(() => approve({ approvalId: approval!._id as never }))}>
                  Approve
                </button>
                <button type="button" className={BTN_LINE} disabled={busy} onClick={() => setEditing(true)}>
                  Edit
                </button>
                <button type="button" className={BTN_QUIET} disabled={busy} onClick={askReject}>
                  Reject
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        request={confirm}
        pending={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const current = confirm;
          setConfirm(null);
          if (current) void run(current.run);
        }}
      />
    </div>
  );
}
