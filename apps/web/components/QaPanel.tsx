"use client";
import { CheckCircle2, MinusCircle, Monitor, Smartphone, Tablet, XCircle } from "lucide-react";

type TaskEvent = {
  _id: string;
  type: string;
  payload?: any;
  _creationTime: number;
};

type EvalCheck = { name?: string; label?: string; status?: string; details?: string };

const VIEWPORTS = [
  { key: "desktop", label: "Desktop", width: 1440, height: 900, Icon: Monitor },
  { key: "tablet", label: "Tablet", width: 768, height: 1024, Icon: Tablet },
  { key: "mobile", label: "Mobile", width: 375, height: 812, Icon: Smartphone },
] as const;

function statusIcon(status: string) {
  return status === "passed"
    ? <CheckCircle2 size={14} className="text-emerald-600" />
    : status === "failed"
      ? <XCircle size={14} className="text-rose-600" />
      : <MinusCircle size={14} className="text-amber-500" />;
}

function timeLabel(ts: number) {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/**
 * QA results for a task, derived from real backend data only:
 * - `task.check` events emitted by the worker QA runner
 *   (worker `execution/qa.ts`: "desktop viewport", "tablet viewport",
 *   "mobile viewport" at 1440 / 768 / 375) and the static verifier
 *   (`verify:*` labels),
 * - the persisted `evaluations` row (`executionView.getForTask().evaluation`).
 * Renders an honest empty state when neither exists — no invented results.
 */
export default function QaPanel({
  events,
  evaluation,
}: {
  events: TaskEvent[] | undefined;
  evaluation?: { verdict: string; checks?: EvalCheck[]; notes?: string } | null;
}) {
  const checks = (events ?? []).filter((e) => e.type === "task.check");
  const viewportRows = VIEWPORTS.map((vp) => {
    const matches = checks.filter((e) => (e.payload?.label ?? "").toLowerCase().startsWith(vp.key));
    const latest = matches[matches.length - 1];
    return {
      ...vp,
      status: (latest?.payload?.status as string | undefined) ?? null,
      details: latest?.payload?.details as string | undefined,
      at: latest?._creationTime,
    };
  }).filter((row) => row.status !== null);
  const otherChecks = checks.filter(
    (e) => !VIEWPORTS.some((vp) => (e.payload?.label ?? "").toLowerCase().startsWith(vp.key))
  );
  const evalChecks = evaluation?.checks ?? [];
  // The same verification check is recorded both as a task.check event
  // (worker) and inside the evaluation row — merge by name so it only
  // renders once (the event's details win when both exist).
  const mergedChecks = [
    ...otherChecks.map((e) => ({
      name: e.payload?.label ?? "check",
      status: e.payload?.status ?? "inconclusive",
      details: e.payload?.details,
    })),
    ...evalChecks.filter(
      (c) =>
        !otherChecks.some((e) => (e.payload?.label ?? "") === (c.name ?? c.label ?? ""))
    ),
  ];

  // Nothing ran: render nothing. The old dashed placeholder promised
  // "Responsive QA (Desktop/Tablet/Mobile) … once the worker runs them"
  // even for structural-only tasks that never run viewport checks.
  if (checks.length === 0 && !evaluation) return null;

  return (
    <section className="overflow-hidden rounded-xl border border-[#e5e3eb] bg-white dark:border-gray-800 dark:bg-gray-900">
      <header className="flex items-center justify-between border-b border-[#eeeef3] px-3.5 py-2.5 dark:border-gray-800">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">QA checks</h3>
        {evaluation && (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              evaluation.verdict === "passed"
                ? "bg-emerald-100 text-emerald-700"
                : evaluation.verdict === "inconclusive"
                  ? "bg-amber-100 text-amber-700"
                  : "bg-rose-100 text-rose-700"
            }`}
          >
            {evaluation.verdict}
          </span>
        )}
      </header>
      {viewportRows.length > 0 && (
        <ul className="divide-y divide-[#f0eff4] dark:divide-gray-800">
          {viewportRows.map((row) => (
            <li key={row.key} className="flex items-center gap-2.5 px-3.5 py-2.5">
              <row.Icon size={15} className="shrink-0 text-gray-400" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium dark:text-white">
                  {row.label} <span className="font-normal text-gray-400">{row.width}px</span>
                </p>
                {row.details && <p className="mt-0.5 truncate text-xs text-gray-500">{row.details}</p>}
              </div>
              {row.at && <span className="shrink-0 text-[11px] text-gray-400">{timeLabel(row.at)}</span>}
              <span className="shrink-0">{statusIcon(row.status ?? "inconclusive")}</span>
              <span className="w-20 shrink-0 text-right text-xs font-medium capitalize text-gray-500">{row.status}</span>
            </li>
          ))}
        </ul>
      )}
      {(mergedChecks.length > 0) && (
        <div className="border-t border-[#eeeef3] px-3.5 py-3 dark:border-gray-800">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Test results</h4>
          <ul className="mt-2 space-y-1.5">
            {mergedChecks.map((c, i) => (
              <li key={`check-${i}`} className="flex items-center gap-2 text-xs dark:text-white">
                {statusIcon(c.status ?? "inconclusive")}
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {c.details && <span className="hidden max-w-40 truncate text-gray-400 sm:block">{c.details}</span>}
                <span className="shrink-0 capitalize text-gray-400">{c.status ?? ""}</span>
              </li>
            ))}
          </ul>
          {evaluation?.notes && <p className="mt-2 text-xs text-gray-500">{evaluation.notes}</p>}
        </div>
      )}
    </section>
  );
}
