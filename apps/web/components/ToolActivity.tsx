"use client";

import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FlaskConical,
  GitBranch,
  GitMerge,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Shuffle,
  XCircle,
} from "lucide-react";

export type TaskEvent = {
  _id: string;
  type: string;
  payload?: any;
  level?: string;
  _creationTime: number;
};

const ICONS: Record<string, { icon: typeof Bot; color: string }> = {
  "task.classified": { icon: Bot, color: "text-sky-600" },
  "subtask.routed": { icon: Shuffle, color: "text-violet-600" },
  "fileChanges.updated": { icon: FilePlus2, color: "text-emerald-600" },
  "fileChanges.applied": { icon: CheckCircle2, color: "text-emerald-600" },
  "fileChanges.apply_failed": { icon: AlertTriangle, color: "text-rose-600" },
  "task.stage": { icon: Loader2, color: "text-amber-600" },
  "branch.created": { icon: GitBranch, color: "text-indigo-600" },
  "branch.merged": { icon: GitMerge, color: "text-indigo-600" },
  "branch.discarded": { icon: AlertTriangle, color: "text-amber-600" },
  "plan.replanned": { icon: RefreshCw, color: "text-amber-600" },
  "review.approved": { icon: CheckCircle2, color: "text-emerald-600" },
  "review.requested_changes": { icon: AlertTriangle, color: "text-amber-600" },
  "task.check": { icon: FlaskConical, color: "text-teal-600" },
  "task.policy_dry_run": { icon: ShieldCheck, color: "text-teal-600" },
  "task.error": { icon: XCircle, color: "text-rose-600" },
  "subtask.blocked": { icon: AlertTriangle, color: "text-amber-600" },
  "agent.context": { icon: Bot, color: "text-gray-500" },
  "review.completed": { icon: CheckCircle2, color: "text-emerald-600" },
};

export function eventLabel(event: TaskEvent): string {
  const p = event.payload ?? {};
  switch (event.type) {
    case "task.classified":
      return `Classified as ${p.kind ?? "?"}`;
    case "subtask.routed":
      return `${p.agent ?? "Agent"} picked up ${p.subtaskKey ?? "subtask"}`;
    case "fileChanges.updated":
      return `Prepared file: ${(p.filePaths ?? []).join(", ")}`;
    case "fileChanges.applied":
      return `Applied ${(p.filePaths ?? []).length} file(s)`;
    case "fileChanges.apply_failed":
      return `Failed to apply file changes`;
    case "task.stage":
      return `Stage: ${p.stage ?? "—"}`;
    case "branch.created":
      return `Worktree branch ${p.branchName ?? ""}`.trim();
    case "branch.merged":
      return `Merged ${p.branchName ?? "branch"}`;
    case "branch.discarded":
      return `Discarded worktree branch ${p.branchName ?? ""}`.trim();
    case "plan.replanned":
      return `Plan replanned (attempt ${p.replans ?? "—"})`;
    case "review.approved":
      return `Review approved`;
    case "review.requested_changes":
      return `Review requested changes`;
    case "task.check":
      return `Check ${p.check ?? ""}`.trim();
    case "task.policy_dry_run":
      return `Policy dry-run: allowed`;
    case "subtask.blocked":
      return `Subtask blocked`;
    case "agent.context":
      return `Context retry`;
    case "review.completed":
      return `Review: ${p.verdict ?? "completed"}`;
    default:
      return event.type;
  }
}

function formatTime(t: number) {
  return new Date(t).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function ToolActivity({ events }: { events: TaskEvent[] }) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (!events.length) return null;

  const visible = events.slice(-30);

  const rows: ReactNode[] = visible.map((event) => {
    const meta = ICONS[event.type] ?? { icon: Bot, color: "text-gray-500" };
    const Icon = meta.icon;
    const isOpen = !!expanded[event._id];
    return (
      <div key={event._id} className="flex items-start gap-2">
        <span className={`mt-0.5 shrink-0 ${meta.color}`}>
          {event.type === "task.stage" ? <Icon size={13} className="animate-spin" /> : <Icon size={13} />}
        </span>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setExpanded((prev) => ({ ...prev, [event._id]: !prev[event._id] }))}
            className="flex w-full items-center gap-1 text-left text-[12px] leading-4"
          >
            <span className="min-w-0 flex-1 truncate font-medium text-gray-700 dark:text-gray-200">{eventLabel(event)}</span>
            <span className="shrink-0 text-[10px] text-gray-400">{formatTime(event._creationTime)}</span>
            {isOpen ? <ChevronDown size={13} className="shrink-0 text-gray-400" /> : <ChevronRight size={13} className="shrink-0 text-gray-400" />}
          </button>
          {isOpen && (
            <pre className="mt-1 max-w-full overflow-x-auto rounded-lg bg-gray-50 p-2 font-mono text-[10px] leading-4 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              {JSON.stringify(event.payload ?? {}, null, 2)}
            </pre>
          )}
        </div>
      </div>
    );
  });

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs font-semibold text-gray-600 dark:text-gray-300"
      >
        <span className="relative flex h-2 w-2">
          <span className="absolute h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        Tool activity ({events.length})
        {open ? <ChevronDown size={14} className="ml-auto" /> : <ChevronRight size={14} className="ml-auto" />}
      </button>
      {open && <div className="space-y-2 border-t border-gray-200 px-3 py-2 dark:border-gray-800">{rows}</div>}
    </div>
  );
}
