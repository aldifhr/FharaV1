"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import AgentAvatar from "./AgentAvatar";
import AgentActivity, { type ActiveExecution } from "./agents/AgentActivity";
import AgentConfigureForm from "./agents/AgentConfigureForm";
import AgentSkillsForm from "./agents/AgentSkillsForm";
import { Inspector, InspectorTabs } from "./ui/inspector";
import { StatusTag } from "./ui/status-tag";
import { agentName, roleLabel } from "@/lib/agentRoles";
import { LEGACY_ROLE_SUCCESSORS, ROLES, isRoleKey } from "@/api/convex/lib/roles";

/**
 * Fallback when the backend `roleDefinitions` row is missing, plus the
 * responsibilities hint — both from the shared role module.
 */
function roleFallback(roleKey: string) {
  if (!isRoleKey(roleKey)) return undefined;
  const role = ROLES[roleKey];
  return {
    displayName: role.title,
    category: role.category,
    description: role.registryDescription,
    defaultCapabilities: [...role.registryCapabilities],
    defaultTools: [...role.defaultTools],
    systemPromptHint: role.hint,
  };
}

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

type Tab = "configure" | "skills" | "activity";

const ACTION =
  "inline-flex h-7 items-center rounded-field border border-line px-2.5 text-[12px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30";

/** Agent inspector (dashboard F4): Configure / Skills / Activity in the right-hand panel. */
export default function AgentDetailPanel({
  agent,
  onClose,
  onRemove,
}: {
  agent: any;
  onClose: () => void;
  /** Delete the agent (asks for confirmation upstream). */
  onRemove?: (agent: any) => void;
}) {
  const detail = useQuery(api.agents.getDetail, { agentId: agent._id as never });
  // Plan 035: the OpenCode runtime is app-wide (Settings → LLM & Models).
  const opencode = useQuery(api.opencodeSettings.get, {});
  const history = useQuery(api.agents.getExecutionHistory, { agentId: agent._id as never, limit: 20 });
  const activeByAgent = useQuery(api.executionView.activeByAgent, {});
  const active = (activeByAgent as any)?.[agent._id as string] as ActiveExecution | undefined;
  const status = statusFromActive(active);

  const [tab, setTab] = useState<Tab>("configure");
  const [dirty, setDirty] = useState<Record<"configure" | "skills", boolean>>({ configure: false, skills: false });
  const onConfigureDirty = useCallback((d: boolean) => setDirty((prev) => (prev.configure === d ? prev : { ...prev, configure: d })), []);
  const onSkillsDirty = useCallback((d: boolean) => setDirty((prev) => (prev.skills === d ? prev : { ...prev, skills: d })), []);
  const close = () => {
    if ((dirty.configure || dirty.skills) && !window.confirm("Discard unsaved changes?")) return;
    onClose();
  };

  const rawRole = (agent.role ?? "").trim().toLowerCase();
  // Retired roles (ui-ux, product-analyst) display as their successor.
  const roleKey = LEGACY_ROLE_SUCCESSORS[rawRole] ?? rawRole;
  const fallback = roleFallback(roleKey);
  const roleDefinition = (detail as any)?.roleDefinition;
  const roleName: string = roleLabel(agent.role);
  const displayName: string = agentName(agent);
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
  const category = roleDefinition?.category ?? fallback?.category;
  const runtime = opencode?.viaModelList
    ? "From the model list: an OpenCode entry runs on the OpenCode CLI, an API entry on the built-in tools"
    : opencode?.runtime === "opencode"
      ? `OpenCode${opencode.model ? ` · ${opencode.model}` : " · Fhara LLM"}`
      : "Built-in (Fhara host tools)";
  const tone = status.avatar === "working" ? "active" : status.avatar === "needs_you" ? "warn" : "neutral";

  return (
    <Inspector
      label={`Agent ${displayName}`}
      title={displayName}
      subtitle={
        <>
          {fallback?.displayName ?? roleName}
          {category ? <span className="capitalize">{` · ${category}`}</span> : null}
        </>
      }
      icon={<AgentAvatar name={displayName} size={36} status={status.avatar === "idle" ? undefined : status.avatar} avatarParams={agent.avatarParams} />}
      status={<StatusTag tone={tone}>{status.label}</StatusTag>}
      actions={
        <>
          {agent?._id && (
            <Link href={`/team/${agent._id}`} className={ACTION}>
              Performance
            </Link>
          )}
          {onRemove && (
            <button type="button" onClick={() => onRemove(agent)} className={`${ACTION} hover:text-danger`}>
              Remove
            </button>
          )}
        </>
      }
      tabs={
        <InspectorTabs<Tab>
          label="Agent sections"
          value={tab}
          onChange={setTab}
          options={[
            { value: "configure", label: "Configure", dirty: dirty.configure },
            { value: "skills", label: "Skills", dirty: dirty.skills },
            { value: "activity", label: "Activity" },
          ]}
        />
      }
      onClose={close}
    >
      {/* Both forms stay mounted so switching tabs keeps an unsaved draft. */}
      <div hidden={tab !== "configure"} className="flex flex-1 flex-col">
        <AgentConfigureForm agent={agent} onDirtyChange={onConfigureDirty} />
      </div>
      <div hidden={tab !== "skills"} className="flex flex-1 flex-col">
        <AgentSkillsForm agent={agent} onDirtyChange={onSkillsDirty} />
      </div>
      {tab === "activity" && (
        <AgentActivity
          loading={detail === undefined}
          responsibilities={responsibilities}
          capabilities={capabilities}
          capabilitiesFromRole={agent.capabilities === undefined}
          tools={effectiveTools}
          toolsAreCustom={toolsAreCustom}
          toolOverrides={assignments
            .filter((row) => row.allowedTools)
            .map((row) => ({
              projectName: assignedProjects.find((p) => p.projectId === row.projectId)?.name ?? row.projectId,
              tools: row.allowedTools as string[],
            }))}
          runtime={runtime}
          projects={assignedProjects}
          active={active}
          activeLabel={status.label}
          openTasks={assignedTasks}
          history={history as never}
        />
      )}
    </Inspector>
  );
}
