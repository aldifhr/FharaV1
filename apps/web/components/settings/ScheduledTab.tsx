"use client";

/**
 * Settings → Scheduled tasks: the automation hold (GOAT G3), the user's own
 * scheduled tasks (G8, ScheduledTaskList.tsx) and the backend's maintenance
 * jobs. The hold is `appSettings.automationHold`; while it
 * is on, auto-merge, issue intake, automatic PR-fix tasks and the jobs
 * marked below do nothing, and the user's own tasks still run.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "@/components/Toasts";
import { BUTTON, errorText, relativeTime, Row, Section, Toggle } from "./controls";
import { ScheduledTaskList } from "./ScheduledTaskList";

type Job = NonNullable<ReturnType<typeof useQuery<typeof api.cronJobs.list>>>[number];

function lastRunText(job: Job): string {
  if (job.lastStatus === null) return "Not run yet";
  if (job.lastStatus === "running") return `Running since ${relativeTime(job.lastStartedAt)}`;
  const when = relativeTime(job.lastFinishedAt ?? job.lastStartedAt);
  const label = job.lastStatus === "ok" ? "Last run" : job.lastStatus === "held" ? "Skipped (automation held)" : "Failed";
  return `${label} ${when}${job.trigger === "manual" ? " (manual)" : ""}`;
}

export function AutomationHoldRow() {
  const hold = useQuery(api.appSettings.automationHold, {});
  const setHold = useMutation(api.appSettings.setAutomationHold);
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const held = hold !== undefined && hold !== null;
  return (
    <Row
      label="Hold automation"
      description={
        held
          ? `Held since ${relativeTime(hold.heldAt)}. Auto-merge, issue intake, automatic PR fixes and the jobs marked below wait. Your own tasks still run.`
          : "Stop everything Fhara starts on its own: auto-merge, issue intake, automatic PR fixes and the jobs marked below. Your own tasks still run."
      }
    >
      <Toggle
        label="Hold automation"
        checked={held}
        disabled={hold === undefined || saving}
        onChange={async (next) => {
          setSaving(true);
          try {
            const result = await setHold({ held: next });
            toast(
              "success",
              next ? "Automation held" : "Automation resumed",
              !next && result.resumed > 0 ? `${result.resumed} pull request${result.resumed === 1 ? "" : "s"} re-checked for auto-merge` : undefined
            );
          } catch (err) {
            toast("error", "Couldn't change the automation hold", errorText(err));
          } finally {
            setSaving(false);
          }
        }}
      />
    </Row>
  );
}

export function ScheduledTab() {
  const jobs = useQuery(api.cronJobs.list, {});
  const runNow = useMutation(api.cronJobs.runNow);
  const toast = useToast();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <Section title="Automation" description="One switch for every path that acts without you. Releasing it resumes where things left off.">
        <AutomationHoldRow />
      </Section>
      <ScheduledTaskList />
      <Section title="Maintenance jobs" description="Background jobs the backend runs on a timer. Times are recorded from their first run after this update.">
        {jobs === undefined && <Row label="Loading…" />}
        {(jobs ?? []).map((job) => (
          <Row
            key={job.name}
            stacked
            label={job.name.charAt(0).toUpperCase() + job.name.slice(1)}
            description={
              <>
                {job.schedule} · {job.description} {job.heldByAutomationHold ? "Waits while automation is held." : "Keeps running while automation is held."}
                <span className="block">
                  {lastRunText(job)}
                  {job.lastStatus === "failed" && job.lastError ? `: ${job.lastError}` : ""}
                  {job.lastStatus === "ok" && job.lastResult && job.lastResult !== "null" ? ` · ${job.lastResult}` : ""}
                </span>
              </>
            }
          >
            <button
              type="button"
              className={BUTTON}
              disabled={job.lastStatus === "running"}
              onClick={async () => {
                try {
                  await runNow({ name: job.name });
                  toast("success", "Started", job.name);
                } catch (err) {
                  toast("error", "Couldn't start the job", errorText(err));
                }
              }}
            >
              Run now
            </button>
          </Row>
        ))}
      </Section>
    </>
  );
}
