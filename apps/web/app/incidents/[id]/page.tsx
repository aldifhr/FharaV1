"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import IconRail from "@/components/IconRail";
import { useToast } from "@/components/Toasts";
import { IncidentSuggestions, SuggestFixButton, errorText } from "@/components/review/Improve";
import { clockTime, shortDate } from "@/lib/format";
import { taskStatusLabel } from "@/lib/taskStatus";
import { TRIGGER_LABELS } from "@/lib/incidentLabels";

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="mb-2 flex items-baseline justify-between gap-2 text-[13px] font-medium text-ink-2">
        {title}
        {aside}
      </h2>
      {children}
    </section>
  );
}

const field =
  "w-full rounded-lg border border-line bg-panel px-3 py-2 text-[14px] text-ink outline-none focus:border-brand/50 focus:ring-2 focus:ring-brand/15";

export default function IncidentPage() {
  const params = useParams<{ id: string }>();
  const incidentId = params?.id;
  const incident = useQuery(api.incidents.get, incidentId ? { incidentId: incidentId as never } : "skip");
  const update = useMutation(api.incidents.update);
  const toast = useToast();
  const [owner, setOwner] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const loadedId = incident?._id;
  useEffect(() => {
    if (!incident) return;
    setOwner(incident.owner ?? "");
    setNote(incident.note ?? "");
    // Reset the form only when another incident loads, not on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedId]);

  const save = async (status?: "open" | "resolved") => {
    if (!incident) return;
    setSaving(true);
    try {
      await update({ incidentId: incident._id, owner, note, ...(status ? { status } : {}) });
      toast("success", status === "resolved" ? "Incident resolved" : status === "open" ? "Incident reopened" : "Saved");
    } catch (err) {
      toast("error", "Couldn't save", errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail projectId={incident?.projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-3xl">
          <Link
            href={incident ? `/incidents?project=${incident.projectId}` : "/incidents"}
            className="inline-flex items-center gap-1 text-[13px] text-ink-3 hover:text-ink"
          >
            <ArrowLeft size={13} /> Incidents
          </Link>

          {incident === undefined ? (
            <div className="mt-6 space-y-3" aria-label="Loading incident">
              <div className="h-8 w-1/2 animate-pulse rounded-lg bg-hover" />
              <div className="h-24 animate-pulse rounded-xl bg-hover" />
            </div>
          ) : incident === null ? (
            <p className="mt-10 text-[14px] text-ink-2">This incident no longer exists.</p>
          ) : (
            <>
              <header className="mt-3">
                <p className="truncate text-[13px] text-ink-3">{incident.projectName}</p>
                <h1 className="mt-1 text-[26px] font-semibold leading-tight tracking-tight">{incident.title}</h1>
                <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-ink-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className={`h-1.5 w-1.5 rounded-full ${incident.status === "open" ? "bg-destructive" : "bg-ink-3"}`}
                    />
                    {incident.status === "open" ? "Open" : "Resolved"}
                  </span>
                  <span className="text-ink-3">·</span>
                  <span>{TRIGGER_LABELS[incident.trigger]}</span>
                  {incident.taskStatus && (
                    <>
                      <span className="text-ink-3">·</span>
                      <span>Task {taskStatusLabel(incident.taskStatus).toLowerCase()}</span>
                    </>
                  )}
                  <span className="text-ink-3">·</span>
                  <span className="tabular-nums">
                    {shortDate(incident.createdAt)} {clockTime(incident.createdAt)}
                  </span>
                </p>
                <p className="mt-2 flex gap-4 text-[13px]">
                  <Link href={`/runs/${incident.taskId}`} className="text-ink-2 underline-offset-2 hover:text-ink hover:underline">
                    Open run
                  </Link>
                  <Link href={`/runs/${incident.taskId}?view=replay`} className="text-ink-2 underline-offset-2 hover:text-ink hover:underline">
                    Replay
                  </Link>
                </p>
              </header>

              <Section title="Where it failed">
                <dl className="divide-y divide-line border-y border-line text-[13.5px]">
                  <div className="flex gap-3 py-2">
                    <dt className="w-28 shrink-0 text-ink-3">Task</dt>
                    <dd className="min-w-0 text-ink">{incident.taskTitle ?? "—"}</dd>
                  </div>
                  {incident.failurePoint?.title && (
                    <div className="flex gap-3 py-2">
                      <dt className="w-28 shrink-0 text-ink-3">Subtask</dt>
                      <dd className="min-w-0 text-ink">
                        {incident.failurePoint.title}
                        {incident.failurePoint.role ? <span className="text-ink-3"> · {incident.failurePoint.role}</span> : null}
                      </dd>
                    </div>
                  )}
                  {incident.failurePoint?.stage && (
                    <div className="flex gap-3 py-2">
                      <dt className="w-28 shrink-0 text-ink-3">Stage</dt>
                      <dd className="min-w-0 text-ink">{incident.failurePoint.stage}</dd>
                    </div>
                  )}
                </dl>
                {incident.error && (
                  <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12px] text-destructive">
                    {incident.error}
                  </pre>
                )}
              </Section>

              {incident.escalation && (
                <Section title="Escalation">
                  <p className="text-[13.5px] text-ink">
                    <span className="font-medium">{incident.escalation.kind.replace(/_/g, " ")}</span> · {incident.escalation.reason}
                  </p>
                  {incident.escalation.detail && <p className="mt-1 text-[13px] text-ink-2">{incident.escalation.detail}</p>}
                  {incident.escalation.options && incident.escalation.options.length > 0 && (
                    <ul className="mt-2 divide-y divide-line border-y border-line text-[13px]">
                      {incident.escalation.options.map((option, i) => (
                        <li key={i} className="py-1.5 text-ink-2">
                          {String.fromCharCode(65 + i)}. {option}
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
              )}

              <Section title="Owner and status">
                <div className="grid gap-2.5">
                  <label className="grid gap-1 text-[13px] text-ink-2">
                    Owner
                    <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Who is looking at this" className={field} />
                  </label>
                  <label className="grid gap-1 text-[13px] text-ink-2">
                    Note
                    <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="What happened, what was done" className={field} />
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void save(incident.status === "open" ? "resolved" : "open")}
                      className="inline-flex h-8 items-center rounded-lg bg-brand px-3 text-[13px] font-medium text-white outline-none transition hover:bg-brand-hover focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50"
                    >
                      {incident.status === "open" ? "Mark resolved" : "Reopen"}
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void save()}
                      className="inline-flex h-8 items-center rounded-lg border border-line bg-panel px-3 text-[13px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                </div>
              </Section>

              <Section title="Suggest fix" aside={<SuggestFixButton incidentId={incident._id} />}>
                <p className="text-[12.5px] text-ink-3">
                  Reads this run and proposes one change to a prompt, skill or role config. Nothing changes until you click Apply.
                </p>
                <IncidentSuggestions incidentId={incident._id} />
              </Section>

              <Section title="Last events" aside={<span className="tabular-nums text-ink-3">{incident.lastEvents.length}</span>}>
                {incident.lastEvents.length === 0 ? (
                  <p className="text-[13px] text-ink-3">No events recorded.</p>
                ) : (
                  <ul className="divide-y divide-line border-y border-line font-mono text-[12px]">
                    {incident.lastEvents.map((event, i) => (
                      <li key={i} className="flex gap-2 py-1.5">
                        <span className="w-12 shrink-0 tabular-nums text-ink-3">{clockTime(event.at)}</span>
                        <span className={`min-w-0 flex-1 break-words ${event.level === "error" ? "text-destructive" : event.level === "warn" ? "text-ink" : "text-ink-2"}`}>
                          {event.type}
                          {event.subtaskKey ? <span className="text-ink-3"> [{event.subtaskKey}]</span> : null}
                          {event.text ? <span className="text-ink"> {event.text}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="Related audit" aside={<span className="tabular-nums text-ink-3">{incident.audit.length}</span>}>
                {incident.audit.length === 0 ? (
                  <p className="text-[13px] text-ink-3">No audit rows for this task.</p>
                ) : (
                  <ul className="divide-y divide-line border-y border-line text-[13px]">
                    {incident.audit.map((row) => (
                      <li key={row._id} className="flex gap-3 py-1.5">
                        <span className="w-12 shrink-0 tabular-nums text-ink-3">{clockTime(row.createdAt)}</span>
                        <span className="min-w-0 flex-1 truncate text-ink">
                          {row.action}
                          {row.target ? <span className="text-ink-3"> · {row.target}</span> : null}
                        </span>
                        <span className="shrink-0 text-ink-3">
                          {row.actor} · {row.decision}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
