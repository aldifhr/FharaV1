"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { BookmarkPlus, Dices } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import AgentAvatar from "../AgentAvatar";
import Modal from "../Modal";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { deserializeAvatartion, randomAvatartion, type AvatartionAvatar } from "../ui/avatartion";
import type { AvatarParams } from "@/api/convex/lib/avatar";
import { nextAgentName } from "@/api/convex/lib/agentTemplates";
import { AGENT_ROLES, ROLE_DEFAULT_PROMPTS, roleLabel } from "@/lib/agentRoles";
import { useToast } from "../Toasts";

type AgentDoc = {
  _id: string;
  name: string;
  role: string;
  systemPrompt?: string;
  llmProviderId?: string;
  llmModelId?: string;
  llmFallbackProviderId?: string;
  llmFallbackModelId?: string;
  llmSelectionPolicy?: string;
  executionRuntime?: string;
  opencodeModel?: string;
  avatarParams?: unknown;
  skillIds?: string[];
  skillPins?: Array<{ skillId: string; version: number }>;
  skillLoading?: "inline" | "on_demand";
};

/** Template as agentTemplates.list returns it (built-in or custom). */
export type TemplateView = {
  id: string;
  builtIn: boolean;
  name: string;
  role: string;
  description: string;
  systemPrompt: string;
  skillIds: string[];
  suggestedSkills: string[];
  llmProviderId?: string;
  llmModelId?: string;
  runtime?: "api" | "opencode";
  opencodeModel?: string;
  avatarParams?: unknown;
  tags: string[];
  updatedAt?: number;
};

type LibrarySkill = { _id: string; name: string; description?: string; version?: number; versionCount?: number };

/**
 * Checkbox list of library skills (order of picking = prompt order). With
 * `pins`, each picked skill gets a version menu: Latest or a pinned vN.
 */
function SkillPicker({
  skills,
  value,
  onChange,
  pins,
  onPinChange,
}: {
  skills: LibrarySkill[] | undefined;
  value: string[];
  onChange: (next: string[]) => void;
  pins?: Record<string, number | undefined>;
  onPinChange?: (skillId: string, version: number | undefined) => void;
}) {
  const hint = "text-[12px] text-ink-3";
  if (skills === undefined) return <p className={hint}>Loading…</p>;
  if (skills.length === 0) return <p className={hint}>No skills in the library yet.</p>;
  return (
    <div className="grid max-h-40 gap-1.5 overflow-y-auto rounded-lg border border-line p-3">
      {skills.map((skill) => (
        <label key={skill._id} className="flex min-w-0 cursor-pointer items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={value.includes(skill._id)}
            onChange={() => onChange(value.includes(skill._id) ? value.filter((id) => id !== skill._id) : [...value, skill._id])}
            className="accent-current"
          />
          <span className="truncate">{skill.name}</span>
          {skill.description && <span className="min-w-0 flex-1 truncate text-ink-3">· {skill.description}</span>}
          {pins && onPinChange && value.includes(skill._id) && (skill.versionCount ?? 0) > 1 && (
            <select
              aria-label={`Version of ${skill.name}`}
              value={pins[skill._id] ?? ""}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onPinChange(skill._id, e.target.value ? Number(e.target.value) : undefined)}
              className="ml-auto shrink-0 rounded-md border border-line bg-canvas px-1.5 py-0.5 text-[12px] text-ink-2 outline-none focus:border-ink-3"
            >
              <option value="">Latest{skill.version ? ` (v${skill.version})` : ""}</option>
              {Array.from({ length: skill.versionCount ?? 0 }, (_, i) => (skill.versionCount ?? 0) - i).map((v) => (
                <option key={v} value={v}>
                  Pin v{v}
                </option>
              ))}
            </select>
          )}
        </label>
      ))}
    </div>
  );
}

function avatarArgs(seed: AvatartionAvatar | null) {
  return seed
    ? {
        avatarParams: {
          face: seed.face,
          hair: seed.hair,
          eyes: seed.eyes,
          mouth: seed.mouth,
          outfit: seed.outfit,
          accessory: seed.accessory,
          facialHair: seed.facialHair,
          bg: seed.bg,
        },
      }
    : {};
}

