"use client";

import type { ReactNode } from "react";
import { SkeletonBox } from "skullet/react";
import { StatusTag } from "../ui/status-tag";
import { InspectorBody } from "../ui/inspector";

/** One read-only block: caption label over an inset body. */
function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-1.5">
      <h3 className="text-caption">{title}</h3>
      <div className="rounded-field bg-inset p-2.5 text-[13px] text-ink-2">{children}</div>
    </section>
  );
}

/** Plain comma list in place of the old tinted tags. */
function ValueList({ values }: { values: string[] }) {
  if (!values.length) return <p className="text-ink-3">None.</p>;
  return <p className="text-mono-id break-words leading-relaxed">{values.join(", ")}</p>;
}

function formatTime(epoch: number | null | undefined) {
  if (epoch == null) return "—";
  return new Date(epoch).toLocaleString();
}

export type ActiveExecution = { taskId: string; taskTitle: string; subtaskKey?: string; status: string };
type HistoryRow = {
  executionId: string;
  status: string;
  taskTitle?: string;
  subtaskKey?: string;
  error?: string;
  completedAt?: number;
  startedAt?: number;
  createdAt?: number;
};

/**
 * Inspector → Activity (dashboard F4): what the role does, what it may use,
 * where it is assigned, and its recent executions. Read-only.
 */
export default function AgentActivity({
  loading,
  responsibilities,
  capabilities,
  capabilitiesFromRole,
  tools,
  toolsAreCustom,
  toolOverrides,
  runtime,
  projects,
  active,
  activeLabel,
  openTasks,
  history,
}: {
  loading: boolean;
  responsibilities: string[];
  capabilities: string[];
  capabilitiesFromRole: boolean;
  tools: string[];
  toolsAreCustom: boolean;
  toolOverrides: Array<{ projectName: string; tools: string[] }>;
  runtime: string;
  projects: Array<{ projectId: string; name: string }>;
  active: ActiveExecution | undefined;
  activeLabel: string;
  openTasks: Array<{ taskId: string; title: string; status: string }>;
  history: HistoryRow[] | undefined;
}) {
  return (
    <InspectorBody>
      {loading && (
        <div aria-hidden className="space-y-2">
          <SkeletonBox height={12} width="90%" />
          <SkeletonBox height={12} width="70%" />
        </div>
      )}

      <Block title="Now">
        {active ? (
          <p className="flex flex-wrap items-center gap-2">
            <StatusTag tone="active">{activeLabel}</StatusTag>
            <span className="text-ink">{active.taskTitle}</span>
            {active.subtaskKey && <span className="text-mono-id">{active.subtaskKey}</span>}
          </p>
        ) : (
          <p className="text-ink-3">Idle, no active execution.</p>
        )}
        {openTasks.length > 0 && (
          <ul className="mt-2 space-y-1 text-[12.5px]">
            {openTasks.map((task) => (
              <li key={task.taskId}>
                Open task: <span className="font-medium text-ink">{task.title}</span> ({task.status})
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title="Role">
        <p>{responsibilities[0] ?? "No role description."}</p>
        {responsibilities.length > 1 && (
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {responsibilities.slice(1).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </Block>

      <Block title="Capabilities">
        <ValueList values={capabilities} />
        {capabilitiesFromRole && capabilities.length > 0 && <p className="mt-1 text-[12px] text-ink-3">From role defaults. Set on the agent to override.</p>}
      </Block>

      <Block title="Tool permissions">
        <ValueList values={tools} />
        <p className="mt-1 text-[12px] text-ink-3">{toolsAreCustom ? "Custom for this agent." : "Role defaults."}</p>
        {toolOverrides.length > 0 && (
          <ul className="mt-2 space-y-1 text-[12.5px]">
            {toolOverrides.map((row) => (
              <li key={row.projectName}>
                Project override on <span className="font-medium text-ink">{row.projectName}</span>: {row.tools.join(", ")}
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title="Runtime">
        <p>{runtime}</p>
      </Block>

      <Block title="Assigned projects">
        {projects.length === 0 ? <p className="text-ink-3">No projects using this agent.</p> : <p>{projects.map((p) => p.name).join(", ")}</p>}
      </Block>

      <section className="grid gap-1.5">
        <h3 className="text-caption">Recent executions</h3>
        {history === undefined ? (
          <div aria-hidden className="space-y-2">
            <SkeletonBox height={12} width="80%" />
            <SkeletonBox height={12} width="60%" />
          </div>
        ) : history.length === 0 ? (
          <p className="rounded-field bg-inset p-2.5 text-[13px] text-ink-3">No executions yet.</p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-field border border-line">
            {history.map((row) => (
              <li key={row.executionId} className="px-3 py-2 text-[12.5px]">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusTag tone={row.status === "failed" ? "danger" : row.status === "completed" ? "ok" : "neutral"}>{row.status}</StatusTag>
                  <span className="min-w-0 truncate font-medium text-ink">{row.taskTitle ?? "Unknown task"}</span>
                  {row.subtaskKey && <span className="text-mono-id">{row.subtaskKey}</span>}
                  <span className="ml-auto text-ink-3">{formatTime(row.completedAt ?? row.startedAt ?? row.createdAt)}</span>
                </div>
                {row.error && <p className="mt-1 text-danger">{row.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </InspectorBody>
  );
}
