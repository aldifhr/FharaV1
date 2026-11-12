"use client";

import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { BookmarkPlus, Dices } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { AGENT_TOOL_OPTIONS } from "@/api/convex/lib/toolNames";
import { AGENT_ROLES, roleDefaultTools, roleLabel, roleTemplateFor } from "@/lib/agentRoles";
import { DICEBEAR_STYLE, dicebearAvatarArgs, randomDicebearSeed } from "@/lib/dicebearAvatar";
import AgentAvatar from "../AgentAvatar";
import ConfirmDialog from "../ConfirmDialog";
import { useToast } from "../Toasts";
import { roleOptionsFor, type AgentDoc } from "../sidebar/AgentForms";
import { INSPECTOR_INPUT, InspectorBody, InspectorField, InspectorFooter } from "../ui/inspector";
import { useInspectorDraft } from "../ui/use-inspector-draft";

function baseFor(agent: AgentDoc) {
  return {
    name: agent.name,
    role: agent.role,
    systemPrompt: agent.systemPrompt ?? "",
    tools: agent.supportedTools ?? roleDefaultTools(agent.role),
    avatar: null as string | null,
  };
}

/**
 * Inspector → Configure (dashboard F4): name, role, avatar, instructions, tool
 * permissions, edited as one draft with Discard / Save. The model is not per
 * agent (L4): the global list in Settings → LLM & Models serves every call.
 */
export default function AgentConfigureForm({ agent, onDirtyChange }: { agent: AgentDoc; onDirtyChange?: (dirty: boolean) => void }) {
  const updateAgent = useMutation(api.agents.update);
  const resetPrompt = useMutation(api.agentPrompts.resetToRoleTemplate);
  const saveAsTemplate = useMutation(api.agentTemplates.saveFromAgent);
  const toast = useToast();
  const form = useInspectorDraft(baseFor(agent));
  const { draft, set } = form;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  useEffect(() => onDirtyChange?.(form.dirty), [form.dirty, onDirtyChange]);

  async function save() {
    if (!draft.name.trim()) return setError("Name is required");
    if (!draft.role.trim()) return setError("Role is required. Pick one from the list.");
    setError(null);
    setSaving(true);
    try {
      await updateAgent({
        agentId: agent._id as never,
        name: draft.name,
        role: draft.role,
        systemPrompt: draft.systemPrompt,
        // Only a changed list becomes a custom override; untouched agents keep role defaults.
        ...(form.isChanged("tools") ? { supportedTools: draft.tools } : {}),
        ...dicebearAvatarArgs(draft.avatar),
      });
      form.commit({ ...draft, avatar: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the agent");
    } finally {
      setSaving(false);
    }
  }

  async function handleResetPrompt() {
    setResetting(true);
    try {
      const res = await resetPrompt({ agentId: agent._id as never });
      set("systemPrompt", res.systemPrompt);
      toast("success", "Instructions reset", `${roleLabel(agent.role)} role template applied`);
      setConfirmReset(false);
    } catch (err) {
      toast("error", "Reset failed", err instanceof Error ? err.message : "Could not reset the instructions");
    } finally {
      setResetting(false);
    }
  }

  async function handleSaveTemplate() {
    setSavingTemplate(true);
    try {
      const result = await saveAsTemplate({ agentId: agent._id as never });
      toast("success", "Saved as template", `${result.name} · in Library → Templates`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the template");
    } finally {
      setSavingTemplate(false);
    }
  }

  return (
    <>
      <InspectorBody>
        <InspectorField label="Identity">
          <div className="flex items-start gap-3">
            <button
              type="button"
              onClick={() => set("avatar", randomDicebearSeed())}
              title="Shuffle avatar"
              aria-label="Shuffle avatar"
              className="group relative shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
            >
              <AgentAvatar
                name={draft.name || "Agent"}
                size={44}
                avatarParams={
                  draft.avatar
                    ? { dicebear: DICEBEAR_STYLE, seed: draft.avatar }
                    : agent.avatarParams
                }
              />
              <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-line bg-panel text-ink-3 transition group-hover:text-ink">
                <Dices size={11} />
              </span>
            </button>
            <div className="grid min-w-0 flex-1 gap-2">
              <input value={draft.name} onChange={(e) => set("name", e.target.value)} aria-label="Name" placeholder="Name" className={INSPECTOR_INPUT} />
              <select aria-label="Role" value={draft.role} onChange={(e) => set("role", e.target.value)} className={INSPECTOR_INPUT}>
                {!draft.role && <option value="">Choose a role</option>}
                {roleOptionsFor(draft.role).map((role) => (
                  <option key={role} value={role}>
                    {roleLabel(role)}
                    {!(AGENT_ROLES as readonly string[]).includes(role) ? " (retired)" : ""}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </InspectorField>

        <InspectorField
          label="Instructions"
          htmlFor="inspector-agent-instructions"
          trailing={
            roleTemplateFor(agent.role) !== null ? (
              <button type="button" onClick={() => setConfirmReset(true)} className="text-[12px] text-ink-3 underline-offset-2 hover:text-ink hover:underline">
                Reset to role template
              </button>
            ) : null
          }
        >
          <textarea
            id="inspector-agent-instructions"
            value={draft.systemPrompt}
            onChange={(e) => set("systemPrompt", e.target.value)}
            rows={7}
            placeholder="Leave empty to use the role's default instructions."
            className={`${INSPECTOR_INPUT} resize-y leading-relaxed`}
          />
        </InspectorField>

        <InspectorField
          label="Tool permissions"
          hint={agent.supportedTools ? "Custom for this agent. Unchecking everything falls back to the role defaults." : "Role defaults until you change them."}
        >
          <div className="grid gap-1.5">
            {AGENT_TOOL_OPTIONS.map((option) => (
              <label key={option.name} className="flex items-start gap-2 text-[13px] text-ink-2">
                <input
                  type="checkbox"
                  checked={draft.tools.includes(option.name)}
                  onChange={(e) => set("tools", e.target.checked ? [...draft.tools, option.name] : draft.tools.filter((n) => n !== option.name))}
                  className="mt-0.5"
                />
                <span>
                  {option.label}
                  <span className="block text-[12px] text-ink-3">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </InspectorField>

        <InspectorField label="Model">
          <p className="text-[12px] text-ink-3">
            Every agent uses the one model list in Settings → LLM & Models: its mode and its order decide the model and
            the fallbacks.
          </p>
        </InspectorField>
      </InspectorBody>

      <ConfirmDialog
        request={
          confirmReset
            ? {
                title: "Reset to role template?",
                message: `This replaces ${agent.name}'s instructions with the ${roleLabel(agent.role)} role template and saves it now. Your current instructions are lost.`,
                confirmLabel: "Reset",
                icon: "restore",
              }
            : null
        }
        pending={resetting}
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => void handleResetPrompt()}
      />

      <InspectorFooter
        dirty={form.dirty}
        editedAt={form.editedAt}
        saving={saving}
        error={error}
        onDiscard={() => {
          form.discard();
          setError(null);
        }}
        onSave={() => void save()}
        extra={
          <button
            type="button"
            disabled={savingTemplate}
            title="Saves this agent's last saved settings as a reusable template"
            onClick={() => void handleSaveTemplate()}
            className="inline-flex items-center gap-1.5 text-ink-3 transition hover:text-ink disabled:opacity-40"
          >
            <BookmarkPlus size={13} /> {savingTemplate ? "Saving…" : "Save as template"}
          </button>
        }
      />
    </>
  );
}
