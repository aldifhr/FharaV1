"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import AgentAvatar from "./AgentAvatar";
import ConfirmDialog from "./ConfirmDialog";
import AgentActivity, { type ActiveExecution } from "./agents/AgentActivity";
import AgentPanelActions from "./agents/AgentPanelActions";
import TeamStatusSource, { useDraftingAgentIds } from "./agents/TeamStatusSource";
import AgentConfigureForm from "./agents/AgentConfigureForm";
import AgentSkillsForm from "./agents/AgentSkillsForm";
import { Inspector, InspectorTabs } from "./ui/inspector";
import { StatusTag } from "./ui/status-tag";
import { agentName, fixedAgentIds, roleLabel } from "@/lib/agentRoles";
import { agentStatusView, type StatusMap } from "@/lib/teamStatus";
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

type Tab = "configure" | "skills" | "activity";

type PanelProps = {
  agent: any;
  /** The open project, if any: the same scope the sidebar team list reads status with. */
  projectId?: string;
  onClose: () => void;
  /** Delete the agent (asks for confirmation upstream); offered only for agents outside the fixed team. */
  onRemove?: (agent: any) => void;
};

/** Agent inspector (dashboard F4): Activity / Configure / Skills in the right-hand panel. */
export default function AgentDetailPanel(props: PanelProps) {
  // Keyed by agent: opening another team member starts again on Activity.
  return (
    <TeamStatusSource projectId={props.projectId}>
      {(status) => <AgentDetail key={props.agent._id} {...props} status={status} />}
    </TeamStatusSource>
  );
}

function AgentDetail({ agent, onClose, onRemove, status: teamStatus }: PanelProps & { status: StatusMap | undefined }) {
  const detail = useQuery(api.agents.getDetail, { agentId: agent._id as never });
  // Plan 035: the OpenCode runtime is app-wide (Settings → LLM & Models).
  const opencode = useQuery(api.opencodeSettings.get, {});
  const history = useQuery(api.agents.getExecutionHistory, { agentId: agent._id as never, limit: 20 });
  const allAgents = useQuery(api.agents.list, {}) as Array<{ _id: string; role: string; _creationTime?: number }> | undefined;
  const removable = useMemo(() => allAgents !== undefined && !fixedAgentIds(allAgents).has(agent._id), [allAgents, agent._id]);
  const drafting = useDraftingAgentIds().includes(agent._id);
  const entry = teamStatus?.[agent._id as string];
  // Same helper and same source as the sidebar row, so both show the same word.
  const status = agentStatusView(entry, { isEnabled: agent.isEnabled, drafting });
  const active: ActiveExecution | undefined =
    entry?.taskId && entry.taskTitle && status.kind !== "disabled"
      ? { taskId: entry.taskId, taskTitle: entry.taskTitle, subtaskKey: entry.subtaskKey ?? undefined, status: entry.status }
      : undefined;

  const [tab, setTab] = useState<Tab>("activity");
  const [discardOpen, setDiscardOpen] = useState(false);
  const [dirty, setDirty] = useState<Record<"configure" | "skills", boolean>>({ configure: false, skills: false });
  const onConfigureDirty = useCallback((d: boolean) => setDirty((prev) => (prev.configure === d ? prev : { ...prev, configure: d })), []);
  const onSkillsDirty = useCallback((d: boolean) => setDirty((prev) => (prev.skills === d ? prev : { ...prev, skills: d })), []);
  const close = () => {
    if (dirty.configure || dirty.skills) setDiscardOpen(true);
    else onClose();
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
      icon={<AgentAvatar name={displayName} size={36} status={status.avatar} avatarParams={agent.avatarParams} />}
      status={<StatusTag tone={status.tone}>{status.label}</StatusTag>}
      actions={<AgentPanelActions agent={agent} removable={removable} onRemove={onRemove} />}
      tabs={
        <InspectorTabs<Tab>
          label="Agent sections"
          value={tab}
          onChange={setTab}
          options={[
            { value: "activity", label: "Activity" },
            { value: "configure", label: "Configure", dirty: dirty.configure },
            { value: "skills", label: "Skills", dirty: dirty.skills },
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
      <ConfirmDialog
        request={discardOpen ? { title: "Discard unsaved changes?", message: "Your edits to this agent will be lost.", confirmLabel: "Discard" } : null}
        onCancel={() => setDiscardOpen(false)}
        onConfirm={() => {
          setDiscardOpen(false);
          onClose();
        }}
      />
    </Inspector>
  );
}
