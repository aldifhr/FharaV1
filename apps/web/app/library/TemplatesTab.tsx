"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import Modal from "@/components/Modal";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import AgentAvatar from "@/components/AgentAvatar";
import { deserializeAvatartion } from "@/components/ui/avatartion";
import { useToast } from "@/components/Toasts";
import type { TemplateView } from "@/components/sidebar/AgentForms";
import { AGENT_ROLES, ROLE_DEFAULT_PROMPTS, roleLabel } from "@/lib/agentRoles";
import {
  TEMPLATE_DESCRIPTION_MAX,
  TEMPLATE_NAME_MAX,
  TEMPLATE_PROMPT_MAX,
} from "@/api/convex/lib/agentTemplates";

type LibrarySkill = { _id: string; name: string };

const field =
  "w-full rounded-lg border border-line bg-transparent px-3 py-2 text-[14px] text-ink outline-none transition focus:border-ink-3";
const label = "grid gap-1.5 text-[12.5px] text-ink-3";

/**
 * Library → Templates: built-in templates (from code) and custom ones.
 * "Use" creates an agent from the template (joining the project in
 * `?project=` when there is one). Custom templates can be edited and
 * deleted; a built-in can be saved as a custom copy.
 */
export function TemplatesTab({ projectId, tabs }: { projectId?: string; tabs: ReactNode }) {
  const templates = useQuery(api.agentTemplates.list, {}) as TemplateView[] | undefined;
  const skills = useQuery(api.skills.list, {}) as LibrarySkill[] | undefined;
  const createFromTemplate = useMutation(api.agentTemplates.createAgentFromTemplate);
  const toast = useToast();
  const [editing, setEditing] = useState<TemplateView | "new" | null>(null);
  const [using, setUsing] = useState<string | null>(null);

  const skillName = (id: string) => (skills ?? []).find((s) => s._id === id)?.name;
  const current =
    editing && editing !== "new" ? (templates ?? []).find((t) => t.id === editing.id) ?? editing : editing;

  async function use(template: TemplateView) {
    setUsing(template.id);
    try {
      const result = await createFromTemplate({
        templateId: template.id,
        ...(projectId ? { projectId: projectId as never } : {}),
      });
      toast("success", `Added ${result.name}`, projectId ? "Joined this project's team" : `From ${template.name}`);
    } catch (err) {
      toast("error", "Couldn't create the agent", err instanceof Error ? err.message : undefined);
    } finally {
      setUsing(null);
    }
  }

  return (
    <>
      <header className="flex items-end justify-between gap-4">
        <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Library</h1>
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 text-[13px] font-medium text-ink outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <Plus size={14} /> Template
        </button>
      </header>
      <div className="mt-5">{tabs}</div>
      <p className="mt-6 text-[15px] text-ink-2">
        {templates === undefined
          ? "Loading…"
          : `${templates.length} ${templates.length === 1 ? "template" : "templates"} · a starting point for a new agent`}
      </p>

      {templates === undefined ? (
        <div className="mt-10 space-y-3" aria-label="Loading templates">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-hover" />
          ))}
        </div>
      ) : (
        <ul className="mt-10 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
          {templates.map((t) => {
            const skillNames = t.skillIds.map(skillName).filter(Boolean) as string[];
            return (
              <li key={t.id} className="flex items-center gap-1 pr-3 transition hover:bg-hover">
                <button
                  type="button"
                  onClick={() => setEditing(t)}
                  className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-left outline-none focus-visible:bg-hover"
                >
                  <AgentAvatar name={t.name} size={28} avatar={deserializeAvatartion(t.avatarParams) ?? undefined} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium">
                      {t.name}
                      <span className="ml-2 text-[12px] font-normal text-ink-3">
                        {roleLabel(t.role)}
                        {t.builtIn ? " · built-in" : ""}
                      </span>
                    </p>
                    {t.description && <p className="truncate text-[12.5px] text-ink-2">{t.description}</p>}
                    {skillNames.length > 0 && (
                      <p className="truncate text-[12px] text-ink-3">Skills: {skillNames.join(", ")}</p>
                    )}
                  </div>
                </button>
                <button
                  type="button"
                  disabled={using === t.id}
                  onClick={() => use(t)}
                  aria-label={`Create an agent from ${t.name}`}
                  className="shrink-0 rounded-lg border border-line bg-canvas px-2.5 py-1 text-[12.5px] text-ink outline-none transition hover:bg-panel focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-40"
                >
                  {using === t.id ? "Adding…" : "Use"}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {current && (
        <TemplateModal
          key={current === "new" ? "new" : current.id}
          template={current === "new" ? null : current}
          skills={skills}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function TemplateModal({
  template,
  skills,
  onClose,
}: {
  template: TemplateView | null;
  skills: LibrarySkill[] | undefined;
  onClose: () => void;
}) {
  const create = useMutation(api.agentTemplates.create);
  const update = useMutation(api.agentTemplates.update);
  const remove = useMutation(api.agentTemplates.remove);
  const builtIn = template?.builtIn ?? false;
  const [name, setName] = useState(template ? (builtIn ? `${template.name} (custom)` : template.name) : "");
  const [role, setRole] = useState(template?.role ?? "frontend");
  const [description, setDescription] = useState(template?.description ?? "");
  const [tags, setTags] = useState((template?.tags ?? []).join(", "));
  const [prompt, setPrompt] = useState(template?.systemPrompt ?? ROLE_DEFAULT_PROMPTS.frontend ?? "");
  const [skillIds, setSkillIds] = useState<string[]>(template?.skillIds ?? []);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name,
        role,
        description,
        systemPrompt: prompt,
        skillIds: skillIds as never,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      };
      if (template && !builtIn) {
        await update({ templateId: template.id as never, ...payload });
      } else {
        // New template, or a built-in saved as a custom copy (keeps its avatar,
        // runtime and model preference).
        await create({
          ...payload,
          ...(template?.avatarParams ? { avatarParams: template.avatarParams } : {}),
          ...(template?.runtime ? { runtime: template.runtime } : {}),
          ...(template?.llmProviderId ? { llmProviderId: template.llmProviderId as never } : {}),
          ...(template?.llmModelId ? { llmModelId: template.llmModelId as never } : {}),
          ...(template?.opencodeModel ? { opencodeModel: template.opencodeModel } : {}),
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save template");
    } finally {
      setSaving(false);
    }
  }

  const title = !template ? "New template" : builtIn ? template.name : "Edit template";
  const missing = builtIn
    ? (template?.suggestedSkills ?? []).filter(
        (n) => !(skills ?? []).some((s) => s.name.toLowerCase() === n.toLowerCase()),
      )
    : [];

  return (
    <Modal title={title} onClose={onClose} maxWidth="max-w-xl">
      <form onSubmit={handleSubmit} className="mt-5 grid gap-5">
        {builtIn && (
          <p className="rounded-lg border border-line bg-canvas px-3 py-2 text-[12.5px] text-ink-3">
            Built-in templates can't be changed. Edit below to save your own copy.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={label}>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={TEMPLATE_NAME_MAX} required placeholder="React Frontend" className={field} />
          </label>
          <label className={label}>
            Role
            <select
              value={role}
              onChange={(e) => {
                const next = e.target.value;
                // Swap in the new role's default only while the prompt is untouched.
                if (prompt.trim() === (ROLE_DEFAULT_PROMPTS[role] ?? "").trim()) setPrompt(ROLE_DEFAULT_PROMPTS[next] ?? "");
                setRole(next);
              }}
              className={`${field} bg-canvas`}
            >
              {AGENT_ROLES.map((r) => (
                <option key={r} value={r}>{roleLabel(r)}</option>
              ))}
            </select>
          </label>
        </div>
        <label className={label}>
          Description
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={TEMPLATE_DESCRIPTION_MAX} placeholder="One line on what it's for" className={field} />
        </label>
        <label className={label}>
          Tags
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="frontend, react" className={field} />
        </label>
        <label className={label}>
          <span className="flex justify-between">
            Instructions
            <span>{prompt.length.toLocaleString()} / {TEMPLATE_PROMPT_MAX.toLocaleString()}</span>
          </span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={TEMPLATE_PROMPT_MAX}
            rows={10}
            placeholder="Leave empty to use the role's default instructions."
            className={`${field} resize-y font-mono text-[13px] leading-relaxed`}
          />
        </label>
        <fieldset className="grid gap-2">
          <legend className="mb-1.5 text-[12.5px] text-ink-3">Skills</legend>
          {skills === undefined ? (
            <p className="text-[13px] text-ink-3">Loading…</p>
          ) : skills.length === 0 ? (
            <p className="text-[13px] text-ink-3">No skills in the library yet.</p>
          ) : (
            <div className="grid max-h-40 grid-cols-2 gap-x-4 gap-y-1.5 overflow-y-auto rounded-lg border border-line p-3">
              {skills.map((s) => (
                <label key={s._id} className="flex min-w-0 cursor-pointer items-center gap-2 text-[13px] text-ink">
                  <input
                    type="checkbox"
                    checked={skillIds.includes(s._id)}
                    onChange={() =>
                      setSkillIds((prev) => (prev.includes(s._id) ? prev.filter((id) => id !== s._id) : [...prev, s._id]))
                    }
                    className="accent-current"
                  />
                  <span className="truncate">{s.name}</span>
                </label>
              ))}
            </div>
          )}
          {missing.length > 0 && (
            <p className="text-[12px] text-ink-3">Suggests {missing.join(", ")} — not in your library yet.</p>
          )}
        </fieldset>

        {error && <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex items-center justify-between gap-2">
          {template && !builtIn ? (
            <button
              type="button"
              onClick={() =>
                setConfirm({ title: "Delete template?", message: `"${template.name}" will be removed. Agents made from it stay as they are.` })
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
              {saving ? "Saving…" : builtIn ? "Save as my template" : template ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </form>
      <ConfirmDialog
        request={confirm}
        pending={deleting}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (!template) return;
          setDeleting(true);
          try {
            await remove({ templateId: template.id });
            setConfirm(null);
            onClose();
          } catch (err) {
            setConfirm(null);
            setError(err instanceof Error ? err.message : "Failed to delete template");
          } finally {
            setDeleting(false);
          }
        }}
      />
    </Modal>
  );
}
