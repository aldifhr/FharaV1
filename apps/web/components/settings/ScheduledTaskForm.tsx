"use client";

/**
 * Settings → Scheduled tasks: the create / edit form (GOAT G8). A scheduled
 * task is the user's own standing command: on its schedule (or a webhook)
 * it creates a task in a project, or sends a message to a conversation.
 * A time of day defaults to the user's time zone (Settings → General).
 */
import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import type { Id } from "@/api/convex/_generated/dataModel";
import { useToast } from "@/components/Toasts";
import { BUTTON, errorText, INPUT, Select, useAppSettings } from "./controls";
import { supportedZones } from "./TimeZoneField";
import { DEFAULT_ZONE, INTERVAL_UNITS, splitInterval, WEEKDAYS, type IntervalUnit, type ScheduledTaskRow } from "./scheduledTaskText";

const PRIMARY =
  "inline-flex h-8 items-center gap-1.5 rounded-lg border border-ink bg-ink px-3 text-[12.5px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50";
const TEXTAREA =
  "min-h-[72px] w-full rounded-lg border border-line bg-canvas px-2.5 py-2 text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-ink-3 disabled:opacity-50";

type Kind = "task" | "conversation";
type ScheduleType = "interval" | "fixed_time";

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-[12px] font-medium text-ink-2">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11.5px] text-ink-3">{hint}</p>}
    </div>
  );
}

function initialState(row: ScheduledTaskRow | null, zone: string) {
  const s = row?.schedule;
  const interval = s?.type === "interval" ? splitInterval(s.everyMs) : { amount: 1, unit: "days" as IntervalUnit };
  return {
    name: row?.name ?? "",
    projectId: (row?.projectId ?? "") as string,
    scheduleType: (s?.type ?? "fixed_time") as ScheduleType,
    amount: String(interval.amount),
    unit: interval.unit,
    timeOfDay: s?.type === "fixed_time" ? s.timeOfDay : "09:00",
    weekdays: s?.type === "fixed_time" ? (s.weekdays ?? []) : [],
    timeZone: s?.type === "fixed_time" ? (s.timeZone ?? DEFAULT_ZONE) : zone,
    kind: (row?.target.kind ?? "task") as Kind,
    text: row ? (row.target.kind === "task" ? row.target.command : row.target.content) : "",
    conversationId: row?.target.kind === "conversation" ? (row.target.conversationId as string) : "",
  };
}

