"use client";

/**
 * Settings → Scheduled tasks: the user's own scheduled tasks (GOAT G8).
 * Each row shows its schedule, target, last and next run, an enabled
 * switch, Run now, Edit and Delete (ConfirmDialog); opening a row shows its
 * recent runs and its webhook. Firing is the user's standing command; chat
 * never starts one on its own.
 */
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toasts";
import { BUTTON, errorText, LINK_BUTTON, relativeTime, Row, Section, Toggle, useAppSettings } from "./controls";
import { ScheduledTaskForm } from "./ScheduledTaskForm";
import { ScheduledTaskWebhook } from "./ScheduledTaskWebhook";
import { DEFAULT_ZONE, formatWhen, lastStatusText, runText, scheduleText, targetText, type ScheduledTaskRow } from "./scheduledTaskText";

function RecentRuns({ row, zone }: { row: ScheduledTaskRow; zone: string }) {
  const runs = useQuery(api.scheduledTasks.listRuns, { scheduledTaskId: row._id });
  return (
    <div className="space-y-1">
      <p className="text-[12px] font-medium text-ink">Recent runs</p>
      {runs === undefined && <p className="text-[11.5px] text-ink-3">Loading…</p>}
      {runs?.length === 0 && <p className="text-[11.5px] text-ink-3">No runs yet.</p>}
      {runs && runs.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {runs.map((run) => (
            <li key={run._id} className="flex items-baseline justify-between gap-4 px-3 py-2 text-[11.5px]">
              <span className="min-w-0 text-ink">{runText(run)}</span>
              <span className="shrink-0 text-ink-3">{formatWhen(run.firedAt, zone)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TaskRow({ row, zone, onEdit, onDelete }: { row: ScheduledTaskRow; zone: string; onEdit: () => void; onDelete: () => void }) {
  const setEnabled = useMutation(api.scheduledTasks.setEnabled);
  const runNow = useMutation(api.scheduledTasks.runNow);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const next = row.enabled && row.nextRunAt ? `Next ${formatWhen(row.nextRunAt, zone)}` : row.enabled ? "No next run" : "Paused";
  const last = row.lastRunAt ? `${lastStatusText(row.lastStatus)} ${relativeTime(row.lastRunAt)}` : "Not run yet";
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-ink">{row.name}</p>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">
            {scheduleText(row.schedule)} · {targetText(row)}
            <span className="block">
              {last} · {next}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await runNow({ scheduledTaskId: row._id });
                toast("success", "Started", row.name);
              } catch (err) {
                toast("error", "Couldn't run the scheduled task", errorText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Run now
          </button>
          <Toggle
            label={`${row.enabled ? "Pause" : "Enable"} ${row.name}`}
            checked={row.enabled}
            onChange={async (enabled) => {
              try {
                await setEnabled({ scheduledTaskId: row._id, enabled });
              } catch (err) {
                toast("error", "Couldn't change the scheduled task", errorText(err));
              }
            }}
          />
        </div>
      </div>
      <div className="mt-2 flex gap-3">
        <button type="button" className={LINK_BUTTON} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide details" : "Runs and webhook"}
        </button>
        <button type="button" className={LINK_BUTTON} onClick={onEdit}>
          Edit
        </button>
        <button type="button" className={LINK_BUTTON} onClick={onDelete}>
          Delete
        </button>
      </div>
      {open && (
        <div className="mt-3 space-y-4">
          <RecentRuns row={row} zone={zone} />
          <ScheduledTaskWebhook row={row} />
        </div>
      )}
    </div>
  );
}

export function ScheduledTaskList() {
  const rows = useQuery(api.scheduledTasks.listForViewer, {});
  const settings = useAppSettings();
  const zone = settings?.userTimeZone ?? DEFAULT_ZONE;
  const remove = useMutation(api.scheduledTasks.remove);
  const toast = useToast();
  const [editing, setEditing] = useState<ScheduledTaskRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<ScheduledTaskRow | null>(null);
  const [pending, setPending] = useState(false);
  const request: ConfirmRequest | null = deleting
    ? {
        title: "Delete scheduled task?",
        message: `"${deleting.name}" stops running and its run history is removed. Tasks it already created stay.`,
        confirmLabel: "Delete",
      }
    : null;

  return (
    <Section
      title="Scheduled tasks"
      description="Your standing commands: at a time, on an interval or from a webhook, each one creates a task or sends a message. They skip their turn while automation is held."
    >
      {editing === "new" ? (
        <ScheduledTaskForm row={null} onDone={() => setEditing(null)} />
      ) : (
        <Row label="New scheduled task" description="Times use your time zone unless you pick another.">
          <button type="button" className={BUTTON} onClick={() => setEditing("new")}>
            New
          </button>
        </Row>
      )}
      {rows === undefined && <Row label="Loading…" />}
      {rows?.length === 0 && editing !== "new" && <Row label="No scheduled tasks yet" />}
      {(rows ?? []).map((row) =>
        editing !== null && editing !== "new" && editing._id === row._id ? (
          <ScheduledTaskForm key={row._id} row={row} onDone={() => setEditing(null)} />
        ) : (
          <TaskRow key={row._id} row={row} zone={zone} onEdit={() => setEditing(row)} onDelete={() => setDeleting(row)} />
        ),
      )}
      <ConfirmDialog
        request={request}
        pending={pending}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          setPending(true);
          try {
            await remove({ scheduledTaskId: deleting._id });
            toast("success", "Scheduled task deleted", deleting.name);
            setDeleting(null);
          } catch (err) {
            toast("error", "Couldn't delete the scheduled task", errorText(err));
          } finally {
            setPending(false);
          }
        }}
      />
    </Section>
  );
}