/** Roles offered in the menus; a legacy role on an existing agent stays selectable. */
function roleOptionsFor(agentRole: string): string[] {
  return agentRole && !(AGENT_ROLES as readonly string[]).includes(agentRole) ? [...AGENT_ROLES, agentRole] : [...AGENT_ROLES];
}

export function CreateAgentModal({ agents, onClose }: { agents: AgentDoc[]; onClose: () => void }) {
  const createAgent = useMutation(api.agents.create);
  const templates = useQuery(api.agentTemplates.list, {}) as TemplateView[] | undefined;
  const librarySkills = useQuery(api.skills.list, {}) as LibrarySkill[] | undefined;
  // "" = Blank. A picked template prefills role, instructions, skills and
  // avatar (all still editable) and carries its LLM/runtime preference.
  const [templateId, setTemplateId] = useState("");
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const template = templateId ? (templates ?? []).find((t) => t.id === templateId) ?? null : null;
  const [agentRole, setAgentRole] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentError, setAgentError] = useState("");
  const [savingAgent, setSavingAgent] = useState(false);
  const [avatarSeed, setAvatarSeed] = useState<AvatartionAvatar | null>(null);
  const roleOptions = roleOptionsFor(agentRole);
  const handleRandomizeAvatar = () => setAvatarSeed(randomAvatartion());
  const handleSelectRole = (value: string | null) => {
    setAgentRole(value ?? "");
    // Prefill the role's default prompt; the backend applies the same default when empty.
    setAgentPrompt(value ? (ROLE_DEFAULT_PROMPTS[value] ?? "") : "");
    if (value) setAgentError("");
  };
  const handlePickTemplate = (next: TemplateView | null) => {
    setTemplateId(next?.id ?? "");
    setAgentError("");
    setAgentRole(next?.role ?? "");
    setAgentPrompt(next?.systemPrompt ?? "");
    setSkillIds(next?.skillIds ?? []);
    setAvatarSeed(next ? deserializeAvatartion(next.avatarParams) : null);
  };

  async function handleCreateAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAgentError("");
    if (!agentRole.trim()) {
      setAgentError("Role is required — pick a role from the dropdown");
      return;
    }
    setSavingAgent(true);
    try {
      // Role-only: the name is the role label plus a suffix when taken ("Frontend 2").
      await createAgent({
        name: nextAgentName(agentRole, agents),
        role: agentRole,
        ...(agentPrompt.trim() ? { systemPrompt: agentPrompt } : {}),
        ...avatarArgs(avatarSeed),
        ...(skillIds.length ? { skillIds: skillIds as never } : {}),
        // The template's model/runtime preference rides along (edit later).
        ...(template?.llmProviderId ? { llmProviderId: template.llmProviderId as never } : {}),
        ...(template?.llmModelId ? { llmModelId: template.llmModelId as never } : {}),
        ...(template?.runtime ? { executionRuntime: template.runtime } : {}),
        ...(template?.opencodeModel ? { opencodeModel: template.opencodeModel } : {}),
      });
      onClose();
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setSavingAgent(false);
    }
  }

  const autoName = agentRole ? nextAgentName(agentRole, agents) : "";
  const tile = (selected: boolean) =>
    `flex min-w-0 flex-col items-start rounded-lg border px-2.5 py-1.5 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-brand/40 ${
      selected ? "border-ink-3 bg-hover text-ink" : "border-line text-ink-2 hover:bg-hover hover:text-ink"
    }`;
  const field = "w-full rounded-lg border border-line bg-transparent px-3 py-2 text-[14px] text-ink outline-none transition focus:border-ink-3";

  return (
    <Modal title="New agent" onClose={onClose} maxWidth="max-w-md">
      <form onSubmit={handleCreateAgent} className="mt-5 grid gap-5">
        <fieldset className="grid gap-2">
          <legend className="mb-1.5 flex w-full justify-between text-[12.5px] text-ink-3">
            Start from template
            <Link href="/library?tab=templates" className="text-ink-3 underline-offset-2 hover:text-ink hover:underline">Templates</Link>
          </legend>
          <div role="radiogroup" aria-label="Template" className="grid max-h-[124px] grid-cols-3 gap-1.5 overflow-y-auto">
            <button type="button" role="radio" aria-checked={!templateId} onClick={() => handlePickTemplate(null)} className={tile(!templateId)}>
              <span className="w-full truncate text-[12.5px] font-medium">Blank</span>
              <span className="w-full truncate text-[11.5px] text-ink-3">Role defaults</span>
            </button>
            {(templates ?? []).map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={templateId === t.id}
                title={t.description || t.name}
                onClick={() => handlePickTemplate(t)}
                className={tile(templateId === t.id)}
              >
                <span className="w-full truncate text-[12.5px] font-medium">{t.name}</span>
                <span className="w-full truncate text-[11.5px] text-ink-3">{roleLabel(t.role)}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={handleRandomizeAvatar}
            title="Shuffle avatar"
            aria-label="Shuffle avatar"
            className="group relative shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <AgentAvatar name={agentRole ? roleLabel(agentRole) : "Agent"} size={52} avatar={avatarSeed ?? undefined} />
            <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-line bg-panel text-ink-3 transition group-hover:text-ink">
              <Dices size={11} />
            </span>
          </button>
          <div className="min-w-0 flex-1">
            <Select value={agentRole} onValueChange={handleSelectRole}>
              <SelectTrigger aria-label="Role" className="h-10 w-full rounded-lg border-line px-3 text-[14px]">
                <SelectValue placeholder="Choose a role" />
              </SelectTrigger>
              <SelectContent>
                {roleOptions.map((role) => (
                  <SelectItem key={role} value={role}>
                    {roleLabel(role)}
                    {!(AGENT_ROLES as readonly string[]).includes(role) ? " (retired)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1.5 truncate text-[12.5px] text-ink-3">
              {autoName ? `Shows up as ${autoName}` : "Tap the avatar to shuffle it"}
            </p>
          </div>
        </div>

        <details className="group rounded-lg border border-line">
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-[13px] text-ink-2 [&::-webkit-details-marker]:hidden">
            Instructions
            <span className="text-[12.5px] text-ink-3">{template ? `From ${template.name}` : "Prefilled from the role"}</span>
          </summary>
          <div className="border-t border-line p-3">
            <textarea
              value={agentPrompt}
              onChange={(event) => setAgentPrompt(event.target.value)}
              rows={6}
              placeholder="Leave empty to use the role's default instructions."
              className={`${field} resize-y leading-relaxed`}
            />
          </div>
        </details>

        <details className="group rounded-lg border border-line">
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-[13px] text-ink-2 [&::-webkit-details-marker]:hidden">
            Skills
            <span className="text-[12.5px] text-ink-3">{skillIds.length ? `${skillIds.length} selected` : "None"}</span>
          </summary>
          <div className="border-t border-line p-3">
            <SkillPicker skills={librarySkills} value={skillIds} onChange={setSkillIds} />
          </div>
        </details>

        {agentError && <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">{agentError}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover">
            Cancel
          </button>
          <button
            type="submit"
            disabled={savingAgent || !agentRole}
            className="rounded-lg bg-ink px-3.5 py-1.5 text-[13px] font-medium text-canvas transition hover:opacity-90 disabled:opacity-40"
          >
            {savingAgent ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function EditAgentModal({ agent, onClose }: { agent: AgentDoc; onClose: () => void }) {
  const updateAgent = useMutation(api.agents.update);
  const setAgentSkills = useMutation(api.agents.setSkills);
  const setSkillPin = useMutation(api.skills.setPin);
  const saveAsTemplate = useMutation(api.agentTemplates.saveFromAgent);
  const toast = useToast();
  const [savingTemplate, setSavingTemplate] = useState(false);
  const librarySkills = useQuery(api.skills.list, {}) as LibrarySkill[] | undefined;
  const [skillIds, setSkillIds] = useState<string[]>(agent.skillIds ?? []);
  const initialPins = Object.fromEntries((agent.skillPins ?? []).map((p) => [p.skillId, p.version])) as Record<string, number | undefined>;
  const [pins, setPins] = useState<Record<string, number | undefined>>(initialPins);
  const [skillLoading, setSkillLoading] = useState<"inline" | "on_demand">(agent.skillLoading ?? "inline");
  const llmProviders = useQuery(api.llmProviders.list, {});
  const llmModels = useQuery(api.llmModels.list, {});
  const [agentName, setAgentName] = useState(agent.name);
  const [agentRole, setAgentRole] = useState(agent.role);
  const [agentPrompt, setAgentPrompt] = useState(agent.systemPrompt ?? "");
  // LLM assignment (Phase 2 resolver): "" = unassigned (pool decides).
  const [agentLlmProviderId, setAgentLlmProviderId] = useState(agent.llmProviderId ?? "");
  const [agentLlmModelId, setAgentLlmModelId] = useState(agent.llmModelId ?? "");
  const [agentLlmFallbackProviderId, setAgentLlmFallbackProviderId] = useState(agent.llmFallbackProviderId ?? "");
  const [agentLlmFallbackModelId, setAgentLlmFallbackModelId] = useState(agent.llmFallbackModelId ?? "");
  const [agentLlmPolicy, setAgentLlmPolicy] = useState(agent.llmSelectionPolicy ?? "");
  // Execution runtime: "" = worker default, "api" | "opencode" override.
  const [agentRuntime, setAgentRuntime] = useState(agent.executionRuntime ?? "");
  const [agentOpencodeModel, setAgentOpencodeModel] = useState(agent.opencodeModel ?? "");
  const [agentError, setAgentError] = useState("");
  const [savingAgent, setSavingAgent] = useState(false);
  const [avatarSeed, setAvatarSeed] = useState<AvatartionAvatar | null>(null);
  const roleOptions = roleOptionsFor(agentRole);
  const handleRandomizeAvatar = () => setAvatarSeed(randomAvatartion());
  const handleSelectRole = (value: string | null) => {
    setAgentRole(value ?? "");
    if (value) setAgentError("");
  };

  async function handleUpdateAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agentName.trim()) {
      setAgentError("Name is required");
      return;
    }
    if (!agentRole.trim()) {
      setAgentError("Role is required — pick a role from the dropdown");
      return;
    }
    setAgentError("");
    setSavingAgent(true);
    try {
      await updateAgent({
        agentId: agent._id as never,
        name: agentName,
        role: agentRole,
        systemPrompt: agentPrompt,
        // LLM assignment: an id sets it, null clears it (backend contract).
        llmProviderId: (agentLlmProviderId || null) as never,
        llmModelId: (agentLlmModelId || null) as never,
        llmFallbackProviderId: (agentLlmFallbackProviderId || null) as never,
        llmFallbackModelId: (agentLlmFallbackModelId || null) as never,
        llmSelectionPolicy: (agentLlmPolicy || null) as never,
        // Runtime: a value sets it, null clears it (worker default).
        executionRuntime: (agentRuntime || null) as never,
        opencodeModel: agentOpencodeModel.trim() || null,
        ...(skillLoading !== (agent.skillLoading ?? "inline") ? { skillLoading } : {}),
        ...avatarArgs(avatarSeed),
      });
      // Library skills are saved separately so the update payload stays as-is.
      const before = agent.skillIds ?? [];
      let attached = skillIds;
      if (before.length !== skillIds.length || before.some((id, i) => id !== skillIds[i])) {
        const res = await setAgentSkills({ agentId: agent._id as never, skillIds: skillIds as never });
        attached = res.skillIds as unknown as string[];
        for (const w of res.warnings.slice(0, 4)) toast("info", "Heads up", w);
      }
      // Version pins (only for skills still attached).
      for (const id of attached) {
        if ((pins[id] ?? null) === (initialPins[id] ?? null)) continue;
        await setSkillPin({ agentId: agent._id as never, skillId: id as never, version: pins[id] ?? null });
      }
      onClose();
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : "Failed to update agent");
    } finally {
      setSavingAgent(false);
    }
  }

  const field = "w-full rounded-lg border border-line bg-transparent px-3 py-2 text-[14px] text-ink outline-none transition focus:border-ink-3";
  const select = `${field} bg-canvas disabled:opacity-40`;
  const label = "grid gap-1.5 text-[12.5px] text-ink-3";
  const hint = "text-[12px] text-ink-3";

  return (
    <Modal title="Edit agent" onClose={onClose} maxWidth="max-w-lg">
      <form onSubmit={handleUpdateAgent} className="mt-5 grid gap-5">
        <div className="flex items-start gap-4">
          <button
            type="button"
            onClick={handleRandomizeAvatar}
            title="Shuffle avatar"
            aria-label="Shuffle avatar"
            className="group relative mt-0.5 shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <AgentAvatar
              name={agentName || "Agent"}
              size={52}
              avatar={avatarSeed ?? undefined}
              avatarParams={avatarSeed ? undefined : (agent.avatarParams as AvatarParams | undefined)}
            />
            <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-line bg-panel text-ink-3 transition group-hover:text-ink">
              <Dices size={11} />
            </span>
          </button>
          <div className="grid min-w-0 flex-1 gap-2">
            <input
              value={agentName}
              onChange={(event) => setAgentName(event.target.value)}
              required
              aria-label="Name"
              placeholder="Name"
              className={field}
            />
            <Select value={agentRole} onValueChange={handleSelectRole}>
              <SelectTrigger aria-label="Role" className="h-10 w-full rounded-lg border-line px-3 text-[14px]">
                <SelectValue placeholder="Choose a role" />
              </SelectTrigger>
              <SelectContent>
                {roleOptions.map((role) => (
                  <SelectItem key={role} value={role}>
                    {roleLabel(role)}
                    {!(AGENT_ROLES as readonly string[]).includes(role) ? " (retired)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <label className={label}>
          Instructions
          <textarea
            value={agentPrompt}
            onChange={(event) => setAgentPrompt(event.target.value)}
            rows={6}
            placeholder="Leave empty to use the role's default instructions."
            className={`${field} resize-y leading-relaxed`}
          />
        </label>

        <fieldset className="grid gap-2">
          <legend className="mb-1.5 flex w-full justify-between text-[12.5px] text-ink-3">
            Skills
            <Link href="/library" className="text-ink-3 underline-offset-2 hover:text-ink hover:underline">Library</Link>
          </legend>
          <SkillPicker
            skills={librarySkills}
            value={skillIds}
            onChange={setSkillIds}
            pins={pins}
            onPinChange={(id, version) => setPins((prev) => ({ ...prev, [id]: version }))}
          />
          <label className="mt-1 flex items-center justify-between gap-3 text-[12.5px] text-ink-3">
            <span>
              {skillLoading === "on_demand"
                ? "On demand: the prompt lists names; the agent loads each skill whole when it needs it."
                : "Inline: every skill goes into the prompt, up to 12,000 chars in total."}
            </span>
            <select
              aria-label="Skill loading"
              value={skillLoading}
              onChange={(e) => setSkillLoading(e.target.value === "on_demand" ? "on_demand" : "inline")}
              className="shrink-0 rounded-md border border-line bg-canvas px-2 py-1 text-[12.5px] text-ink outline-none focus:border-ink-3"
            >
              <option value="inline">Inline</option>
              <option value="on_demand">On demand</option>
            </select>
          </label>
        </fieldset>

        <details className="group rounded-lg border border-line">
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-[13px] text-ink-2 [&::-webkit-details-marker]:hidden">
            Advanced
            <span className="text-[12.5px] text-ink-3">Model and runtime</span>
          </summary>
          <div className="grid gap-5 border-t border-line p-3">
            <div className="grid gap-3">
              <p className="text-[13px] text-ink-2">LLM</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className={label}>Provider
                  <select value={agentLlmProviderId} onChange={(event) => { setAgentLlmProviderId(event.target.value); setAgentLlmModelId(""); }} className={select}>
                    <option value="">Pool default</option>
                    {(llmProviders ?? []).map((p: any) => (
                      <option key={p._id} value={p._id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label className={label}>Model
                  <select value={agentLlmModelId} onChange={(event) => setAgentLlmModelId(event.target.value)} disabled={!agentLlmProviderId} className={select}>
                    <option value="">First available</option>
                    {(llmModels ?? []).filter((m: any) => m.providerId === agentLlmProviderId).map((m: any) => (
                      <option key={m._id} value={m._id}>{m.displayName || m.modelId}</option>
                    ))}
                  </select>
                </label>
                <label className={label}>Fallback provider
                  <select value={agentLlmFallbackProviderId} onChange={(event) => { setAgentLlmFallbackProviderId(event.target.value); setAgentLlmFallbackModelId(""); }} className={select}>
                    <option value="">None</option>
                    {(llmProviders ?? []).map((p: any) => (
                      <option key={p._id} value={p._id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label className={label}>Fallback model
                  <select value={agentLlmFallbackModelId} onChange={(event) => setAgentLlmFallbackModelId(event.target.value)} disabled={!agentLlmFallbackProviderId} className={select}>
                    <option value="">First available</option>
                    {(llmModels ?? []).filter((m: any) => m.providerId === agentLlmFallbackProviderId).map((m: any) => (
                      <option key={m._id} value={m._id}>{m.displayName || m.modelId}</option>
                    ))}
                  </select>
                </label>
                <label className={`${label} sm:col-span-2`}>Selection policy
                  <select value={agentLlmPolicy} onChange={(event) => setAgentLlmPolicy(event.target.value)} className={select}>
                    <option value="">Default (weighted by weight)</option>
                    <option value="weighted">Weighted (by weight)</option>
                    <option value="priority">Fallback (top priority, then failover)</option>
                    <option value="round_robin">Round robin (rotate providers)</option>
                    <option value="fixed">Fixed (assigned connections only)</option>
                  </select>
                </label>
              </div>
              <p className={hint}>Tried first, then the fallback, then the pool. A failed provider always fails over to the next candidate.</p>
            </div>
            <div className="grid gap-3">
              <p className="text-[13px] text-ink-2">Runtime</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className={label}>Execution runtime
                  <select value={agentRuntime} onChange={(event) => setAgentRuntime(event.target.value)} className={select}>
                    <option value="">Worker default</option>
                    <option value="api">API</option>
                    <option value="opencode">OpenCode</option>
                  </select>
                </label>
                <label className={label}>OpenCode model
                  <input value={agentOpencodeModel} onChange={(event) => setAgentOpencodeModel(event.target.value)} disabled={agentRuntime !== "opencode"} placeholder="provider/model" className={`${field} disabled:opacity-40`} />
                </label>
              </div>
              <p className={hint}>OpenCode runs native tools in the task worktree.</p>
            </div>
          </div>
        </details>

        {agentError && <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">{agentError}</p>}

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={savingTemplate}
            title="Saves this agent's last saved settings as a reusable template"
            onClick={async () => {
              setSavingTemplate(true);
              try {
                const result = await saveAsTemplate({ agentId: agent._id as never });
                toast("success", "Saved as template", `${result.name} · in Library → Templates`);
              } catch (err) {
                setAgentError(err instanceof Error ? err.message : "Failed to save template");
              } finally {
                setSavingTemplate(false);
              }
            }}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover hover:text-ink disabled:opacity-40"
          >
            <BookmarkPlus size={14} /> {savingTemplate ? "Saving…" : "Save as template"}
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover">
              Cancel
            </button>
            <button
              type="submit"
              disabled={savingAgent}
              className="rounded-lg bg-ink px-3.5 py-1.5 text-[13px] font-medium text-canvas transition hover:opacity-90 disabled:opacity-40"
            >
              {savingAgent ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
