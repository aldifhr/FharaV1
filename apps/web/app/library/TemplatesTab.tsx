
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery } from "@fhara/runtime/react";
import { BookOpen, Layers, Plus, Search, Sparkles } from "lucide-react";
import { api } from "@fhara/runtime/api";
import Modal from "@/components/Modal";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import AgentAvatar from "@/components/AgentAvatar";
import { useToast } from "@/components/Toasts";
import { PageHeader } from "@/components/ui/page-header";
import Segmented from "@/components/ui/segmented";
import { Input } from "@/components/ui/input";
import { StatusTag } from "@/components/ui/status-tag";
import type { TemplateView } from "@/components/sidebar/AgentForms";
import { AGENT_ROLES, prefillPromptForRole, roleLabel, roleTemplateFor } from "@/lib/agentRoles";
import {
  TEMPLATE_DESCRIPTION_MAX,
  TEMPLATE_NAME_MAX,
  TEMPLATE_PROMPT_MAX,
} from "@/api/functions/lib/agentTemplates";

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
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"all" | "builtin" | "custom">("all");

  const stats = useMemo(() => {
    const list = templates ?? [];
    return {
      total: list.length,
      builtIn: list.filter((t) => t.builtIn).length,
      custom: list.filter((t) => !t.builtIn).length,
      withSkills: list.filter((t) => t.skillIds.length > 0).length,
    };
  }, [templates]);

  const visible = useMemo(() => {
    if (!templates) return [];
    const query = search.trim().toLowerCase();
    return templates.filter((t) => {
      if (kind === "builtin" && !t.builtIn) return false;
      if (kind === "custom" && t.builtIn) return false;
      if (!query) return true;
      return [t.name, t.description, roleLabel(t.role), ...(t.tags ?? [])]
        .filter(Boolean)
        .some((part) => String(part).toLowerCase().includes(query));
    });
  }, [templates, kind, search]);

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
      <PageHeader
        eyebrow="Reusable instructions"
        title="Library"
        leading={
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-field border border-line bg-panel text-ink-2">
            <BookOpen size={17} />
          </span>
        }
        meta={<p className="text-[13.5px] text-ink-2">A starting point for a new agent.</p>}
        actions={
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-field bg-ink px-2.5 text-[12.5px] font-medium text-canvas outline-none transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ink/30"
          >
            <Plus size={14} /> Template
          </button>
        }
      />
      <div className="mt-5">{tabs}</div>

      {templates === undefined ? (
        <div className="mt-6 space-y-4" aria-label="Loading templates">
          <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-line bg-panel shadow-card sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="p-5">
                <div className="h-3 w-16 rounded bg-hover" />
                <div className="mt-3 h-8 w-12 rounded bg-hover" />
              </div>
            ))}
          </div>
          <div className="h-64 rounded-2xl border border-line bg-panel shadow-card" />
        </div>
      ) : (
        <>
          <section
            aria-label="Template metrics"
            className="mt-6 grid grid-cols-2 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel shadow-card sm:divide-y-0 sm:divide-x lg:grid-cols-4"
          >
            {[
              { label: "Templates", value: stats.total, note: "available", icon: <Layers size={13} />, title: "Templates available" },
              { label: "Built-in", value: stats.builtIn, note: "from Fhara", icon: <Sparkles size={13} />, title: "Built-in templates from code" },
              { label: "Custom", value: stats.custom, note: "yours", icon: <Plus size={13} />, title: "Templates you created" },
              { label: "With skills", value: stats.withSkills, note: "preloaded", icon: <BookOpen size={13} />, title: "Templates that include skills" },
            ].map((metric) => (
              <div key={metric.label} className="p-4 sm:p-5" title={metric.title}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-caption">{metric.label}</span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-inset text-ink-3">{metric.icon}</span>
                </div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-[28px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-ink">{metric.value}</span>
                  <span className="truncate text-[12px] text-ink-3">{metric.note}</span>
                </div>
              </div>
            ))}
          </section>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Segmented
              label="Filter templates"
              value={kind}
              onChange={setKind}
              options={[
                { value: "all", label: "All" },
                { value: "builtin", label: "Built-in" },
                { value: "custom", label: "Custom" },
              ]}
            />
            <div className="relative w-full sm:ml-auto sm:w-64">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-2 text-ink-3" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search templates"
                aria-label="Search templates"
                className="h-[30px] bg-panel pl-8 text-[12.5px]"
              />
            </div>
          </div>

          <section className="mt-3 overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
            <div className="hidden items-center gap-3 border-b border-line px-4 py-2.5 text-caption sm:flex">
              <span className="min-w-0 flex-1">Template</span>
              <span className="hidden w-40 shrink-0 lg:block">Skills</span>
              <span className="w-32 shrink-0">Origin</span>
              <span className="w-16 shrink-0 text-right">Action</span>
            </div>
            {visible.length === 0 ? (
              <p className="px-5 py-10 text-center text-[13px] text-ink-3">No templates match these filters.</p>
            ) : (
              <ul className="divide-y divide-line">
                {visible.map((t) => {
                  const skillNames = t.skillIds.map(skillName).filter(Boolean) as string[];
                  return (
                    <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 transition-colors hover:bg-inset/60">
                      <button
                        type="button"
                        onClick={() => setEditing(t)}
                        className="flex min-w-0 flex-1 items-start gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ink/30 max-sm:basis-full"
                      >
                        <AgentAvatar name={t.name} size={28} avatarParams={t.avatarParams} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium text-ink">{t.name}</span>
                          <span className="mt-0.5 block truncate text-[12px] text-ink-2">{t.description || roleLabel(t.role)}</span>
                          <span className="mt-0.5 block truncate text-[11.5px] text-ink-3">{roleLabel(t.role)}</span>
                        </span>
                      </button>
                      <div className="flex shrink-0 items-center gap-3 max-sm:ml-11">
                        <span className="hidden w-40 shrink-0 truncate text-[12px] text-ink-3 lg:block" title={skillNames.join(", ")}>
                          {skillNames.length ? skillNames.join(", ") : "—"}
                        </span>
                        <div className="w-32 shrink-0">
                          <StatusTag tone={t.builtIn ? "neutral" : "active"}>{t.builtIn ? "Built-in" : "Custom"}</StatusTag>
                        </div>
                        <div className="flex w-16 shrink-0 justify-end">
                          <button
                            type="button"
                            disabled={using === t.id}
                            onClick={() => use(t)}
                            aria-label={`Create an agent from ${t.name}`}
                            className="rounded-field border border-line bg-panel px-2.5 py-1 text-[12.5px] text-ink outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40"
                          >
                            {using === t.id ? "Adding…" : "Use"}
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <p className="mt-2 text-[12px] text-ink-3">Showing {visible.length} of {stats.total} templates.</p>
        </>
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
  const [prompt, setPrompt] = useState(template?.systemPrompt ?? roleTemplateFor("frontend") ?? "");
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
        // New template, or a built-in saved as a custom copy (keeps its avatar).
        // No model or runtime: the global model list serves every agent (L4).
        await create({
          ...payload,
          ...(template?.avatarParams ? { avatarParams: template.avatarParams } : {}),
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
                setPrompt((current) => prefillPromptForRole(current, next));
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
            <span>{prompt.length.toLocaleString("en-US")} / {TEMPLATE_PROMPT_MAX.toLocaleString("en-US")}</span>
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