export function ScheduledTaskForm({ row, onDone }: { row: ScheduledTaskRow | null; onDone: () => void }) {
  const settings = useAppSettings();
  const userZone = settings?.userTimeZone ?? DEFAULT_ZONE;
  const [form, setForm] = useState(() => initialState(row, userZone));
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const projects = useQuery(api.projects.list, {}) as { _id: string; name: string }[] | undefined;
  const conversations = useQuery(
    api.conversations.listByProject,
    form.kind === "conversation" && form.projectId ? { projectId: form.projectId as Id<"projects"> } : "skip",
  );
  const zones = useMemo(() => supportedZones(form.timeZone), [form.timeZone]);
  const create = useMutation(api.scheduledTasks.create);
  const update = useMutation(api.scheduledTasks.update);
  const toast = useToast();
  const id = row?._id ?? "new";

  const schedule = () => {
    if (form.scheduleType === "interval") {
      const unitMs = INTERVAL_UNITS.find((u) => u.value === form.unit)!.ms;
      const amount = Number(form.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Interval must be a positive number");
      return { type: "interval" as const, everyMs: Math.round(amount * unitMs) };
    }
    return {
      type: "fixed_time" as const,
      timeOfDay: form.timeOfDay,
      timeZone: form.timeZone,
      ...(form.weekdays.length ? { weekdays: [...form.weekdays].sort((a, b) => a - b) } : {}),
    };
  };
  const target = () => {
    if (form.kind === "task") {
      const permissionMode = row?.target.kind === "task" ? row.target.permissionMode : undefined;
      return { kind: "task" as const, command: form.text, ...(permissionMode ? { permissionMode } : {}) };
    }
    if (!form.conversationId) throw new Error("Choose a conversation");
    return { kind: "conversation" as const, conversationId: form.conversationId as Id<"conversations">, content: form.text };
  };

  async function submit() {
    setSaving(true);
    try {
      if (!form.projectId) throw new Error("Choose a project");
      if (row) await update({ scheduledTaskId: row._id, name: form.name, schedule: schedule(), target: target() });
      else await create({ projectId: form.projectId as Id<"projects">, name: form.name, schedule: schedule(), target: target() });
      toast("success", row ? "Scheduled task saved" : "Scheduled task created", form.name);
      onDone();
    } catch (err) {
      toast("error", "Couldn't save the scheduled task", errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="space-y-3 px-4 py-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor={`st-name-${id}`}>
          <input id={`st-name-${id}`} className={`${INPUT} w-full`} value={form.name} maxLength={120} placeholder="Nightly dependency check" onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Project" htmlFor={`st-project-${id}`} hint={row ? "A scheduled task stays in its project." : undefined}>
          <select
            id={`st-project-${id}`}
            className={`${INPUT} w-full`}
            value={form.projectId}
            disabled={Boolean(row) || projects === undefined}
            onChange={(e) => setForm((f) => ({ ...f, projectId: e.target.value, conversationId: "" }))}
          >
            <option value="">Choose a project</option>
            {(projects ?? []).map((p) => (
              <option key={p._id} value={p._id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Runs">
          <Select
            label="Schedule type"
            value={form.scheduleType}
            onChange={(next) => set("scheduleType", next)}
            options={[
              { value: "fixed_time", label: "At a time of day" },
              { value: "interval", label: "On an interval" },
            ]}
          />
        </Field>
        {form.scheduleType === "interval" ? (
          <Field label="Every" htmlFor={`st-amount-${id}`} hint="At least 1 minute.">
            <div className="flex gap-2">
              <input id={`st-amount-${id}`} type="number" min={1} className={`${INPUT} w-24`} value={form.amount} onChange={(e) => set("amount", e.target.value)} />
              <Select label="Interval unit" value={form.unit} onChange={(next) => set("unit", next)} options={INTERVAL_UNITS} />
            </div>
          </Field>
        ) : (
          <Field label="Time and zone" htmlFor={`st-time-${id}`}>
            <div className="flex gap-2">
              <input id={`st-time-${id}`} type="time" className={`${INPUT} w-28`} value={form.timeOfDay} onChange={(e) => set("timeOfDay", e.target.value)} />
              <select aria-label="Time zone" className={`${INPUT} min-w-0 flex-1`} value={form.timeZone} onChange={(e) => set("timeZone", e.target.value)}>
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </div>
          </Field>
        )}
      </div>

      {form.scheduleType === "fixed_time" && (
        <Field label="Days" hint="None selected runs every day.">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
            {WEEKDAYS.map((day, index) => {
              const on = form.weekdays.includes(index);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set("weekdays", on ? form.weekdays.filter((d) => d !== index) : [...form.weekdays, index])}
                  className={`h-7 w-11 rounded-md border text-[12px] transition-colors ${on ? "border-ink bg-ink text-canvas" : "border-line bg-canvas text-ink hover:bg-hover"}`}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </Field>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Then">
          <Select
            label="Target"
            value={form.kind}
            onChange={(next) => set("kind", next)}
            options={[
              { value: "task", label: "Create a task" },
              { value: "conversation", label: "Send to a conversation" },
            ]}
          />
        </Field>
        {form.kind === "conversation" && (
          <Field label="Conversation" htmlFor={`st-conv-${id}`}>
            <select
              id={`st-conv-${id}`}
              className={`${INPUT} w-full`}
              value={form.conversationId}
              disabled={!form.projectId || conversations === undefined}
              onChange={(e) => set("conversationId", e.target.value)}
            >
              <option value="">{form.projectId ? "Choose a conversation" : "Choose a project first"}</option>
              {(conversations ?? []).map((c) => (
                <option key={c._id} value={c._id}>
                  {c.title || "Untitled conversation"}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <Field
        label={form.kind === "task" ? "Task instructions" : "Message"}
        htmlFor={`st-text-${id}`}
        hint="A webhook delivery can fill in {{body.field}}, {{headers.name}} or {{query.name}}; its values reach the agent marked as untrusted."
      >
        <textarea id={`st-text-${id}`} className={TEXTAREA} value={form.text} maxLength={4000} onChange={(e) => set("text", e.target.value)} />
      </Field>

      <div className="flex justify-end gap-2">
        <button type="button" className={BUTTON} onClick={onDone} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className={PRIMARY} disabled={saving || !form.name.trim() || !form.text.trim()}>
          {row ? "Save" : "Create"}
        </button>
      </div>
    </form>
  );
}
