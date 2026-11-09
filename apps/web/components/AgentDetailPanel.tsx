"use client";

import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import AgentAvatar from "./AgentAvatar";
import Modal from "./Modal";
import { Badge } from "./ui/badge";
import { SkeletonBox } from "skullet/react";
import { roleLabel } from "@/lib/agentRoles";

/**
 * Mirrors `packages/worker/src/orchestrator/roles.ts` ROLE_DEFINITIONS.
 * Used as a fallback when the backend `roleDefinitions` row is missing,
 * and for the responsibilities hint which only lives in the worker.
 */
const ROLE_FALLBACK: Record<
  string,
  { displayName: string; category: string; description: string; defaultCapabilities: string[]; defaultTools: string[]; systemPromptHint: string }
> = {
  cto: {
    displayName: "CTO",
    category: "Leadership",
    description: "Technical architecture, technical decisions, code review, risk evaluation.",
    defaultCapabilities: ["architecture", "security-audit"],
    defaultTools: ["read_file"],
    systemPromptHint: "Decide technical approach, architecture, and risk with brief rationale. Read-only planning and review — no code writing, no over-engineering. Report to the owner in 2-3 plain-language sentences, no bullets, headers, or terminal output.",
  },
  designer: {
    displayName: "Designer",
    category: "Product",
    description: "UI and UX design, wireframes, design system, component specifications.",
    defaultCapabilities: ["ui-ux-design"],
    defaultTools: ["read_file", "write_file"],
    systemPromptHint: "Produce implementable design specs (layout, components, tokens, states, responsive) with accessibility considered. Design only — no code edits.",
  },
  frontend: {
    displayName: "Frontend Developer",
    category: "Engineering",
    description: "React and Next.js development. UI implementation.",
    defaultCapabilities: ["frontend-development"],
    defaultTools: ["read_file", "write_file", "run_command"],
    systemPromptHint: "Implement exactly the assigned frontend subtask, reusing UI primitives; strict TypeScript, accessible markup, English copy. Report changed files and limits. Never mark the global task complete.",
  },
  backend: {
    displayName: "Backend Developer",
    category: "Engineering",
    description: "API development and server-side business logic.",
    defaultCapabilities: ["backend-development"],
    defaultTools: ["read_file", "write_file", "run_command"],
    systemPromptHint: "Implement exactly the assigned backend subtask (Convex functions, schema, validation), keeping security invariants and additive schema changes. Report changed files and limits. Never mark the global task complete.",
  },
  qa: {
    displayName: "QA Engineer",
    category: "Quality",
    description: "Test planning, execution, bug detection, quality verification.",
    defaultCapabilities: ["browser-testing"],
    defaultTools: ["read_file", "run_command"],
    systemPromptHint: "Verify with the narrowest relevant checks and report evidence. Distinguish executed tests from proposed ones — never fabricate results. Defects go back to the implementer with a concrete repro.",
  },
  support: {
    displayName: "Support Specialist",
    category: "Operations",
    description: "Documentation, user support, operational assistance, troubleshooting.",
    defaultCapabilities: ["documentation-support"],
    defaultTools: ["read_file", "write_file"],
    systemPromptHint: "Answer the actual question first, then the how. Never invent features or behavior — check the code or say it is unknown. Docs and guidance only, no code changes.",
  },
  devops: {
    displayName: "DevOps Engineer",
    category: "Engineering",
    description: "Docker, CI/CD, deployment, infrastructure.",
    defaultCapabilities: ["shell-execution", "backend-development"],
    defaultTools: ["read_file", "run_command"],
    systemPromptHint: "Changes are policy-gated. Prefer minimal, reversible infra changes; report exact commands run and their output.",
  },
  reviewer: {
    displayName: "Reviewer",
    category: "Quality",
    description: "Independent code review. Evaluates implementation quality.",
    defaultCapabilities: ["code-review"],
    defaultTools: ["read_file"],
    systemPromptHint: "Review diffs independently with file references. Never silently modify code or approve your own work.",
  },
  researcher: {
    displayName: "Researcher",
    category: "Research",
    description: "Technical research and information gathering.",
    defaultCapabilities: ["research"],
    defaultTools: ["read_file"],
    systemPromptHint: "Prefer official docs; distinguish facts from assumptions with sources. Read-only research — no file modifications.",
  },
};

