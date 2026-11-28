
import { Suspense, useState } from "react";
import { Link, useSearchParams } from "@/lib/spaRouter";
import { useMutation, useQuery } from "@fhara/runtime/react";
import { Activity, AlertTriangle, ArrowUpRight, Hash, Layers, MessageSquare, Search, ShieldAlert, Trash2 } from "lucide-react";
import { api } from "@fhara/runtime/api";
import Sidebar from "@/components/Sidebar";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import { PageHeader } from "@/components/ui/page-header";
import Segmented from "@/components/ui/segmented";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/Toasts";
import { clockTime, isSameDay, shortDate } from "@/lib/format";

const EVENT_LABEL: Record<string, string> = {
  "task.stage": "Stage",
  "task.check": "Check",
  "task.error": "Error",
  "task.steered": "You steered",
  "task.input_answered": "You answered",
  "approval.held": "Approval held",
};

const LIMIT = 100;
type LevelFilter = "all" | "error";

type ActivityEvent = {
  _id: string;
  _creationTime: number;
  type: string;
  level?: string;
  taskId?: string;
  projectId?: string;
  payload?: unknown;
};

type TaskRow = { _id: string; title: string };
type ProjectRow = { _id: string; name: string };

function eventLabel(type: string): string {
  const known = EVENT_LABEL[type];
  if (known) return known;
  const rest = type.startsWith("task.") ? type.slice("task.".length) : type;
  return rest.replaceAll(".", " ").replaceAll("_", " ");
}

