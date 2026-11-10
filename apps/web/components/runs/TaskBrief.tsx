"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { BRIEF_QUESTIONS_MAX, BRIEF_QUESTION_MAX, BRIEF_TEXT_MAX } from "@/api/convex/lib/brief";
import { relativeTime } from "@/lib/runFormat";
import { roleLabel } from "@/lib/agentRoles";

/**
 * Plan L3: the task brief — objective, owner, latest result, open questions,
 * next step. Agents keep it current after each step; the user can edit it
 * here and the next step's prompt starts with it. A plain divide-y list.
 */

const field =
  "w-full rounded-lg border border-line bg-transparent px-3 py-2 text-[13px] text-ink outline-none transition focus:border-ink-3";

type Brief = {
  objective?: string;
  owner?: string;
  latestResult?: string;
  openQuestions: string[];
  nextStep?: string;
  updatedAt?: number;
  updatedBy?: "user" | "worker";
};

const ROWS: Array<{ key: "objective" | "owner" | "latestResult" | "nextStep"; label: string }> = [
  { key: "objective", label: "Objective" },
  { key: "owner", label: "Owner" },
  { key: "latestResult", label: "Latest result" },
  { key: "nextStep", label: "Next step" },
];

export default function TaskBrief({ taskId }: { taskId: string }) {
  const brief = useQuery(api.briefs.get, { taskId: taskId as never }) as Brief | null | undefined;
  const [editing, setEditing] = useState(false);
  if (brief === undefined) return null;
  return (
    <section className="mt-10">
      <h2 className="mb-2 flex items-baseline justify-between gap-2 text-[13px] font-medium text-ink-2">
        <span className="flex items-baseline gap-2">
          Brief
          {brief?.updatedAt && (
            <span className="font-normal text-ink-3">
              {brief.updatedBy === "user" ? "Edited by you" : "Updated by the team"} · {relativeTime(brief.updatedAt)}
            </span>
          )}
        </span>
        {!editing && (
          <button type="button" onClick={() => setEditing(true)} className="font-normal text-ink-3 hover:text-ink">
            Edit
          </button>
        )}
      </h2>
      {editing ? (
        <BriefEditor taskId={taskId} brief={brief} onClose={() => setEditing(false)} />
      ) : !brief ? (
        <p className="border-y border-line py-2.5 text-[12.5px] text-ink-3">
          No brief yet. The team fills it in as steps finish, or you can write one.
        </p>
      ) : (
        <dl className="divide-y divide-line border-y border-line text-[12.5px]">
          {ROWS.map(({ key, label }) => (
            <div key={key} className="flex gap-3 py-2.5">
              <dt className="w-28 shrink-0 text-ink-3">{label}</dt>
              <dd className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink">
                {brief[key] ? (key === "owner" && /^[\w-]+$/.test(brief[key]!) ? roleLabel(brief[key]!) : brief[key]) : <span className="text-ink-3">—</span>}
              </dd>
            </div>
          ))}
          <div className="flex gap-3 py-2.5">
            <dt className="w-28 shrink-0 text-ink-3">Open questions</dt>
            <dd className="min-w-0 flex-1 text-ink">
              {brief.openQuestions.length === 0 ? (
                <span className="text-ink-3">None</span>
              ) : (
                <ul className="space-y-1">
                  {brief.openQuestions.map((q) => (
                    <li key={q} className="break-words">{q}</li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}

function BriefEditor({ taskId, brief, onClose }: { taskId: string; brief: Brief | null; onClose: () => void }) {
  const update = useMutation(api.briefs.update);
  const [values, setValues] = useState({
    objective: brief?.objective ?? "",
    owner: brief?.owner ?? "",
    latestResult: brief?.latestResult ?? "",
    nextStep: brief?.nextStep ?? "",
    openQuestions: (brief?.openQuestions ?? []).join("\n"),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      // An emptied field is sent as null, which clears it.
      await update({
        taskId: taskId as never,
        objective: values.objective.trim() || null,
        owner: values.owner.trim() || null,
        latestResult: values.latestResult.trim() || null,
        nextStep: values.nextStep.trim() || null,
        openQuestions: values.openQuestions.split("\n").map((q) => q.trim()).filter(Boolean),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the brief");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-3 border-y border-line py-3 text-[12.5px] text-ink-3">
      {ROWS.map(({ key, label }) => (
        <label key={key} className="grid gap-1">
          {label}
          <textarea
            value={values[key]}
            onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
            maxLength={BRIEF_TEXT_MAX}
            rows={key === "owner" ? 1 : 2}
            className={`${field} resize-y`}
          />
        </label>
      ))}
      <label className="grid gap-1">
        Open questions (one per line, up to {BRIEF_QUESTIONS_MAX}, {BRIEF_QUESTION_MAX} characters each)
        <textarea
          value={values.openQuestions}
          onChange={(e) => setValues((v) => ({ ...v, openQuestions: e.target.value }))}
          rows={3}
          className={`${field} resize-y`}
        />
      </label>
      {error && <p role="alert" className="text-[13px] text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover">
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-ink px-3.5 py-1.5 text-[13px] font-medium text-canvas transition hover:opacity-90 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
