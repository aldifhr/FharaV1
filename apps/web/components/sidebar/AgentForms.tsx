"use client";

import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { Dices } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import Modal from "../Modal";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { AGENT_ROLES, roleLabel } from "@/lib/agentRoles";
import AgentAvatar from "../AgentAvatar";
import { DICEBEAR_STYLE, dicebearAvatarArgs, randomDicebearSeed } from "@/lib/dicebearAvatar";

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

/** Roles offered in the menus; a legacy role on an existing agent stays selectable. */
export function roleOptionsFor(agentRole: string): string[] {
  return agentRole && !(AGENT_ROLES as readonly string[]).includes(agentRole) ? [...AGENT_ROLES, agentRole] : [...AGENT_ROLES];
}

/**
 * New agent: name, role and avatar. The name starts empty — the user types it;
 * the role supplies the default persona (backend `defaultSystemPromptForRole`).
 * The avatar is a DiceBear face derived from the name, with Generate to shuffle
 * a seed and Reset to go back to the name. Instructions, skills and model are
 * edited later on the agent's page.
 */
export function CreateAgentModal({ onClose }: { onClose: () => void }) {
  const createAgent = useMutation(api.agents.create);
  const [agentRole, setAgentRole] = useState("");
  const [name, setName] = useState("");
  const [agentError, setAgentError] = useState("");
  const [savingAgent, setSavingAgent] = useState(false);
  // Null = derive the avatar from the name (the backend default); a seed is a
  // shuffled face the user picked in this modal.
  const [avatarSeed, setAvatarSeed] = useState<string | null>(null);

  const roleOptions = roleOptionsFor(agentRole);

  const handleSelectRole = (value: string | null) => {
    setAgentRole(value ?? "");
    if (value) setAgentError("");
  };

  async function handleCreateAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAgentError("");
    if (!name.trim()) {
      setAgentError("Name is required");
      return;
    }
    if (!agentRole.trim()) {
      setAgentError("Role is required — pick a role from the dropdown");
      return;
    }
    setSavingAgent(true);
    try {
      await createAgent({ name: name.trim(), role: agentRole, ...dicebearAvatarArgs(avatarSeed) });
      onClose();
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setSavingAgent(false);
    }
  }

  const field = "w-full rounded-lg border border-line bg-transparent px-3 py-2 text-[14px] text-ink outline-none transition focus:border-ink-3";

  return (
    <Modal title="New agent" onClose={onClose} maxWidth="max-w-md">
      <form onSubmit={handleCreateAgent} className="mt-5 grid gap-5">
        <div className="grid gap-1.5">
          <span className="text-[12.5px] text-ink-3">Avatar</span>
          <div className="flex items-center gap-3">
            <AgentAvatar
              name={name || "Agent"}
              size={48}
              avatarParams={avatarSeed !== null ? { dicebear: DICEBEAR_STYLE, seed: avatarSeed } : undefined}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setAvatarSeed(randomDicebearSeed())}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover hover:text-ink"
              >
                <Dices size={13} />
                Generate
              </button>
              {avatarSeed !== null && (
                <button
                  type="button"
                  onClick={() => setAvatarSeed(null)}
                  className="text-[12.5px] text-ink-3 underline-offset-2 transition hover:text-ink"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        </div>

        <label className="grid gap-1.5">
          <span className="text-[12.5px] text-ink-3">Name</span>
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setAgentError("");
            }}
            placeholder="e.g. Ada"
            autoComplete="off"
            className={field}
          />
        </label>

        <div className="grid gap-1.5">
          <span className="text-[12.5px] text-ink-3">Role</span>
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

        {agentError && <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">{agentError}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover">
            Cancel
          </button>
          <button
            type="submit"
            disabled={savingAgent || !agentRole || !name.trim()}
            className="rounded-lg bg-ink px-3.5 py-1.5 text-[13px] font-medium text-canvas transition hover:opacity-90 disabled:opacity-40"
          >
            {savingAgent ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