function detailOf(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  for (const key of ["label", "stage", "message", "instruction", "answer", "status"]) {
    const value = p[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

function eventSummary(event: ActivityEvent): string {
  const detail = detailOf(event.payload);
  const label = eventLabel(event.type);
  return detail ? `${label} · ${detail.slice(0, 120)}` : label;
}

function EventMark({ event }: { event: ActivityEvent }) {
  const error = event.level === "error";
  const held = event.type === "approval.held";
  const answered = event.type === "task.steered" || event.type === "task.input_answered";
  const Icon = error ? AlertTriangle : held ? ShieldAlert : answered ? MessageSquare : Activity;
  return (
    <span
      aria-hidden="true"
      className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-inset ${
        error ? "text-danger" : held ? "text-warn" : "text-ink-3"
      }`}
    >
      <Icon size={13} />
    </span>
  );
}

type EventGroup = { key: string; label: string; rows: ActivityEvent[] };

function ActivityPage() {
  const projectId = useSearchParams().get("project") ?? undefined;
  const clearByProject = useMutation(api.taskEvents.clearByProject);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [type, setType] = useState("");
  const [searchText, setSearchText] = useState("");
  const allEvents = useQuery(api.taskEvents.listAll, projectId ? "skip" : { limit: LIMIT });
  const projectEvents = useQuery(
    api.taskEvents.listByProject,
    projectId ? { projectId: projectId as never, limit: LIMIT } : "skip",
  );
  const allTasks = useQuery(api.tasks.listAll, projectId ? "skip" : {});
  const projectTasks = useQuery(api.tasks.listByProject, projectId ? { projectId: projectId as never } : "skip");
  const projects = useQuery(api.projects.list, {});
  const project = useQuery(api.projects.get, projectId ? { projectId } : "skip");

  const events = ((projectId ? projectEvents : allEvents) ?? []) as ActivityEvent[];
  const tasks = ((projectId ? projectTasks : allTasks) ?? []) as TaskRow[];
  const projectRows = (projects ?? []) as ProjectRow[];
  const loaded = (projectId ? projectEvents : allEvents) !== undefined && (projectId ? projectTasks : allTasks) !== undefined;
  const titleOf = (id?: string) => (id ? tasks.find((task) => task._id === id)?.title : undefined);
  const projectNameOf = (id?: string) => (id ? projectRows.find((row) => row._id === id)?.name : undefined);
  const scopeName = projectId ? (project as { name?: string } | null | undefined)?.name ?? "Project" : undefined;

  const errorCount = events.filter((event) => event.level === "error").length;
  const taskCount = new Set(events.map((event) => event.taskId).filter(Boolean)).size;
  const typeCount = new Set(events.map((event) => event.type)).size;
  const typeOptions = [...new Set(events.map((event) => event.type))]
    .map((eventType) => ({ value: eventType, label: eventLabel(eventType) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const query = searchText.trim().toLowerCase();
  const filtered = events.filter((event) => {
    if (level === "error" && event.level !== "error") return false;
    if (type && event.type !== type) return false;
    if (!query) return true;
    return [eventSummary(event), titleOf(event.taskId), projectNameOf(event.projectId), eventLabel(event.type), event.type]
      .filter(Boolean)
      .some((part) => String(part).toLowerCase().includes(query));
  });

  const groups: EventGroup[] = [];
  for (const event of filtered) {
    const key = new Date(event._creationTime).toDateString();
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(event);
    else groups.push({ key, label: isSameDay(event._creationTime) ? "Today" : shortDate(event._creationTime), rows: [event] });
  }

  const resetFilters = () => {
    setLevel("all");
    setType("");
    setSearchText("");
  };

  const runClear = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      let total = 0;
      for (;;) {
        const result = (await clearByProject({ projectId: projectId as never })) as { deleted: number; more: boolean };
        total += result.deleted;
        if (!result.more || result.deleted === 0) break;
      }
      toast("success", "Activity cleared", `${total} ${total === 1 ? "event" : "events"} removed.`);
    } catch (err) {
      toast("error", "Couldn't clear activity", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const askClear = () =>
    setConfirm({
      title: "Clear all activity?",
      message: `Every task event in ${scopeName ?? "this project"} is removed. This cannot be undone.`,
      confirmLabel: "Clear all",
      onOk: () => void runClear(),
    });

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <Sidebar projectId={projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-8 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-[1280px]">
          <PageHeader
            eyebrow={scopeName ?? "All projects"}
            title="Activity"
            leading={
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-field border border-line bg-panel text-ink-2">
                <Activity size={17} />
              </span>
            }
            meta={
              <>
                <p className="text-[13.5px] text-ink-2">
                  Task events across {scopeName ? "this project" : "your projects"}, newest first.
                </p>
                {projectId && (
                  <p className="mt-1">
                    <Link href="/activity" className="text-[12.5px] text-ink-3 underline decoration-line underline-offset-4 transition hover:text-ink">
                      Show all projects
                    </Link>
                  </p>
                )}
              </>
            }
            actions={
              projectId ? (
                <button
                  type="button"
                  disabled={events.length === 0 || busy}
                  onClick={askClear}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-field border border-line bg-panel px-2.5 text-[12.5px] text-ink-3 outline-none transition hover:border-danger/40 hover:bg-danger/5 hover:text-danger focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40"
                >
                  <Trash2 size={14} />
                  {busy ? "Clearing…" : "Clear all activity"}
                </button>
              ) : undefined
            }
          />

          {!loaded ? (
            <div className="mt-6 space-y-4" aria-label="Loading activity">
              <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-line bg-panel shadow-card sm:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="p-5">
                    <div className="h-3 w-16 rounded bg-hover" />
                    <div className="mt-3 h-8 w-12 rounded bg-hover" />
                  </div>
                ))}
              </div>
              <div className="h-64 rounded-2xl border border-line bg-panel shadow-card" />
            </div>
          ) : events.length === 0 ? (
            <div className="mt-12 flex flex-col items-center rounded-2xl border border-dashed border-line bg-panel px-5 py-10 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-inset text-ink-3">
                <Activity size={18} />
              </span>
              <p className="mt-4 text-[14px] text-ink-2">No activity yet.</p>
              <p className="mt-1 text-[13px] text-ink-3">Run a task to see its stages, checks and approvals here.</p>
            </div>
          ) : (
            <>
              <section
                aria-label="Activity metrics"
                className="mt-6 grid grid-cols-2 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel shadow-card sm:divide-y-0 sm:divide-x lg:grid-cols-4"
              >
                {[
                  { label: "Loaded", value: events.length, note: "recent events", icon: <Layers size={13} />, tone: "", title: "Events loaded for this scope" },
                  { label: "Errors", value: errorCount, note: "need a look", icon: <AlertTriangle size={13} />, tone: errorCount > 0 ? "text-danger" : "", title: "Error-level events among the loaded events" },
                  { label: "Tasks", value: taskCount, note: "touched", icon: <Activity size={13} />, tone: "", title: "Distinct tasks with an event in this list" },
                  { label: "Types", value: typeCount, note: "event kinds", icon: <Hash size={13} />, tone: "", title: "Distinct event types among the loaded events" },
                ].map((metric) => (
                  <div key={metric.label} className="p-4 sm:p-5" title={metric.title}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-caption">{metric.label}</span>
                      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-inset text-ink-3">{metric.icon}</span>
                    </div>
                    <div className="mt-2 flex items-baseline gap-2">
                      <span className={`text-[28px] font-semibold leading-none tracking-[-0.03em] tabular-nums ${metric.tone || "text-ink"}`}>
                        {metric.value}
                      </span>
                      <span className="truncate text-[12px] text-ink-3">{metric.note}</span>
                    </div>
                  </div>
                ))}
              </section>

              <div className="mt-5 flex flex-wrap items-center gap-2">
                <Segmented
                  label="Filter activity by level"
                  value={level}
                  onChange={setLevel}
                  options={[
                    { value: "all", label: "All" },
                    { value: "error", label: "Errors" },
                  ]}
                />
                <select
                  aria-label="Event type"
                  value={type}
                  onChange={(event) => setType(event.target.value)}
                  className="h-[30px] w-auto max-w-[220px] rounded-field border border-line bg-panel px-2.5 text-[12.5px] text-ink-2 outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30"
                >
                  <option value="">All types</option>
                  {typeOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <div className="relative w-full sm:ml-auto sm:w-64">
                  <Search size={14} className="pointer-events-none absolute left-2.5 top-2 text-ink-3" />
                  <Input
                    type="search"
                    value={searchText}
                    onChange={(event) => setSearchText(event.target.value)}
                    placeholder="Search events"
                    aria-label="Search activity"
                    className="h-[30px] bg-panel pl-8 text-[12.5px]"
                  />
                </div>
              </div>

              {filtered.length === 0 ? (
                <div className="mt-3 flex flex-col items-center rounded-2xl border border-line bg-panel px-5 py-10 text-center">
                  <p className="text-[13px] text-ink-2">No events match these filters.</p>
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="mt-3 rounded-field border border-line bg-panel px-2.5 py-1 text-[12.5px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30"
                  >
                    Clear filters
                  </button>
                </div>
              ) : (
                <>
                  <div className="mt-4 space-y-4">
                    {groups.map((group) => (
                      <section key={group.key} aria-label={group.label}>
                        <div className="mb-1.5 flex items-center gap-2 px-1">
                          <h2 className="text-caption">{group.label}</h2>
                          <span aria-hidden="true" className="h-px flex-1 bg-line" />
                          <span className="text-[11.5px] tabular-nums text-ink-3">{group.rows.length}</span>
                        </div>
                        <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
                          <ul className="divide-y divide-line">
                            {group.rows.map((event) => {
                              const error = event.level === "error";
                              const title = titleOf(event.taskId);
                              const name = projectId ? undefined : projectNameOf(event.projectId);
                              return (
                                <li key={event._id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 transition-colors hover:bg-inset/60">
                                  <div className="flex min-w-0 flex-1 items-start gap-2.5 max-sm:basis-full">
                                    <EventMark event={event} />
                                    <div className="min-w-0 flex-1">
                                      <p className={`truncate text-[13px] ${error ? "text-danger" : "text-ink"}`}>{eventSummary(event)}</p>
                                      <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11.5px] text-ink-3">
                                        {event.taskId ? (
                                          <Link href={`/runs/${event.taskId}`} className="min-w-0 max-w-full truncate transition hover:text-ink hover:underline">
                                            {title ?? "Task"}
                                          </Link>
                                        ) : (
                                          <span>Task</span>
                                        )}
                                        {name && <span>· {name}</span>}
                                        <span>· {eventLabel(event.type)}</span>
                                      </p>
                                    </div>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-2 max-sm:ml-9">
                                    <span className="w-12 text-right text-[11.5px] tabular-nums text-ink-3">{clockTime(event._creationTime)}</span>
                                    {event.taskId ? (
                                      <Link
                                        href={`/runs/${event.taskId}`}
                                        aria-label={`Open task ${title ?? event.taskId}`}
                                        className="flex h-7 w-7 items-center justify-center rounded-field text-ink-3 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30"
                                      >
                                        <ArrowUpRight size={14} />
                                      </Link>
                                    ) : (
                                      <span className="w-7" />
                                    )}
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      </section>
                    ))}
                  </div>
                  <p className="mt-2 text-[12px] text-ink-3">Showing {filtered.length} of {events.length} events.</p>
                </>
              )}
            </>
          )}
        </div>
      </main>
      <ConfirmDialog
        request={confirm}
        pending={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void runClear()}
      />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ActivityPage />
    </Suspense>
  );
}