/** Status from the backend execution lease — never the persisted `agents.status`. */
export function statusFromActive(
  active: { status: string; subtaskKey?: string } | undefined,
): { label: string; avatar: "working" | "queued" | "needs_you" | "idle" } {
  if (!active) return { label: "Idle", avatar: "idle" };
  if (active.status === "waiting_approval") return { label: "Waiting", avatar: "needs_you" };
  if (active.status === "queued") return { label: "Thinking", avatar: "queued" };
  if (active.status === "blocked") return { label: "Blocked", avatar: "needs_you" };
  if (active.status === "completed") return { label: "Completed", avatar: "idle" };
  if (active.status === "failed") return { label: "Failed", avatar: "needs_you" };
  if (active.subtaskKey?.includes("review") || active.status === "reviewing") return { label: "Reviewing", avatar: "working" };
  return { label: "Working", avatar: "working" };
}

function ChipRow({ values }: { values: string[] }) {
  if (!values.length) return <p className="text-xs text-gray-400">None.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <Badge key={value} variant="secondary" className="text-[11px]">
          {value}
        </Badge>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{title}</h3>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

function formatTime(epoch: number | null | undefined) {
  if (epoch == null) return "—";
  return new Date(epoch).toLocaleString();
}

export default function AgentDetailPanel({
  agent,
  onClose,
  onEdit,
  onRemove,
}: {
  agent: any;
  onClose: () => void;
  onEdit: (agent: any) => void;
  /** Delete the agent (asks for confirmation upstream). */
  onRemove?: (agent: any) => void;
}) {
  const detail = useQuery(api.agents.getDetail, { agentId: agent._id as never });
  const history = useQuery(api.agents.getExecutionHistory, { agentId: agent._id as never, limit: 20 });
  const activeByAgent = useQuery(api.executionView.activeByAgent, {});
  const active = (activeByAgent as any)?.[agent._id as string] as
    | { taskId: string; taskTitle: string; subtaskKey?: string; status: string }
    | undefined;
  const status = statusFromActive(active);

  const rawRole = (agent.role ?? "").trim().toLowerCase();
  // Retired roles (ui-ux, product-analyst) display as their successor.
  const roleKey = rawRole === "ui-ux" ? "designer" : rawRole === "product-analyst" ? "researcher" : rawRole;
  const fallback = ROLE_FALLBACK[roleKey];
  const roleDefinition = (detail as any)?.roleDefinition;
  const roleName: string = roleLabel(agent.role);
  const roleDescription: string = roleDefinition?.description ?? fallback?.description ?? "";
  const responsibilities: string[] = [
    ...(roleDescription ? [roleDescription] : []),
    ...(fallback?.systemPromptHint ? [fallback.systemPromptHint] : []),
  ];
  // Backend returns [] (not null) when an agent has no explicit caps and
  // no synced roleDefinition row, so an empty array must fall through to
  // the role defaults just like a missing value does.
  const capabilities: string[] =
    (detail as any)?.effectiveCapabilities?.length
      ? (detail as any).effectiveCapabilities
      : (agent.capabilities?.length ? agent.capabilities : (fallback?.defaultCapabilities ?? []));
  const effectiveTools: string[] =
    (detail as any)?.effectiveTools?.length
      ? (detail as any).effectiveTools
      : (agent.supportedTools?.length ? agent.supportedTools : (fallback?.defaultTools ?? []));
  const toolsAreCustom: boolean =
    (detail as any)?.effectiveTools?.length
      ? ((detail as any)?.toolsAreCustom ?? agent.supportedTools !== undefined)
      : agent.supportedTools !== undefined;
  const assignedProjects: any[] = (detail as any)?.assignedProjects ?? [];
  const assignments: any[] = (detail as any)?.projectAssignments ?? [];
  const assignedTasks: any[] = (detail as any)?.assignedTasks ?? [];

  return (
    <Modal title={roleName} onClose={onClose} fullScreen>
      <div className="mt-4 space-y-5">
        <div className="flex items-center gap-3">
          <AgentAvatar name={roleLabel(agent.role)} size={44} status={status.avatar === "idle" ? undefined : status.avatar} avatarParams={agent.avatarParams} />
          <div className="min-w-0">
            <p className="text-sm font-medium">{fallback?.displayName ?? roleName}</p>
            <p className="text-xs capitalize text-gray-500">
              {roleDefinition?.category ?? fallback?.category ?? fallback?.displayName ?? "Agent"}
            </p>
          </div>
          <span className="ml-auto flex items-center gap-2">
            <Badge variant={status.avatar === "working" ? "default" : "secondary"}>{status.label}</Badge>
            <button
              type="button"
              onClick={() => onEdit(agent)}
              className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-hover"
            >
              Edit agent
            </button>
            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(agent)}
                className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                Remove
              </button>
            )}
          </span>
        </div>

        {detail === undefined && (
          <div aria-hidden className="space-y-2">
            <SkeletonBox height={12} width="90%" />
            <SkeletonBox height={12} width="70%" />
          </div>
        )}

        <Section title="Role description">
          <p className="text-sm text-gray-600 dark:text-gray-300">{responsibilities[0] ?? "No role description."}</p>
        </Section>

        {responsibilities.length > 1 && (
          <Section title="Responsibilities">
            <ul className="list-disc space-y-1 pl-5 text-sm text-gray-600 dark:text-gray-300">
              {responsibilities.slice(1).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="Capabilities">
          <ChipRow values={capabilities} />
          {agent.capabilities === undefined && capabilities.length > 0 && (
            <p className="mt-1 text-[11px] text-gray-400">From role defaults — set on the agent to override.</p>
          )}
        </Section>

        <Section title="Tool permissions">
          <ChipRow values={effectiveTools} />
          <p className="mt-1 text-[11px] text-gray-400">
            {toolsAreCustom ? "Custom for this agent." : "Role defaults."}
          </p>
          {assignments.some((row) => row.allowedTools) && (
            <ul className="mt-2 space-y-1 text-xs text-gray-500">
              {assignments
                .filter((row) => row.allowedTools)
                .map((row) => {
                  const projectName =
                    assignedProjects.find((p) => p.projectId === row.projectId)?.name ?? row.projectId;
                  return (
                    <li key={row.projectId}>
                      Project override on <span className="font-medium">{projectName}</span>:{" "}
                      {(row.allowedTools as string[]).join(", ")}
                    </li>
                  );
                })}
            </ul>
          )}
        </Section>

        <Section title="Assigned projects">
          {assignedProjects.length === 0 ? (
            <p className="text-sm text-gray-400">No projects using this agent.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {assignedProjects.map((project) => (
                <Badge key={project.projectId} variant="outline">
                  {project.name}
                </Badge>
              ))}
            </div>
          )}
        </Section>

        <Section title="Assigned task">
          {active ? (
            <p className="text-sm">
              <span className="font-medium text-emerald-600 dark:text-emerald-400">
                {status.label === "Working" ? "Working" : status.label}
              </span>{" "}
              · {active.taskTitle}
              {active.subtaskKey ? ` · ${active.subtaskKey}` : ""}
            </p>
          ) : (
            <p className="text-sm text-gray-400">Idle — no active execution.</p>
          )}
          {assignedTasks.length > 0 && (
            <ul className="mt-1 space-y-1 text-xs text-gray-500">
              {assignedTasks.map((task) => (
                <li key={task.taskId}>
                  Open task: <span className="font-medium">{task.title}</span> ({task.status})
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Recent executions">
          {history === undefined ? (
            <div aria-hidden className="space-y-2">
              <SkeletonBox height={12} width="80%" />
              <SkeletonBox height={12} width="60%" />
            </div>
          ) : history.length === 0 ? (
            <p className="text-sm text-gray-400">No executions yet.</p>
          ) : (
            <ul className="space-y-2">
              {history.map((row: any) => (
                <li key={row.executionId} className="rounded-lg border border-gray-100 px-3 py-2 text-xs dark:border-gray-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={row.status === "failed" ? "destructive" : "secondary"}>{row.status}</Badge>
                    <span className="font-medium">{row.taskTitle ?? "Unknown task"}</span>
                    {row.subtaskKey && <span className="text-gray-400">· {row.subtaskKey}</span>}
                    <span className="ml-auto text-gray-400">{formatTime(row.completedAt ?? row.startedAt ?? row.createdAt)}</span>
                  </div>
                  {row.error && <p className="mt-1 text-red-600 dark:text-red-400">{row.error}</p>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </Modal>
  );
}
