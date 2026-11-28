
import { Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "@/lib/spaRouter";
import { useMutation, useQuery } from "@fhara/runtime/react";
import { Brain, Pin, Plus, Search, User, Users } from "lucide-react";
import { api } from "@fhara/runtime/api";
import Sidebar from "@/components/Sidebar";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import MemorySuggestions from "@/components/memory/MemorySuggestions";
import { HEADER_ACTION, PageHeader } from "@/components/ui/page-header";
import Segmented from "@/components/ui/segmented";
import { Input } from "@/components/ui/input";
import { StatusTag } from "@/components/ui/status-tag";
import { roleLabel } from "@/lib/agentRoles";
import { relativeTime } from "@/lib/runFormat";
import { MEMORY_CONTENT_MAX, MEMORY_PROMPT_BUDGET, MEMORY_TITLE_MAX, type MemoryScope } from "@/api/functions/lib/memory";
import { RECALL_TOP_K } from "@/api/functions/lib/memoryRecall";

type Memory = {
  _id: string;
  scope: MemoryScope;
  projectId?: string;
  agentId?: string;
  title: string;
  content: string;
  tags?: string[];
  pinned: boolean;
  source: "user" | "agent";
  createdAt: number;
  updatedAt: number;
};

type Project = { _id: string; name: string };
type Agent = { _id: string; name: string; role: string; isEnabled?: boolean };

const field =
  "w-full rounded-lg border border-line bg-transparent px-3 py-2 text-[14px] text-ink outline-none transition focus:border-ink-3";
const label = "grid gap-1.5 text-[12.5px] text-ink-3";
const picker = "h-[30px] w-auto max-w-[240px] rounded-field border border-line bg-panel px-2.5 text-[12.5px] text-ink-2 outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30";

const SCOPE_HINT: Record<MemoryScope, string> = {
  shared: "Every agent, in every project",
  project: "Every agent working in this project",
  agent: "This role, in every project",
};
const ROLE_PROJECT_HINT = "This role's own notes in this project. Roles write these themselves after their work; other roles never see them";

type SourceFilter = "all" | "agent" | "user";

/** "Remember: Use pnpm…" → first ~140 chars of the content, on one line. */
function snippet(content: string): string {
  const flat = content.replace(/[#>*`_]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}

export default function MemoryPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center bg-panel text-ink-3">
          <span className="text-[13px]">Loading memory…</span>
        </div>
      }
    >
      <MemoryInner />
    </Suspense>
  );
}

/**
 * Memory: notes agents carry between runs. Pinned memories are added to an
 * agent's prompt after its skills — shared, then the project's, then the
 * agent's own. Unpinned memories are recalled when they match a task or
 * message (FharaRuntime full-text search, plan L4).
 */
function MemoryInner() {
  const params = useSearchParams();
  const router = useRouter();
  const rawScope = params.get("scope");
  const scope: MemoryScope = rawScope === "project" || rawScope === "agent" ? rawScope : "shared";
  const projects = useQuery(api.projects.list, {}) as Project[] | undefined;
  const agents = useQuery(api.agents.list, {}) as Agent[] | undefined;
  const projectId = params.get("project") ?? (projects?.[0]?._id ?? "");
  const agentParam = params.get("agent") ?? "";
  // Role memory: the agent scope narrows to one project ("" = every project).
  const roleProjectId = scope === "agent" ? (params.get("rproject") ?? "") : "";
  const rawSource = params.get("source");
  const source: SourceFilter = rawSource === "agent" || rawSource === "user" ? rawSource : "all";

  const sortedAgents = useMemo(
    () =>
      [...(agents ?? [])]
        .filter((a) => a.isEnabled !== false)
        .sort((a, b) => roleLabel(a.role).localeCompare(roleLabel(b.role)) || a.name.localeCompare(b.name)),
    [agents],
  );
  const roleCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of sortedAgents) m.set(a.role, (m.get(a.role) ?? 0) + 1);
    return m;
  }, [sortedAgents]);
  // Agents display by role; a duplicate role gets its name to tell them apart.
  const agentLabel = (a: Agent) => ((roleCount.get(a.role) ?? 0) > 1 ? a.name : roleLabel(a.role));
  const agentId = agentParam || sortedAgents[0]?._id || "";

  const setParam = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    const qs = q.toString();
    router.replace(qs ? `/memory?${qs}` : "/memory");
  };

  const needsTarget = (scope === "project" && !projectId) || (scope === "agent" && !agentId);
  const memories = useQuery(
    api.memories.list,
    needsTarget
      ? "skip"
      : {
          scope,
          ...(scope === "project" ? { projectId: projectId as never } : {}),
          ...(scope === "agent" ? { agentId: agentId as never } : {}),
          ...(scope === "agent" && roleProjectId ? { projectId: roleProjectId as never } : {}),
        },
  ) as Memory[] | undefined;
  const [searchText, setSearchText] = useState("");
  const searchQuery = searchText.trim();
  const hits = useQuery(
    api.memories.search,
    needsTarget || !searchQuery
      ? "skip"
      : {
          scope,
          ...(scope === "project" ? { projectId: projectId as never } : {}),
          ...(scope === "agent" ? { agentId: agentId as never } : {}),
          ...(scope === "agent" && roleProjectId ? { projectId: roleProjectId as never } : {}),
          text: searchQuery,
        },
  ) as Array<{ _id: string }> | undefined;
  const visible = useMemo(() => {
    const bySource = (list: Memory[]) => (source === "all" ? list : list.filter((m) => m.source === source));
    if (!searchQuery) return memories ? bySource(memories) : memories;
    if (!memories || !hits) return undefined;
    const byId = new Map(memories.map((m) => [m._id, m]));
    return bySource(hits.map((h) => byId.get(h._id)).filter((m): m is Memory => Boolean(m)));
  }, [searchQuery, memories, hits, source]);
  const setPinned = useMutation(api.memories.setPinned);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [error, setError] = useState("");

  // A scope change closes an open editor (it belongs to the old list).
  useEffect(() => {
    setEditingId(null);
    setSearchText("");
  }, [scope, projectId, agentId, roleProjectId]);

  const pinnedCount = (memories ?? []).filter((m) => m.pinned).length;
  const loading = !needsTarget && memories === undefined;
  const target = {
    scope,
    projectId: scope === "project" ? projectId : scope === "agent" && roleProjectId ? roleProjectId : undefined,
    agentId: scope === "agent" ? agentId : undefined,
  };
  const hint = scope === "agent" && roleProjectId ? ROLE_PROJECT_HINT : SCOPE_HINT[scope];

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <Sidebar projectId={scope === "project" && projectId ? projectId : roleProjectId || undefined} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-8 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-[1280px]">
          <PageHeader
            eyebrow="Context that carries between runs"
            title="Memory"
            leading={
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-field border border-line bg-panel text-ink-2">
                <Brain size={17} />
              </span>
            }
            meta={<p className="text-[13.5px] text-ink-2">Pinned notes are always in the prompt; the rest are recalled by match.</p>}
            actions={
              <button
                type="button"
                disabled={needsTarget}
                onClick={() => setEditingId("new")}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-field bg-ink px-2.5 text-[12.5px] font-medium text-canvas outline-none transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40"
              >
                <Plus size={14} /> Memory
              </button>
            }
          />

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Segmented
              label="Memory scope"
              value={scope}
              onChange={(next) => setParam({ scope: next === "shared" ? null : next })}
              options={[
                { value: "shared", label: "Shared" },
                { value: "project", label: "Project" },
                { value: "agent", label: "Role" },
              ]}
            />
            {scope === "project" && (
              <select
                aria-label="Project"
                value={projectId}
                onChange={(e) => setParam({ project: e.target.value })}
                className={picker}
              >
                {(projects ?? []).length === 0 && <option value="">No projects</option>}
                {(projects ?? []).map((p) => (
                  <option key={p._id} value={p._id}>{p.name}</option>
                ))}
              </select>
            )}
            {scope === "agent" && (
              <select
                aria-label="Role"
                value={agentId}
                onChange={(e) => setParam({ agent: e.target.value })}
                className={picker}
              >
                {sortedAgents.length === 0 && <option value="">No agents</option>}
                {sortedAgents.map((a) => (
                  <option key={a._id} value={a._id}>{agentLabel(a)}</option>
                ))}
              </select>
            )}
            {scope === "agent" && (
              <select
                aria-label="Role memory project"
                value={roleProjectId}
                onChange={(e) => setParam({ rproject: e.target.value || null })}
                className={picker}
              >
                <option value="">Every project</option>
                {(projects ?? []).map((p) => (
                  <option key={p._id} value={p._id}>{p.name}</option>
                ))}
              </select>
            )}
            <select
              aria-label="Written by"
              value={source}
              onChange={(e) => setParam({ source: e.target.value === "all" ? null : e.target.value })}
              className={picker}
            >
              <option value="all">Written by anyone</option>
              <option value="agent">Written by agents</option>
              <option value="user">Written by you</option>
            </select>
          </div>

          {needsTarget ? null : loading ? (
            <div className="mt-6 space-y-4" aria-label="Loading memory">
              <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-line bg-panel shadow-card sm:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="p-5">
                    <div className="h-3 w-16 rounded bg-hover" />
                    <div className="mt-3 h-8 w-12 rounded bg-hover" />
                  </div>
                ))}
              </div>
              <div className="h-48 rounded-2xl border border-line bg-panel shadow-card" />
            </div>
          ) : (
            <>
              <section
                aria-label="Memory metrics"
                className="mt-6 grid grid-cols-2 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel shadow-card sm:divide-y-0 sm:divide-x lg:grid-cols-4"
              >
                {[
                  { label: "Memories", value: (memories ?? []).length, note: "in scope", icon: <Brain size={13} />, title: "Memories in this scope" },
                  { label: "Pinned", value: pinnedCount, note: "always injected", icon: <Pin size={13} />, title: "Pinned memories added to every prompt" },
                  { label: "By agents", value: (memories ?? []).filter((m) => m.source === "agent").length, note: "from the team", icon: <Users size={13} />, title: "Memories written by agents" },
                  { label: "By you", value: (memories ?? []).filter((m) => m.source === "user").length, note: "written here", icon: <User size={13} />, title: "Memories you wrote" },
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
              <p className="mt-2 text-[12px] text-ink-3">
                {hint} · {MEMORY_PROMPT_BUDGET.toLocaleString("en-US")} char pin budget · {RECALL_TOP_K} recalled at a time
              </p>
            </>
          )}

          {!needsTarget && (
            <div className="relative mt-4 w-full sm:max-w-sm">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-2 text-ink-3" />
              <Input
                type="search"
                aria-label="Search memory"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="Search memory"
                className="h-[30px] bg-panel pl-8 text-[12.5px]"
              />
            </div>
          )}
          {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
          {!needsTarget && <MemorySuggestions scope={scope} projectId={scope === "project" ? projectId : undefined} />}

          {needsTarget ? (
            <div className="mt-6 flex flex-col items-center rounded-2xl border border-dashed border-line bg-panel px-5 py-10 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-inset text-ink-3"><Brain size={18} /></span>
              <p className="mt-4 text-[13px] text-ink-2">
                {scope === "project" ? "No projects yet. Create a project to keep project memory." : "No agents yet."}
              </p>
            </div>
          ) : loading ? null : searchQuery && (visible === undefined || visible.length === 0) && editingId === null ? (
            <p className="mt-4 rounded-2xl border border-line bg-panel px-5 py-10 text-center text-[13px] text-ink-3">
              {visible === undefined ? "Searching…" : `No memories match “${searchQuery}”.`}
            </p>
          ) : (memories ?? []).length === 0 && editingId === null ? (
            <div className="mt-4 flex flex-col items-center rounded-2xl border border-dashed border-line bg-panel px-5 py-10 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-inset text-ink-3"><Brain size={18} /></span>
              <p className="mt-4 text-[14px] text-ink-2">Nothing remembered here yet.</p>
              <p className="mt-1 max-w-md text-[13px] text-ink-3">
                Add conventions, decisions or context you&apos;d otherwise repeat — or use “Remember” in a chat message&apos;s ⋯ menu.
              </p>
              <button type="button" onClick={() => setEditingId("new")} className={`mt-5 ${HEADER_ACTION}`}>
                Write a memory
              </button>
            </div>
          ) : (visible ?? []).length === 0 && editingId === null ? (
            <p className="mt-4 rounded-2xl border border-line bg-panel px-5 py-10 text-center text-[13px] text-ink-3">
              {source === "agent" ? "No memories written by agents here." : "No memories written by you here."}
            </p>
          ) : (
            <>
              {editingId === "new" && (
                <div className="mt-4">
                  <MemoryEditor note={null} target={target} onClose={() => setEditingId(null)} />
                </div>
              )}
              <section className="mt-4 overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
                <div className="hidden items-center gap-3 border-b border-line px-4 py-2.5 text-caption sm:flex">
                  <span className="min-w-0 flex-1">Memory</span>
                  <span className="w-20 shrink-0">Source</span>
                  <span className="w-20 shrink-0 text-right">Updated</span>
                  <span className="w-8 shrink-0" />
                </div>
                <ul className="divide-y divide-line">
                  {(visible ?? []).map((m) => (
                    <li key={m._id} className="transition-colors hover:bg-inset/60">
                      {editingId === m._id ? (
                        <div className="px-3 py-3">
                          <MemoryEditor note={m} target={target} onClose={() => setEditingId(null)} />
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                          <button
                            type="button"
                            onClick={() => setEditingId(m._id)}
                            className="flex min-w-0 flex-1 items-start gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ink/30 max-sm:basis-full"
                          >
                            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-inset text-ink-3">
                              <Brain size={13} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-baseline gap-x-2">
                                <span className="truncate text-[13.5px] font-medium text-ink">{m.title}</span>
                                {m.pinned && <StatusTag tone="active">Pinned</StatusTag>}
                              </span>
                              <span className="mt-0.5 block truncate text-[12px] text-ink-2">{snippet(m.content)}</span>
                              {m.tags && m.tags.length > 0 && (
                                <span className="mt-0.5 block truncate font-mono text-[11.5px] text-ink-3">{m.tags.join(" · ")}</span>
                              )}
                            </span>
                          </button>
                          <div className="ml-9 flex shrink-0 items-center gap-3 max-sm:ml-9">
                            <div className="w-20 shrink-0">
                              <StatusTag tone={m.source === "agent" ? "active" : "neutral"}>
                                {m.source === "agent" ? "Agent" : "You"}
                              </StatusTag>
                            </div>
                            <span className="w-20 shrink-0 text-right text-[12px] tabular-nums text-ink-3">{relativeTime(m.updatedAt)}</span>
                            <button
                              type="button"
                              aria-label={m.pinned ? `Unpin ${m.title}` : `Pin ${m.title}`}
                              aria-pressed={m.pinned}
                              title={m.pinned ? "Pinned — added to prompts" : "Not pinned — added when it matches a task"}
                              onClick={async () => {
                                setError("");
                                try {
                                  await setPinned({ memoryId: m._id as never, pinned: !m.pinned });
                                } catch (err) {
                                  setError(err instanceof Error ? err.message : "Failed to update memory");
                                }
                              }}
                              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-field outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30 ${
                                m.pinned ? "text-ink" : "text-ink-3"
                              }`}
                            >
                              <Pin size={15} className={m.pinned ? "fill-current" : ""} />
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
              <p className="mt-2 text-[12px] text-ink-3">Showing {visible?.length ?? 0} of {memories?.length ?? 0} memories.</p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

/** Inline note editor: title, tags, content, pinned. Saves in place. */
function MemoryEditor({
  note,
  target,
  onClose,
}: {
  note: Memory | null;
  target: { scope: MemoryScope; projectId?: string; agentId?: string };
  onClose: () => void;
}) {
  const create = useMutation(api.memories.create);
  const update = useMutation(api.memories.update);
  const remove = useMutation(api.memories.remove);
  const [title, setTitle] = useState(note?.title ?? "");
  const [content, setContent] = useState(note?.content ?? "");
  const [tags, setTags] = useState((note?.tags ?? []).join(", "));
  const [pinned, setPinnedState] = useState(note?.pinned ?? false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!title.trim() || !content.trim()) {
      setError("Title and content are required");
      return;
    }
    setSaving(true);
    try {
      const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
      if (note) {
        await update({ memoryId: note._id as never, title, content, tags: tagList, pinned });
      } else {
        await create({
          scope: target.scope,
          ...(target.projectId ? { projectId: target.projectId as never } : {}),
          ...(target.agentId ? { agentId: target.agentId as never } : {}),
          title,
          content,
          tags: tagList,
          pinned,
          source: "user",
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save memory");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4 rounded-2xl border border-line bg-panel p-5 shadow-card">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={label}>
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={MEMORY_TITLE_MAX}
            required
            placeholder="Package manager"
            className={field}
          />
        </label>
        <label className={label}>
          Tags
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="tooling, conventions"
            className={field}
          />
        </label>
      </div>
      <label className={label}>
        <span className="flex justify-between">
          Content
          <span>{content.length.toLocaleString("en-US")} / {MEMORY_CONTENT_MAX.toLocaleString("en-US")}</span>
        </span>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={MEMORY_CONTENT_MAX}
          rows={6}
          required
          placeholder="Markdown. e.g. Use pnpm, never npm. Run `pnpm test` before handing off."
          className={`${field} resize-y font-mono text-[13px] leading-relaxed`}
        />
      </label>
      <label className="flex cursor-pointer items-start gap-2 text-[13px] text-ink">
        <input type="checkbox" checked={pinned} onChange={(e) => setPinnedState(e.target.checked)} className="mt-0.5 accent-current" />
        <span>
          Pinned
          <span className="block text-[12px] text-ink-3">Pinned memories are always added to the agent's instructions. Unpinned ones are added only when they match the task or message.</span>
        </span>
      </label>

      {error && <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex items-center justify-between gap-2">
        {note ? (
          <button
            type="button"
            onClick={() => setConfirm({ title: "Delete memory?", message: `"${note.title}" will be removed. Agents won't see it again.` })}
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
            {saving ? "Saving…" : note ? "Save" : "Create"}
          </button>
        </div>
      </div>

      <ConfirmDialog
        request={confirm}
        pending={deleting}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (!note) return;
          setDeleting(true);
          try {
            await remove({ memoryId: note._id as never });
            setConfirm(null);
            onClose();
          } catch (err) {
            setConfirm(null);
            setError(err instanceof Error ? err.message : "Failed to delete memory");
          } finally {
            setDeleting(false);
          }
        }}
      />
    </form>
  );
}
