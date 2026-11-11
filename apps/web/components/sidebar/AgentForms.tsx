"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { Dices } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import AgentAvatar from "../AgentAvatar";
import Modal from "../Modal";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { deserializeAvatartion, randomAvatartion, type AvatartionAvatar } from "../ui/avatartion";
import { nextAgentName } from "@/api/convex/lib/agentTemplates";
import { AGENT_ROLES, prefillPromptForRole, roleLabel } from "@/lib/agentRoles";
import SkillPicker, { type LibrarySkill } from "../agents/SkillPicker";

export type AgentDoc = {
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
  supportedTools?: string[];
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

export function avatarArgs(seed: AvatartionAvatar | null) {
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
export function roleOptionsFor(agentRole: string): string[] {
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
    // Prefill the role's template; text the user typed is kept. The backend
    // applies the same template when the prompt is empty.
    setAgentPrompt((current) => prefillPromptForRole(current, value));
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
        // The template's model preference rides along (edit later).
        ...(template?.llmProviderId ? { llmProviderId: template.llmProviderId as never } : {}),
        ...(template?.llmModelId ? { llmModelId: template.llmModelId as never } : {}),
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
    `flex min-w-0 flex-col items-start rounded-lg border px-2.5 py-1.5 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-ink/30 ${
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
            className="group relative shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
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
            <span className="text-[12.5px] text-ink-3">{template ? `From ${template.name}` : "Prefilled from the role template"}</span>
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
