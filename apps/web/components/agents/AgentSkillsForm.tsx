"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "../Toasts";
import type { AgentDoc } from "../sidebar/AgentForms";
import { INSPECTOR_INPUT, InspectorBody, InspectorField, InspectorFooter } from "../ui/inspector";
import { useInspectorDraft } from "../ui/use-inspector-draft";
import SkillPicker, { type LibrarySkill } from "./SkillPicker";

function baseFor(agent: AgentDoc) {
  return {
    skillIds: agent.skillIds ?? [],
    pins: Object.fromEntries((agent.skillPins ?? []).map((p) => [p.skillId, p.version])) as Record<string, number | undefined>,
    skillLoading: (agent.skillLoading ?? "inline") as "inline" | "on_demand",
  };
}

/**
 * Inspector → Skills (dashboard F4): library skills in prompt order, version
 * pins, and how they load, as one draft with Discard / Save.
 */
export default function AgentSkillsForm({ agent, onDirtyChange }: { agent: AgentDoc; onDirtyChange?: (dirty: boolean) => void }) {
  const updateAgent = useMutation(api.agents.update);
  const setAgentSkills = useMutation(api.agents.setSkills);
  const setSkillPin = useMutation(api.skills.setPin);
  const librarySkills = useQuery(api.skills.list, {}) as LibrarySkill[] | undefined;
  const toast = useToast();
  const form = useInspectorDraft(baseFor(agent));
  const { draft, set, saved } = form;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => onDirtyChange?.(form.dirty), [form.dirty, onDirtyChange]);

  async function save() {
    setError(null);
    setSaving(true);
    try {
      if (form.isChanged("skillLoading")) {
        // agents.update always takes the identity fields; send the saved ones unchanged.
        await updateAgent({
          agentId: agent._id as never,
          name: agent.name,
          role: agent.role,
          systemPrompt: agent.systemPrompt ?? "",
          skillLoading: draft.skillLoading,
        });
      }
      let attached = draft.skillIds;
      if (form.isChanged("skillIds")) {
        const res = await setAgentSkills({ agentId: agent._id as never, skillIds: draft.skillIds as never });
        attached = res.skillIds as unknown as string[];
        for (const w of res.warnings.slice(0, 4)) toast("info", "Heads up", w);
      }
      for (const id of attached) {
        if ((draft.pins[id] ?? null) === (saved.pins[id] ?? null)) continue;
        await setSkillPin({ agentId: agent._id as never, skillId: id as never, version: draft.pins[id] ?? null });
      }
      form.commit({ ...draft, skillIds: attached });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the skills");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <InspectorBody>
        <InspectorField
          label="Library skills"
          trailing={
            <Link href="/library" className="text-[12px] text-ink-3 underline-offset-2 hover:text-ink hover:underline">
              Library
            </Link>
          }
          hint="Order of picking is prompt order. A skill with several versions can be pinned."
        >
          <SkillPicker
            skills={librarySkills}
            value={draft.skillIds}
            onChange={(next) => set("skillIds", next)}
            pins={draft.pins}
            onPinChange={(id, version) => set("pins", { ...draft.pins, [id]: version })}
          />
        </InspectorField>

        <InspectorField
          label="Loading"
          htmlFor="inspector-skill-loading"
          hint={
            draft.skillLoading === "on_demand"
              ? "On demand: the prompt lists names; the agent loads each skill whole when it needs it."
              : "Inline: every skill goes into the prompt, up to 12,000 chars in total."
          }
        >
          <select
            id="inspector-skill-loading"
            value={draft.skillLoading}
            onChange={(e) => set("skillLoading", e.target.value === "on_demand" ? "on_demand" : "inline")}
            className={INSPECTOR_INPUT}
          >
            <option value="inline">Inline</option>
            <option value="on_demand">On demand</option>
          </select>
        </InspectorField>
      </InspectorBody>

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
      />
    </>
  );
}
