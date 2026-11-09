"use client";

import { Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { Pin, Plus } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import IconRail from "@/components/IconRail";
import Modal from "@/components/Modal";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import Segmented from "@/components/ui/segmented";
import { roleLabel } from "@/lib/agentRoles";
import { relativeTime } from "@/lib/runFormat";
import { MEMORY_CONTENT_MAX, MEMORY_PROMPT_BUDGET, MEMORY_TITLE_MAX, type MemoryScope } from "@/api/convex/lib/memory";

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
const picker = `${field} h-9 w-auto max-w-[240px] bg-canvas py-1 text-[13px]`;

const SCOPE_HINT: Record<MemoryScope, string> = {
  shared: "Every agent, in every project",
  project: "Every agent working in this project",
  agent: "This agent, in every project",
};

/** "Remember: Use pnpm…" → first ~140 chars of the content, on one line. */
function snippet(content: string): string {
  const flat = content.replace(/[#>*`_]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}

export default function MemoryPage() {
  return (
    <Suspense fallback={null}>
      <MemoryInner />
    </Suspense>
  );
}

/**
 * Memory: notes agents carry between runs. Pinned memories are added to an
 * agent's prompt after its skills — shared, then the project's, then the
 * agent's own. Unpinned memories are kept for reference only.
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
        },
  ) as Memory[] | undefined;
  const setPinned = useMutation(api.memories.setPinned);
  const [editing, setEditing] = useState<Memory | "new" | null>(null);
  const [error, setError] = useState("");

  // A scope change closes an open editor (it belongs to the old list).
  useEffect(() => setEditing(null), [scope, projectId, agentId]);

  const pinnedCount = (memories ?? []).filter((m) => m.pinned).length;
  const current = editing && editing !== "new" ? (memories ?? []).find((m) => m._id === editing._id) ?? editing : editing;
  const loading = !needsTarget && memories === undefined;

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail projectId={scope === "project" && projectId ? projectId : undefined} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-3xl">
          <header className="flex items-end justify-between gap-4">
            <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Memory</h1>
            <button
              type="button"
              disabled={needsTarget}
              onClick={() => setEditing("new")}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 text-[13px] font-medium text-ink outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-40"
            >
              <Plus size={14} /> Memory
            </button>
          </header>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Segmented
              label="Memory scope"
              value={scope}
              onChange={(next) => setParam({ scope: next === "shared" ? null : next })}
              options={[
                { value: "shared", label: "Shared" },
                { value: "project", label: "Project" },
                { value: "agent", label: "Agent" },
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
                aria-label="Agent"
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
          </div>

          <p className="mt-6 text-[15px] text-ink-2">
            {loading
              ? "Loading…"
              : `${SCOPE_HINT[scope]} · ${pinnedCount} pinned`}
          </p>
          <p className="mt-1 text-[12.5px] text-ink-3">
            Only pinned memories are added to an agent's instructions (shared, then project, then the agent's own, up to{" "}
            {MEMORY_PROMPT_BUDGET.toLocaleString("en-US")} characters). Unpinned ones are kept for reference.
          </p>
          {error && <p role="alert" className="mt-3 text-[13px] text-red-600 dark:text-red-400">{error}</p>}

          {needsTarget ? (
            <div className="mt-10 rounded-xl border border-dashed border-line px-4 py-5 text-[13px] text-ink-3">
              {scope === "project" ? "No projects yet. Create a project to keep project memory." : "No agents yet."}
            </div>
          ) : loading ? (
            <div className="mt-10 space-y-3" aria-label="Loading memory">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-xl bg-hover" />
              ))}
            </div>
          ) : (memories ?? []).length === 0 ? (
            <div className="mt-10 rounded-xl border border-dashed border-line px-4 py-5 text-[13px] text-ink-3">
              <p>
                Nothing remembered here yet. Add conventions, decisions or context you'd otherwise repeat — or use
                “Remember” in a chat message's ⋯ menu.
              </p>
              <button
                type="button"
                onClick={() => setEditing("new")}
                className="mt-3 rounded-lg border border-line bg-panel px-3 py-1.5 text-[13px] text-ink transition hover:bg-hover"
              >
                Write a memory
              </button>
            </div>
          ) : (
            <ul className="mt-10 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
              {(memories ?? []).map((m) => (
                <li key={m._id} className="flex items-start gap-1 pr-2 transition hover:bg-hover">
                  <button
                    type="button"
                    onClick={() => setEditing(m)}
                    className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-left outline-none focus-visible:bg-hover"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium">{m.title}</p>
                      <p className="truncate text-[12.5px] text-ink-2">{snippet(m.content)}</p>
                    </div>
                    <span className="shrink-0 pt-0.5 text-right text-[12px] text-ink-3">
                      {m.source === "agent" ? "Agent" : "You"} · {relativeTime(m.updatedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={m.pinned ? `Unpin ${m.title}` : `Pin ${m.title}`}
                    aria-pressed={m.pinned}
                    title={m.pinned ? "Pinned — added to prompts" : "Not pinned — reference only"}
                    onClick={async () => {
                      setError("");
                      try {
                        await setPinned({ memoryId: m._id as never, pinned: !m.pinned });
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Failed to update memory");
                      }
                    }}
                    className={`mt-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg outline-none transition hover:bg-panel focus-visible:ring-2 focus-visible:ring-brand/40 ${
                      m.pinned ? "text-ink" : "text-ink-3"
                    }`}
                  >
                    <Pin size={15} className={m.pinned ? "fill-current" : ""} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>

      {current && (
        <MemoryModal
          key={current === "new" ? "new" : current._id}
          memory={current === "new" ? null : current}
          target={{
            scope,
            projectId: scope === "project" ? projectId : undefined,
            agentId: scope === "agent" ? agentId : undefined,
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function MemoryModal({
  memory,
  target,
  onClose,
}: {
  memory: Memory | null;
  target: { scope: MemoryScope; projectId?: string; agentId?: string };
  onClose: () => void;
}) {
  const create = useMutation(api.memories.create);
  const update = useMutation(api.memories.update);
  const remove = useMutation(api.memories.remove);
  const [title, setTitle] = useState(memory?.title ?? "");
  const [content, setContent] = useState(memory?.content ?? "");
  const [tags, setTags] = useState((memory?.tags ?? []).join(", "));
  const [pinned, setPinnedState] = useState(memory?.pinned ?? true);
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
      if (memory) {
        await update({ memoryId: memory._id as never, title, content, tags: tagList, pinned });
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
    <Modal title={memory ? "Edit memory" : "New memory"} onClose={onClose} maxWidth="max-w-xl">
      <form onSubmit={handleSubmit} className="mt-5 grid gap-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={label}>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={MEMORY_TITLE_MAX} required placeholder="Package manager" className={field} />
          </label>
          <label className={label}>
            Tags
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tooling, conventions" className={field} />
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
            rows={10}
            required
            placeholder="Markdown. e.g. Use pnpm, never npm. Run `pnpm test` before handing off."
            className={`${field} resize-y font-mono text-[13px] leading-relaxed`}
          />
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinnedState(e.target.checked)} className="mt-0.5 accent-current" />
          <span>
            Pinned
            <span className="block text-[12px] text-ink-3">Pinned memories are added to the agent's instructions. Unpinned ones are reference only.</span>
          </span>
        </label>

        {error && <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex items-center justify-between gap-2">
          {memory ? (
            <button
              type="button"
              onClick={() => setConfirm({ title: "Delete memory?", message: `"${memory.title}" will be removed. Agents won't see it again.` })}
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
              {saving ? "Saving…" : memory ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </form>
      <ConfirmDialog
        request={confirm}
        pending={deleting}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (!memory) return;
          setDeleting(true);
          try {
            await remove({ memoryId: memory._id as never });
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
    </Modal>
  );
}
