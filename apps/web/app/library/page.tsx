"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import IconRail from "@/components/IconRail";
import Modal from "@/components/Modal";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import { roleLabel } from "@/lib/agentRoles";
import { SKILL_DESCRIPTION_MAX, SKILL_INSTRUCTIONS_MAX, SKILL_NAME_MAX } from "@/api/convex/lib/skills";

type Skill = {
  _id: string;
  name: string;
  description: string;
  instructions: string;
  tags?: string[];
  usedBy: Array<{ _id: string; name: string; role: string }>;
};

type Agent = { _id: string; name: string; role: string; isEnabled?: boolean };

const field =
  "w-full rounded-lg border border-line bg-transparent px-3 py-2 text-[14px] text-ink outline-none transition focus:border-ink-3";
const label = "grid gap-1.5 text-[12.5px] text-ink-3";

/** "Frontend, Backend" — agents by role only, deduped. */
function rolesText(usedBy: Skill["usedBy"]): string {
  return Array.from(new Set(usedBy.map((a) => roleLabel(a.role)))).join(", ");
}

/**
 * Library: reusable agent skills. Each skill is markdown guidance attached
 * to agents; at run time it is appended to the agent's prompt as
 * "## Skill: <name>".
 */
export default function LibraryPage() {
  const skills = useQuery(api.skills.list, {}) as Skill[] | undefined;
  const agents = useQuery(api.agents.list, {}) as Agent[] | undefined;
  const seedDefaults = useMutation(api.skills.seedDefaults);
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  const [seeding, setSeeding] = useState(false);

  const current = editing && editing !== "new" ? (skills ?? []).find((s) => s._id === editing._id) ?? editing : editing;

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-3xl">
          <header className="flex items-end justify-between gap-4">
            <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Library</h1>
            <button
              type="button"
              onClick={() => setEditing("new")}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 text-[13px] font-medium text-ink outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <Plus size={14} /> Skill
            </button>
          </header>
          <p className="mt-6 text-[15px] text-ink-2">
            {skills === undefined
              ? "Loading…"
              : `${skills.length} ${skills.length === 1 ? "skill" : "skills"} · added to an agent's instructions when it runs`}
          </p>

          {skills === undefined ? (
            <div className="mt-10 space-y-3" aria-label="Loading library">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-xl bg-hover" />
              ))}
            </div>
          ) : skills.length === 0 ? (
            <div className="mt-10 rounded-xl border border-dashed border-line px-4 py-5 text-[13px] text-ink-3">
              <p>No skills yet. A skill is a short set of instructions you can give to any agent.</p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={seeding}
                  onClick={async () => {
                    setSeeding(true);
                    try {
                      await seedDefaults({});
                    } finally {
                      setSeeding(false);
                    }
                  }}
                  className="rounded-lg border border-line bg-panel px-3 py-1.5 text-[13px] text-ink transition hover:bg-hover disabled:opacity-40"
                >
                  {seeding ? "Adding…" : "Add starter skills"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing("new")}
                  className="rounded-lg px-3 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover"
                >
                  Write your own
                </button>
              </div>
            </div>
          ) : (
            <ul className="mt-10 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
              {skills.map((s) => (
                <li key={s._id}>
                  <button
                    type="button"
                    onClick={() => setEditing(s)}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left outline-none transition hover:bg-hover focus-visible:bg-hover"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium">{s.name}</p>
                      {s.description && <p className="truncate text-[12.5px] text-ink-2">{s.description}</p>}
                    </div>
                    <span className="max-w-[40%] shrink-0 truncate pt-0.5 text-[12px] text-ink-3">
                      {s.usedBy.length ? rolesText(s.usedBy) : "Not used"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>

      {current && (
        <SkillModal
          key={current === "new" ? "new" : current._id}
          skill={current === "new" ? null : current}
          agents={agents ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function SkillModal({ skill, agents, onClose }: { skill: Skill | null; agents: Agent[]; onClose: () => void }) {
  const create = useMutation(api.skills.create);
  const update = useMutation(api.skills.update);
  const remove = useMutation(api.skills.remove);
  const setAgents = useMutation(api.skills.setAgents);
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [tags, setTags] = useState((skill?.tags ?? []).join(", "));
  const [instructions, setInstructions] = useState(skill?.instructions ?? "");
  const [usedBy, setUsedBy] = useState<Set<string>>(() => new Set((skill?.usedBy ?? []).map((a) => a._id)));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [deleting, setDeleting] = useState(false);

  const sortedAgents = useMemo(
    () => [...agents].sort((a, b) => roleLabel(a.role).localeCompare(roleLabel(b.role)) || a.name.localeCompare(b.name)),
    [agents],
  );
  // Two agents with the same role get their name to tell them apart.
  const roleCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of agents) m.set(a.role, (m.get(a.role) ?? 0) + 1);
    return m;
  }, [agents]);

  const toggle = (id: string) =>
    setUsedBy((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!name.trim() || !instructions.trim()) {
      setError("Name and instructions are required");
      return;
    }
    setSaving(true);
    try {
      const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
      const payload = { name, description, instructions, tags: tagList };
      let skillId = skill?._id;
      if (skillId) await update({ skillId: skillId as never, ...payload });
      else skillId = (await create(payload)) as unknown as string;
      const before = new Set((skill?.usedBy ?? []).map((a) => a._id));
      const changed = before.size !== usedBy.size || [...usedBy].some((id) => !before.has(id));
      if (changed) await setAgents({ skillId: skillId as never, agentIds: [...usedBy] as never });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save skill");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={skill ? "Edit skill" : "New skill"} onClose={onClose} maxWidth="max-w-xl">
      <form onSubmit={handleSubmit} className="mt-5 grid gap-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={label}>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={SKILL_NAME_MAX} required placeholder="Write tests first" className={field} />
          </label>
          <label className={label}>
            Tags
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="testing, workflow" className={field} />
          </label>
        </div>
        <label className={label}>
          Description
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={SKILL_DESCRIPTION_MAX} placeholder="One line on what it does" className={field} />
        </label>
        <label className={label}>
          <span className="flex justify-between">
            Instructions
            <span>{instructions.length.toLocaleString()} / {SKILL_INSTRUCTIONS_MAX.toLocaleString()}</span>
          </span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            maxLength={SKILL_INSTRUCTIONS_MAX}
            rows={10}
            required
            placeholder="Markdown. Short, concrete steps the agent should follow."
            className={`${field} resize-y font-mono text-[13px] leading-relaxed`}
          />
        </label>

        <fieldset className="grid gap-2">
          <legend className="mb-1.5 text-[12.5px] text-ink-3">Used by</legend>
          {sortedAgents.length === 0 ? (
            <p className="text-[13px] text-ink-3">No agents yet.</p>
          ) : (
            <div className="grid max-h-48 grid-cols-2 gap-x-4 gap-y-1.5 overflow-y-auto rounded-lg border border-line p-3">
              {sortedAgents.map((a) => (
                <label key={a._id} className="flex min-w-0 cursor-pointer items-center gap-2 text-[13px] text-ink">
                  <input type="checkbox" checked={usedBy.has(a._id)} onChange={() => toggle(a._id)} className="accent-current" />
                  <span className="truncate">
                    {(roleCount.get(a.role) ?? 0) > 1 ? a.name : roleLabel(a.role)}
                    {a.isEnabled === false ? <span className="text-ink-3"> · disabled</span> : null}
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        {error && <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex items-center justify-between gap-2">
          {skill ? (
            <button
              type="button"
              onClick={() =>
                setConfirm({
                  title: "Delete skill?",
                  message: `"${skill.name}" will be removed from the library and from every agent that uses it.`,
                })
              }
              className="rounded-lg px-3 py-1.5 text-[13px] text-red-600 transition hover:bg-hover dark:text-red-400"
            >
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-ink px-3.5 py-1.5 text-[13px] font-medium text-canvas transition hover:opacity-90 disabled:opacity-40"
            >
              {saving ? "Saving…" : skill ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </form>
      <ConfirmDialog
        request={confirm}
        pending={deleting}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (!skill) return;
          setDeleting(true);
          try {
            await remove({ skillId: skill._id as never });
            setConfirm(null);
            onClose();
          } catch (err) {
            setConfirm(null);
            setError(err instanceof Error ? err.message : "Failed to delete skill");
          } finally {
            setDeleting(false);
          }
        }}
      />
    </Modal>
  );
}
