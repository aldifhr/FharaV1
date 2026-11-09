"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { Dices } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import AgentAvatar from "../AgentAvatar";
import Modal from "../Modal";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { randomAvatartion, type AvatartionAvatar } from "../ui/avatartion";
import { AGENT_ROLES, ROLE_DEFAULT_PROMPTS, roleLabel } from "@/lib/agentRoles";

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
};

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
      const sameRoleCount = agents.filter((a) => a.role === agentRole).length;
      const baseName = roleLabel(agentRole);
      await createAgent({
        name: sameRoleCount === 0 ? baseName : `${baseName} ${sameRoleCount + 1}`,
        role: agentRole,
        ...(agentPrompt.trim() ? { systemPrompt: agentPrompt } : {}),
        ...avatarArgs(avatarSeed),
      });
      onClose();
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setSavingAgent(false);
    }
  }

  const autoName = agentRole
    ? (() => {
        const sameRoleCount = agents.filter((a) => a.role === agentRole).length;
        const baseName = roleLabel(agentRole);
        return sameRoleCount === 0 ? baseName : `${baseName} ${sameRoleCount + 1}`;
      })()
    : "";
  const field = "w-full rounded-lg border border-line bg-transparent px-3 py-2 text-[14px] text-ink outline-none transition focus:border-ink-3";

  return (
    <Modal title="New agent" onClose={onClose} maxWidth="max-w-md">
      <form onSubmit={handleCreateAgent} className="mt-5 grid gap-5">
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
            <span className="text-[12.5px] text-ink-3">Prefilled from the role</span>
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
        ...avatarArgs(avatarSeed),
      });
      onClose();
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : "Failed to update agent");
    } finally {
      setSavingAgent(false);
    }
  }

  return (
    
        <Modal title={`Edit agent${agentName ? ` · ${agentName}` : ""}`} onClose={onClose} fullScreen>
          <form onSubmit={handleUpdateAgent} className="mt-4 grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">Name
                <input value={agentName} onChange={(event) => setAgentName(event.target.value)} required className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800" />
              </label>
              <div className="grid gap-1 text-sm">
                <span>Role</span>
                <Select value={agentRole} onValueChange={handleSelectRole}>
                  <SelectTrigger className="w-full rounded-lg border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
                    <SelectValue placeholder="Select a role…" />
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
            <label className="grid gap-1 text-sm">System prompt <span className="text-gray-400">(optional)</span>
              <textarea value={agentPrompt} onChange={(event) => setAgentPrompt(event.target.value)} rows={4} className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800" />
            </label>
            <fieldset className="grid gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <legend className="px-1 text-xs font-semibold text-gray-500">LLM assignment <span className="font-normal text-gray-400">(optional — empty = pool default)</span></legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm">Provider
                  <select value={agentLlmProviderId} onChange={(event) => { setAgentLlmProviderId(event.target.value); setAgentLlmModelId(""); }} className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
                    <option value="">Pool (priority/weight)</option>
                    {(llmProviders ?? []).map((p: any) => (
                      <option key={p._id} value={p._id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">Model
                  <select value={agentLlmModelId} onChange={(event) => setAgentLlmModelId(event.target.value)} disabled={!agentLlmProviderId} className="rounded-lg border border-gray-300 px-3 py-2 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800">
                    <option value="">First available model</option>
                    {(llmModels ?? []).filter((m: any) => m.providerId === agentLlmProviderId).map((m: any) => (
                      <option key={m._id} value={m._id}>{m.displayName || m.modelId}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">Fallback provider
                  <select value={agentLlmFallbackProviderId} onChange={(event) => { setAgentLlmFallbackProviderId(event.target.value); setAgentLlmFallbackModelId(""); }} className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
                    <option value="">None (fall back to pool)</option>
                    {(llmProviders ?? []).map((p: any) => (
                      <option key={p._id} value={p._id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">Fallback model
                  <select value={agentLlmFallbackModelId} onChange={(event) => setAgentLlmFallbackModelId(event.target.value)} disabled={!agentLlmFallbackProviderId} className="rounded-lg border border-gray-300 px-3 py-2 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800">
                    <option value="">First available model</option>
                    {(llmModels ?? []).filter((m: any) => m.providerId === agentLlmFallbackProviderId).map((m: any) => (
                      <option key={m._id} value={m._id}>{m.displayName || m.modelId}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm sm:col-span-2">Selection policy
                  <select value={agentLlmPolicy} onChange={(event) => setAgentLlmPolicy(event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
                    <option value="">Default (weighted among equal priority)</option>
                    <option value="weighted">Weighted — weighted random among equal priority</option>
                    <option value="priority">Priority — always lowest priority, ignore weight</option>
                    <option value="fixed">Fixed — assigned model only, no pool fallback</option>
                  </select>
                </label>
              </div>
              <p className="text-xs text-gray-400">
                The resolver tries this assignment first, then its fallback, then the model pool. Connections with an open circuit (3x transient failures, 60s cooldown) are skipped automatically.
              </p>
            </fieldset>
            <fieldset className="grid gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <legend className="px-1 text-xs font-semibold text-gray-500">Runtime <span className="font-normal text-gray-400">(optional — empty = worker default)</span></legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm">Execution runtime
                  <select value={agentRuntime} onChange={(event) => setAgentRuntime(event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
                    <option value="">Default (worker setting)</option>
                    <option value="api">API — MOAgent host tools</option>
                    <option value="opencode">OpenCode — native CLI in the task worktree</option>
                  </select>
                </label>
                <label className="grid gap-1 text-sm">OpenCode model <span className="text-gray-400">(optional)</span>
                  <input value={agentOpencodeModel} onChange={(event) => setAgentOpencodeModel(event.target.value)} disabled={agentRuntime !== "opencode"} placeholder="provider/model" className="rounded-lg border border-gray-300 px-3 py-2 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800" />
                </label>
              </div>
              <p className="text-xs text-gray-400">
                OpenCode runs its own tools inside the task worktree; changes still go through the staging gate and approval. Without a model it uses the same LLM as the rest of MOAgent. QA and review always run on the API runtime.
              </p>
            </fieldset>
            <div className="flex items-center gap-3 rounded-lg border border-dashed border-gray-300 p-3 dark:border-gray-700">
              <AgentAvatar name={agentName || "Agent"} size={48} avatar={avatarSeed ?? undefined} />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-gray-500">Preview uses your current name. Use Generate to shuffle the SVGs.</p>
              </div>
              <button
                type="button"
                onClick={handleRandomizeAvatar}
                title="Generate a new avatar"
                aria-label="Generate a new avatar"
                className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-hover"
              >
                <Dices size={14} />
                Generate
              </button>
            </div>
            {agentError && <p className="text-sm text-red-600">{agentError}</p>}
            <button type="submit" disabled={savingAgent} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {savingAgent ? "Saving…" : "Save changes"}
            </button>
          </form>
        </Modal>
  );
}
