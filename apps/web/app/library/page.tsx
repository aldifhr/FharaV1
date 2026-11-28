
import { Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "@/lib/spaRouter";
import { useAction, useMutation, useQuery } from "@fhara/runtime/react";
import { BookOpen, Check, Download, GitBranch, History, Layers, MoreHorizontal, Plus, Search } from "lucide-react";
import { ImportFromGithubModal } from "./ImportFromGithub";
import { useToast } from "@/components/Toasts";
import Segmented from "@/components/ui/segmented";
import { HEADER_ACTION, PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { TemplatesTab } from "./TemplatesTab";
import { BrowseTab } from "./BrowseTab";
import {
  errorText,
  SkillHistoryModal,
  skillMetaText,
  SourcesTab,
  usedByText,
  type LibrarySkill,
} from "./SkillsV2";
import { SKILL_PERMISSIONS, SKILL_PERMISSION_LABELS } from "@/api/functions/lib/skillGraph";
import { api } from "@fhara/runtime/api";
import Sidebar from "@/components/Sidebar";
import Modal from "@/components/Modal";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import { roleLabel } from "@/lib/agentRoles";
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_INSTRUCTIONS_MAX,
  SKILL_NAME_MAX,
  SKILL_STORED_MAX,
  SKILLS_PROMPT_BUDGET,
} from "@/api/functions/lib/skills";

type Skill = LibrarySkill;

type Agent = { _id: string; name: string; role: string; isEnabled?: boolean };

const field =
  "w-full rounded-lg border border-line bg-transparent px-3 py-2 text-[14px] text-ink outline-none transition focus:border-ink-3";
const label = "grid gap-1.5 text-[12.5px] text-ink-3";

/** "owner/repo · MIT" for an imported skill. */
function sourceText(source: NonNullable<Skill["source"]>): string {
  return [source.repo, source.license].filter(Boolean).join(" · ");
}

/**
 * Library: reusable agent skills. Each skill is markdown guidance attached
 * to agents; at run time it is appended to the agent's prompt as
 * "## Skill: <name>".
 */
type Tab = "skills" | "browse" | "sources" | "templates";

export default function LibraryPage() {
  return (
    <Suspense fallback={null}>
      <LibraryInner />
    </Suspense>
  );
}

function LibraryInner() {
  const params = useSearchParams();
  const router = useRouter();
  const rawTab = params.get("tab");
  const tab: Tab =
    rawTab === "templates" ? "templates" : rawTab === "sources" ? "sources" : rawTab === "browse" ? "browse" : "skills";
  const projectId = params.get("project") ?? undefined;
  const setTab = (next: Tab) => {
    const q = new URLSearchParams(params.toString());
    if (next === "skills") q.delete("tab");
    else q.set("tab", next);
    const qs = q.toString();
    router.replace(qs ? `/library?${qs}` : "/library");
  };
  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <Sidebar projectId={projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-8 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-[1280px]">
          {tab === "browse" ? (
            <BrowseView tabs={<LibraryTabs tab={tab} onChange={setTab} />} />
          ) : tab !== "templates" ? (
            <SkillsTab view={tab} tabs={<LibraryTabs tab={tab} onChange={setTab} />} />
          ) : (
            <TemplatesTab projectId={projectId} tabs={<LibraryTabs tab={tab} onChange={setTab} />} />
          )}
        </div>
      </main>
    </div>
  );
}

function LibraryTabs({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) {
  return (
    <Segmented
      label="Library section"
      value={tab}
      onChange={onChange}
      options={[
        { value: "skills", label: "Skills" },
        { value: "browse", label: "Browse" },
        { value: "sources", label: "Sources" },
        { value: "templates", label: "Templates" },
      ]}
    />
  );
}

/** Browse (skill marketplace) with the library list it matches installed skills against. */
function BrowseView({ tabs }: { tabs: React.ReactNode }) {
  const skills = useQuery(api.skills.list, {}) as Skill[] | undefined;
  return <BrowseTab tabs={tabs} skills={skills} />;
}

type UsageFilter = "all" | "used" | "unused";

function SkillsTab({ tabs, view }: { tabs: React.ReactNode; view: "skills" | "sources" }) {
  const skills = useQuery(api.skills.list, {}) as Skill[] | undefined;
  const agents = useQuery(api.agents.list, {}) as Agent[] | undefined;
  const seedDefaults = useMutation(api.skills.seedDefaults);
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  const [history, setHistory] = useState<Skill | null>(null);
  const [importing, setImporting] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [search, setSearch] = useState("");
  const [usage, setUsage] = useState<UsageFilter>("all");

  const current = editing && editing !== "new" ? (skills ?? []).find((s) => s._id === editing._id) ?? editing : editing;
  const historyFor = history ? (skills ?? []).find((s) => s._id === history._id) ?? history : null;

  const stats = useMemo(() => {
    const list = skills ?? [];
    return {
      total: list.length,
      used: list.filter((s) => s.usedBy.length > 0).length,
      imported: list.filter((s) => Boolean(s.source)).length,
      versions: list.reduce((n, s) => n + (s.versionCount ?? 0), 0),
    };
  }, [skills]);

  const visible = useMemo(() => {
    if (!skills) return [];
    const query = search.trim().toLowerCase();
    return skills.filter((s) => {
      if (usage === "used" && s.usedBy.length === 0) return false;
      if (usage === "unused" && s.usedBy.length > 0) return false;
      if (!query) return true;
      return [s.name, s.description, s.source ? sourceText(s.source) : "", ...(s.tags ?? [])]
        .filter(Boolean)
        .some((part) => part!.toLowerCase().includes(query));
    });
  }, [skills, search, usage]);

  const modals = (
    <>
      {importing && <ImportFromGithubModal onClose={() => setImporting(false)} />}
      {current && (
        <SkillModal
          key={current === "new" ? "new" : current._id}
          skill={current === "new" ? null : current}
          skills={skills ?? []}
          agents={agents ?? []}
          onClose={() => setEditing(null)}
        />
      )}
      {historyFor && <SkillHistoryModal skill={historyFor} onClose={() => setHistory(null)} />}
    </>
  );

  if (view === "sources") {
    return (
      <>
        <SourcesTab tabs={tabs} skills={skills} onOpen={(s) => setEditing(s)} onHistory={(s) => setHistory(s)} />
        {modals}
      </>
    );
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
        meta={<p className="text-[13.5px] text-ink-2">Skills join an agent&apos;s instructions when it runs.</p>}
        actions={
          <>
            <button type="button" onClick={() => setImporting(true)} className={HEADER_ACTION}>
              <Download size={14} /> Import from GitHub
            </button>
            <button
              type="button"
              onClick={() => setEditing("new")}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-field bg-ink px-2.5 text-[12.5px] font-medium text-canvas outline-none transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ink/30"
            >
              <Plus size={14} /> Skill
            </button>
          </>
        }
      />
      <div className="mt-5">{tabs}</div>

      {skills === undefined ? (
        <div className="mt-6 space-y-4" aria-label="Loading library">
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
      ) : skills.length === 0 ? (
        <div className="mt-12 flex flex-col items-center rounded-2xl border border-dashed border-line bg-panel px-5 py-10 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-inset text-ink-3">
            <BookOpen size={18} />
          </span>
          <p className="mt-4 text-[14px] text-ink-2">No skills yet.</p>
          <p className="mt-1 text-[13px] text-ink-3">A skill is a short set of instructions you can give to any agent.</p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
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
              className={HEADER_ACTION}
            >
              {seeding ? "Adding…" : "Add starter skills"}
            </button>
            <button type="button" onClick={() => setImporting(true)} className={HEADER_ACTION}>
              Import from GitHub
            </button>
            <button type="button" onClick={() => setEditing("new")} className={HEADER_ACTION}>
              Write your own
            </button>
          </div>
        </div>
      ) : (
        <>
          <section
            aria-label="Library metrics"
            className="mt-6 grid grid-cols-2 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel shadow-card sm:divide-y-0 sm:divide-x lg:grid-cols-4"
          >
            {[
              { label: "Skills", value: stats.total, note: "in the library", icon: <Layers size={13} />, title: "Skills in the library" },
              { label: "In use", value: stats.used, note: `of ${stats.total} assigned`, icon: <Check size={13} />, title: "Skills assigned to at least one agent" },
              { label: "Imported", value: stats.imported, note: "from GitHub", icon: <GitBranch size={13} />, title: "Skills imported from a GitHub repository" },
              { label: "Versions", value: stats.versions, note: "stored", icon: <History size={13} />, title: "Saved versions across all skills" },
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
              label="Filter skills by usage"
              value={usage}
              onChange={setUsage}
              options={[
                { value: "all", label: "All" },
                { value: "used", label: "In use" },
                { value: "unused", label: "Unused" },
              ]}
            />
            <div className="relative w-full sm:ml-auto sm:w-64">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-2 text-ink-3" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search skills"
                aria-label="Search skills"
                className="h-[30px] bg-panel pl-8 text-[12.5px]"
              />
            </div>
          </div>

          <section className="mt-3 overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
            <div className="hidden items-center gap-3 border-b border-line px-4 py-2.5 text-caption sm:flex">
              <span className="min-w-0 flex-1">Skill</span>
              <span className="hidden w-44 shrink-0 lg:block">Source</span>
              <span className="w-40 shrink-0">Used by</span>
              <span className="w-8 shrink-0" />
            </div>
            {visible.length === 0 ? (
              <p className="px-5 py-10 text-center text-[13px] text-ink-3">No skills match these filters.</p>
            ) : (
              <ul className="divide-y divide-line">
                {visible.map((s) => (
                  <li key={s._id} className="group flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 transition-colors hover:bg-inset/60">
                    <button
                      type="button"
                      onClick={() => setEditing(s)}
                      className="flex min-w-0 flex-1 items-start gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ink/30 max-sm:basis-full"
                    >
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-inset text-ink-3">
                        <BookOpen size={13} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <span className="truncate text-[13.5px] font-medium text-ink">{s.name}</span>
                          {s.version ? <span className="text-mono-id">v{s.version}</span> : null}
                        </span>
                        {s.description && <span className="mt-0.5 block truncate text-[12px] text-ink-2">{s.description}</span>}
                        <span className="mt-0.5 block truncate font-mono text-[11.5px] text-ink-3">{skillMetaText(s)}</span>
                        {s.tags?.length ? <span className="mt-1 block truncate text-[11px] text-ink-3">{s.tags.join(" · ")}</span> : null}
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center gap-3 max-sm:ml-9">
                      <div className="hidden w-44 shrink-0 lg:block">
                        {s.source ? (
                          <a
                            href={s.source.url}
                            target="_blank"
                            rel="noreferrer"
                            title={sourceText(s.source)}
                            className="block truncate text-[12px] text-ink-2 outline-none transition hover:text-ink hover:underline focus-visible:underline"
                          >
                            {sourceText(s.source)}
                            {s.trimmed ? " · trimmed" : s.inlineTrimmed ? " · trimmed when inline" : ""}
                          </a>
                        ) : (
                          <span className="text-[12px] text-ink-3">Written here</span>
                        )}
                      </div>
                      <span className="w-40 shrink-0 truncate text-[12px] text-ink-3">
                        {s.usedBy.length ? usedByText(s.usedBy) : "Not used"}
                      </span>
                      <SkillRowMenu skill={s} onEdit={() => setEditing(s)} onHistory={() => setHistory(s)} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className="mt-2 text-[12px] text-ink-3">Showing {visible.length} of {stats.total} skills.</p>
        </>
      )}
      {modals}
    </>
  );
}

/** Row ⋯ menu: Edit, and "Update from source" for skills imported from GitHub. */
function SkillRowMenu({ skill, onEdit, onHistory }: { skill: Skill; onEdit: () => void; onHistory: () => void }) {
  const updateFromSource = useAction(api.skills.updateFromSource);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function handleUpdate() {
    setOpen(false);
    setBusy(true);
    try {
      const res = await updateFromSource({ skillId: skill._id as never });
      toast(
        res.status === "updated" ? "success" : "info",
        res.status === "updated" ? "Skill updated" : "Already up to date",
        `${skill.name} · ${res.sha.slice(0, 7)}`
      );
    } catch (err) {
      toast("error", "Update failed", errorText(err, "Could not read the source"));
    } finally {
      setBusy(false);
    }
  }

  const item = "flex w-full items-center px-3 py-2 text-left text-[14px] text-ink hover:bg-hover disabled:opacity-40";
  return (
    <div ref={ref} className="relative shrink-0 self-center">
      <button
        type="button"
        aria-label={`Actions for ${skill.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-ink-3 outline-none transition hover:border-line hover:bg-panel hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40 ${open || busy ? "opacity-100" : "opacity-0 group-hover:opacity-100"} [@media(hover:none)]:opacity-100`}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-48 overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-[0_12px_32px_-12px_rgba(20,20,40,0.3)]"
        >
          <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onEdit(); }}>
            Edit
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onHistory(); }}>
            History{skill.versionCount ? ` · ${skill.versionCount}` : ""}
          </button>
          {skill.source && (
            <>
              <button type="button" role="menuitem" className={item} onClick={handleUpdate}>
                Update from source
              </button>
              <a role="menuitem" href={skill.source.url} target="_blank" rel="noreferrer" className={item} onClick={() => setOpen(false)}>
                View on GitHub
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SkillModal({
  skill,
  skills,
  agents,
  onClose,
}: {
  skill: Skill | null;
  skills: Skill[];
  agents: Agent[];
  onClose: () => void;
}) {
  const toast = useToast();
  const create = useMutation(api.skills.create);
  const update = useMutation(api.skills.update);
  const remove = useMutation(api.skills.remove);
  const assignRoles = useMutation(api.skills.assignRoles);
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [tags, setTags] = useState((skill?.tags ?? []).join(", "));
  const [instructions, setInstructions] = useState(skill?.instructions ?? "");
  const [requires, setRequires] = useState<string[]>(skill?.requires ?? []);
  const [permissions, setPermissions] = useState<string[]>(skill?.permissions ?? []);
  // Imported skills are stored whole, so their edit limit is the stored cap.
  const instructionsMax = skill?.source ? SKILL_STORED_MAX : SKILL_INSTRUCTIONS_MAX;
  const otherSkills = useMemo(() => skills.filter((s) => s._id !== skill?._id), [skills, skill]);
  // Role assignment covers ENABLED agents only; disabled ones keep what they have.
  const enabledAgents = useMemo(() => agents.filter((a) => a.isEnabled !== false), [agents]);
  const initialRoles = useMemo(() => {
    const ids = new Set((skill?.usedBy ?? []).map((a) => a._id));
    return new Set(enabledAgents.filter((a) => ids.has(a._id)).map((a) => a.role));
  }, [skill, enabledAgents]);
  const [roles, setRoles] = useState<Set<string>>(initialRoles);
  // Agents can load after the modal opens: follow them until the user edits roles.
  const rolesTouched = useRef(false);
  useEffect(() => {
    if (!rolesTouched.current) setRoles(initialRoles);
  }, [initialRoles]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [deleting, setDeleting] = useState(false);

  const roleOptions = useMemo(() => {
    const ids = new Set((skill?.usedBy ?? []).map((a) => a._id));
    const byRole = new Map<string, { role: string; total: number; attached: number }>();
    for (const a of enabledAgents) {
      const row = byRole.get(a.role) ?? { role: a.role, total: 0, attached: 0 };
      row.total++;
      if (ids.has(a._id)) row.attached++;
      byRole.set(a.role, row);
    }
    return [...byRole.values()].sort((a, b) => roleLabel(a.role).localeCompare(roleLabel(b.role)));
  }, [skill, enabledAgents]);
  const disabledUsers = useMemo(() => {
    const disabled = new Set(agents.filter((a) => a.isEnabled === false).map((a) => a._id));
    return (skill?.usedBy ?? []).filter((a) => disabled.has(a._id));
  }, [skill, agents]);

  const toggle = (id: string) => {
    rolesTouched.current = true;
    setRoles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
      const payload = { name, description, instructions, tags: tagList, requires: requires as never, permissions };
      let skillId = skill?._id;
      const warnings: string[] = [];
      if (skillId) {
        const res = await update({ skillId: skillId as never, ...payload });
        warnings.push(...res.warnings);
        if (res.version) toast("success", "Saved", `${name.trim()} · v${res.version}`);
      } else {
        skillId = (await create(payload)) as unknown as string;
      }
      // Partially assigned roles count as changed so saving completes them.
      const partial = roleOptions.some((r) => roles.has(r.role) && r.attached < r.total);
      const changed = partial || initialRoles.size !== roles.size || [...roles].some((r) => !initialRoles.has(r));
      if (changed) warnings.push(...(await assignRoles({ skillId: skillId as never, roles: [...roles] })).warnings);
      for (const w of Array.from(new Set(warnings)).slice(0, 4)) toast("info", "Heads up", w);
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
        {skill?.source && (
          <p className="-mt-2 text-[12.5px] text-ink-3">
            From{" "}
            <a href={skill.source.url} target="_blank" rel="noreferrer" className="text-ink-2 underline-offset-2 hover:text-ink hover:underline">
              {skill.source.repo}/{skill.source.path}
            </a>
            {skill.source.license ? (
              <>
                {" · "}
                {skill.source.licenseUrl ? (
                  <a href={skill.source.licenseUrl} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-ink hover:underline">
                    {skill.source.license}
                  </a>
                ) : (
                  skill.source.license
                )}
              </>
            ) : (
              " · no license"
            )}
            {" · "}
            {skill.source.sha.slice(0, 7)}
            {skill.trimmed ? " · trimmed to fit" : ""}
          </p>
        )}
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
            <span>{instructions.length.toLocaleString("en-US")} / {instructionsMax.toLocaleString("en-US")}</span>
          </span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            maxLength={instructionsMax}
            rows={10}
            required
            placeholder="Markdown. Short, concrete steps the agent should follow."
            className={`${field} resize-y font-mono text-[13px] leading-relaxed`}
          />
        </label>

        <div className="grid gap-5 sm:grid-cols-2">
          <fieldset className="grid content-start gap-2">
            <legend className="mb-1.5 text-[12.5px] text-ink-3">Requires</legend>
            {otherSkills.length === 0 ? (
              <p className="text-[13px] text-ink-3">No other skills.</p>
            ) : (
              <div className="grid max-h-36 gap-1.5 overflow-y-auto rounded-lg border border-line p-3">
                {otherSkills.map((o) => (
                  <label key={o._id} className="flex min-w-0 cursor-pointer items-center gap-2 text-[13px] text-ink">
                    <input
                      type="checkbox"
                      checked={requires.includes(o._id)}
                      onChange={() =>
                        setRequires((prev) => (prev.includes(o._id) ? prev.filter((id) => id !== o._id) : [...prev, o._id]))
                      }
                      className="accent-current"
                    />
                    <span className="truncate">{o.name}</span>
                  </label>
                ))}
              </div>
            )}
            <p className="text-[12px] text-ink-3">Assigning this skill adds these too.</p>
          </fieldset>
          <fieldset className="grid content-start gap-2">
            <legend className="mb-1.5 text-[12.5px] text-ink-3">Needs</legend>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-lg border border-line p-3">
              {SKILL_PERMISSIONS.map((perm) => (
                <label key={perm} className="flex min-w-0 cursor-pointer items-center gap-2 text-[13px] text-ink">
                  <input
                    type="checkbox"
                    checked={permissions.includes(perm)}
                    onChange={() =>
                      setPermissions((prev) => (prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm]))
                    }
                    className="accent-current"
                  />
                  <span className="truncate">{SKILL_PERMISSION_LABELS[perm]}</span>
                </label>
              ))}
            </div>
            <p className="text-[12px] text-ink-3">Warns on roles without these. Never grants tools.</p>
          </fieldset>
        </div>

        <fieldset className="grid gap-2">
          <legend className="mb-1.5 text-[12.5px] text-ink-3">Assign to roles</legend>
          {roleOptions.length === 0 ? (
            <p className="text-[13px] text-ink-3">No enabled agents yet.</p>
          ) : (
            <div className="grid max-h-48 grid-cols-2 gap-x-4 gap-y-1.5 overflow-y-auto rounded-lg border border-line p-3">
              {roleOptions.map((r) => (
                <label key={r.role} className="flex min-w-0 cursor-pointer items-center gap-2 text-[13px] text-ink">
                  <input type="checkbox" checked={roles.has(r.role)} onChange={() => toggle(r.role)} className="accent-current" />
                  <span className="truncate">
                    {roleLabel(r.role)}
                    {r.total > 1 ? <span className="text-ink-3"> · {r.total} agents</span> : null}
                    {r.attached > 0 && r.attached < r.total ? (
                      <span className="text-ink-3"> · {r.attached} of {r.total} now</span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          )}
          <p className="text-[12px] text-ink-3">
            Adds or removes this skill on every enabled agent with that role. Inline agents get at most{" "}
            {SKILLS_PROMPT_BUDGET.toLocaleString("en-US")} chars of skills (later ones are cut); on-demand agents load each one whole.
            {disabledUsers.length > 0 ? ` Also on disabled: ${disabledUsers.map((a) => a.name).join(", ")}.` : ""}
          </p>
        </fieldset>

        {error && <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex items-center justify-between gap-2">
          {skill ? (
            <button
              type="button"
              onClick={() =>
                setConfirm({
                  title: "Delete skill?",
                  message: `"${skill.name}" will be removed from the library and from every agent that uses it.${
                    skill.requiredBy.length ? ` ${skill.requiredBy.map((r) => `"${r.name}"`).join(", ")} require${skill.requiredBy.length === 1 ? "s" : ""} it.` : ""
                  }`,
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
            const res = await remove({ skillId: skill._id as never });
            for (const w of res.warnings.slice(0, 3)) toast("info", "Heads up", w);
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
