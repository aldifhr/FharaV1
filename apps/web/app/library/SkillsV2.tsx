"use client";

/**
 * Skill v2 views for /library: version history (diff + restore) and the
 * Sources (marketplace) tab. Theme tokens only, divide-y lists, no pills.
 */
import { useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { RefreshCw } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import Modal from "@/components/Modal";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toasts";
import { roleLabel } from "@/lib/agentRoles";
import { SKILL_PERMISSION_LABELS, type SkillPermission } from "@/api/convex/lib/skillGraph";

export type LibrarySkill = {
  _id: string;
  name: string;
  description: string;
  instructions: string;
  tags?: string[];
  source?: {
    kind: "github";
    repo: string;
    path: string;
    sha: string;
    license?: string;
    licenseUrl?: string;
    url: string;
  };
  trimmed?: boolean;
  version?: number;
  versionCount: number;
  size: number;
  inlineTrimmed: boolean;
  requires?: string[];
  requiresNames: string[];
  requiredBy: Array<{ _id: string; name: string }>;
  permissions?: string[];
  usedBy: Array<{
    _id: string;
    name: string;
    role: string;
    isEnabled?: boolean;
    skillLoading: "inline" | "on_demand";
    pinnedVersion?: number;
    missingPermissions: string[];
  }>;
};

/** Convex wraps thrown errors ("… Uncaught Error: msg"); keep the message. */
export function errorText(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : "";
  const m = /Uncaught Error:\s*([\s\S]*?)(?:\n\s+at |\n\s*Called by|$)/.exec(raw);
  return (m?.[1] ?? raw).trim() || fallback;
}

export function sizeText(chars: number): string {
  return chars >= 1000 ? `${(chars / 1000).toFixed(chars >= 10_000 ? 0 : 1)}k chars` : `${chars} chars`;
}

export function permissionText(perms: readonly string[] | undefined): string {
  return (perms ?? []).map((p) => SKILL_PERMISSION_LABELS[p as SkillPermission] ?? p).join(", ");
}

/** "v3 · 14k chars · requires A, B · needs run commands" */
export function skillMetaText(skill: LibrarySkill): string {
  return [
    skill.version ? `v${skill.version}` : null,
    sizeText(skill.size),
    skill.requiresNames.length ? `requires ${skill.requiresNames.join(", ")}` : null,
    skill.permissions?.length ? `needs ${permissionText(skill.permissions)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "Designer (pinned v2), Frontend" — agents by role only. */
export function usedByText(usedBy: LibrarySkill["usedBy"]): string {
  const seen = new Map<string, string>();
  for (const a of usedBy) {
    const label = `${roleLabel(a.role)}${a.pinnedVersion ? ` (pinned v${a.pinnedVersion})` : ""}`;
    if (!seen.has(label)) seen.set(label, label);
  }
  return [...seen.values()].join(", ");
}

function when(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const KIND_LABEL: Record<string, string> = {
  baseline: "Before history",
  create: "Created",
  edit: "Edited",
  import: "Imported",
  rollback: "Restored",
};

/** History: versions newest first; pick one to diff against current (or another); restore. */
export function SkillHistoryModal({ skill, onClose }: { skill: LibrarySkill; onClose: () => void }) {
  const versions = useQuery(api.skills.versions, { skillId: skill._id as never });
  const rollback = useMutation(api.skills.rollback);
  const toast = useToast();
  const latest = versions?.[0]?.version;
  const [selected, setSelected] = useState<number | null>(null);
  const [compareTo, setCompareTo] = useState<number | "current">("current");
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [restoring, setRestoring] = useState(false);
  const from = selected ?? (versions && versions.length > 1 ? versions[1].version : null);
  const diff = useQuery(
    api.skills.diff,
    from !== null ? { skillId: skill._id as never, from, ...(compareTo === "current" ? {} : { to: compareTo }) } : "skip"
  );

  return (
    <Modal title={`History · ${skill.name}`} onClose={onClose} maxWidth="max-w-2xl">
      {versions === undefined ? (
        <p className="mt-5 text-[13px] text-ink-3">Loading…</p>
      ) : versions.length === 0 ? (
        <p className="mt-5 text-[13px] text-ink-3">No versions yet. The first edit saves this content as version 1.</p>
      ) : (
        <div className="mt-5 grid gap-5">
          <ul className="max-h-60 divide-y divide-line overflow-y-auto rounded-xl border border-line">
            {versions.map((row) => {
              const active = row.version === from;
              return (
                <li key={row._id}>
                  <button
                    type="button"
                    onClick={() => setSelected(row.version)}
                    aria-pressed={active}
                    className={`flex w-full items-start gap-3 px-3 py-2.5 text-left outline-none transition hover:bg-hover focus-visible:bg-hover ${active ? "bg-hover" : ""}`}
                  >
                    <span className="w-9 shrink-0 text-[13px] font-medium text-ink">v{row.version}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">
                        {KIND_LABEL[row.kind] ?? row.kind}
                        {row.note ? ` · ${row.note}` : ""}
                        {row.version === latest ? " · current" : ""}
                      </span>
                      <span className="block truncate text-[12px] text-ink-3">
                        {row.author} · {when(row.createdAt)} · {sizeText(row.size)}
                        {row.sourceSha ? ` · ${row.sourceSha.slice(0, 7)}` : ""}
                        {row.pinnedBy.length ? ` · pinned by ${row.pinnedBy.map((a) => roleLabel(a.role)).join(", ")}` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {from !== null && (
            <section className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-ink-3">
                <span>
                  v{from} →{" "}
                  <select
                    aria-label="Compare with"
                    value={String(compareTo)}
                    onChange={(e) => setCompareTo(e.target.value === "current" ? "current" : Number(e.target.value))}
                    className="rounded-md border border-line bg-canvas px-1.5 py-0.5 text-[12.5px] text-ink outline-none focus:border-ink-3"
                  >
                    <option value="current">current</option>
                    {versions
                      .filter((r) => r.version !== from)
                      .map((r) => (
                        <option key={r.version} value={r.version}>
                          v{r.version}
                        </option>
                      ))}
                  </select>
                  {diff ? ` · +${diff.stats.added} −${diff.stats.removed}` : ""}
                  {diff?.fields.length ? ` · also ${diff.fields.join(", ")}` : ""}
                </span>
                {from !== latest && (
                  <button
                    type="button"
                    onClick={() =>
                      setConfirm({
                        title: `Restore v${from}?`,
                        message: `"${skill.name}" gets v${from}'s content as a new version. Agents pinned to another version keep theirs.`,
                        confirmLabel: "Restore",
                        icon: "restore",
                        tone: "neutral",
                      })
                    }
                    className="rounded-lg border border-line px-2.5 py-1 text-[12.5px] text-ink transition hover:bg-hover"
                  >
                    Restore v{from}
                  </button>
                )}
              </div>
              <pre className="max-h-72 overflow-auto rounded-lg border border-line font-mono text-[12px] leading-relaxed">
                {diff === undefined ? (
                  <span className="block px-3 py-2 text-ink-3">Loading…</span>
                ) : diff.lines.every((l) => l.op === "same") ? (
                  <span className="block px-3 py-2 text-ink-3">Instructions are identical.</span>
                ) : (
                  diff.lines.map((line, i) => (
                    <span
                      key={i}
                      className={`block whitespace-pre-wrap px-3 ${
                        line.op === "add" ? "font-medium text-ink" : line.op === "del" ? "text-destructive line-through" : "text-ink-3"
                      }`}
                    >
                      {line.op === "add" ? "+ " : line.op === "del" ? "− " : "  "}
                      {line.text}
                    </span>
                  ))
                )}
              </pre>
            </section>
          )}
        </div>
      )}
      <ConfirmDialog
        request={confirm}
        pending={restoring}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (from === null) return;
          setRestoring(true);
          try {
            const res = await rollback({ skillId: skill._id as never, version: from });
            toast("success", "Version restored", `${skill.name} is now v${res.version}`);
            setSelected(null);
            setCompareTo("current");
          } catch (err) {
            toast("error", "Restore failed", errorText(err, "Could not restore"));
          } finally {
            setRestoring(false);
            setConfirm(null);
          }
        }}
      />
    </Modal>
  );
}

/**
 * Sources: skills grouped by the repo they were imported from (then the
 * ones written here), each with version, size, dependencies, permissions
 * and who uses it, plus "Update all from source" per repo.
 */
export function SourcesTab({
  tabs,
  skills,
  onOpen,
  onHistory,
}: {
  tabs: React.ReactNode;
  skills: LibrarySkill[] | undefined;
  onOpen: (skill: LibrarySkill) => void;
  onHistory: (skill: LibrarySkill) => void;
}) {
  const updateAll = useAction(api.skills.updateAllFromSource);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const groups = useMemo(() => {
    const byRepo = new Map<string, LibrarySkill[]>();
    const local: LibrarySkill[] = [];
    for (const skill of skills ?? []) {
      if (!skill.source) {
        local.push(skill);
        continue;
      }
      const list = byRepo.get(skill.source.repo) ?? [];
      list.push(skill);
      byRepo.set(skill.source.repo, list);
    }
    return {
      repos: [...byRepo.entries()].sort(([a], [b]) => a.localeCompare(b)),
      local,
    };
  }, [skills]);

  async function handleUpdateAll(repo: string) {
    setBusy(repo);
    try {
      const res = await updateAll({ repo });
      const parts = [
        res.updated.length ? `${res.updated.length} updated` : "",
        res.unchanged.length ? `${res.unchanged.length} unchanged` : "",
        res.missing.length ? `${res.missing.length} no longer in the repo` : "",
      ].filter(Boolean);
      toast(res.updated.length ? "success" : "info", res.updated.length ? "Skills updated" : "Already up to date", `${repo} · ${res.sha.slice(0, 7)} · ${parts.join(", ")}`);
      for (const w of res.warnings.slice(0, 3)) toast("info", "Check dependencies", w);
    } catch (err) {
      toast("error", "Update failed", errorText(err, "Could not read the source"));
    } finally {
      setBusy(null);
    }
  }

  const list = (rows: LibrarySkill[]) => (
    <ul className="divide-y divide-line">
      {rows.map((s) => (
        <li key={s._id} className="flex items-start gap-3 px-4 py-2.5 transition hover:bg-hover">
          <button type="button" onClick={() => onOpen(s)} className="min-w-0 flex-1 text-left outline-none focus-visible:underline">
            <p className="truncate text-[14px] font-medium text-ink">{s.name}</p>
            <p className="truncate text-[12px] text-ink-3">
              {skillMetaText(s)}
              {s.inlineTrimmed ? " · trimmed when inline" : ""}
            </p>
            {s.usedBy.some((a) => a.missingPermissions.length) && (
              <p className="truncate text-[12px] text-ink-2">
                {s.usedBy
                  .filter((a) => a.missingPermissions.length)
                  .map((a) => `${roleLabel(a.role)} lacks ${permissionText(a.missingPermissions)}`)
                  .join(" · ")}
              </p>
            )}
          </button>
          <span className="max-w-[35%] shrink-0 truncate pt-0.5 text-[12px] text-ink-3">{s.usedBy.length ? usedByText(s.usedBy) : "Not used"}</span>
          <button
            type="button"
            onClick={() => onHistory(s)}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-ink-3 outline-none transition hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30"
          >
            History
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <header className="flex items-end justify-between gap-4">
        <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Library</h1>
      </header>
      <div className="mt-5">{tabs}</div>
      <p className="mt-6 text-[15px] text-ink-2">
        {skills === undefined
          ? "Loading…"
          : `${groups.repos.length} ${groups.repos.length === 1 ? "source" : "sources"} · ${skills.length} ${skills.length === 1 ? "skill" : "skills"}`}
      </p>
      {skills !== undefined && skills.length === 0 && (
        <p className="mt-10 text-[13px] text-ink-3">No skills yet. Import a repository from the Skills tab.</p>
      )}
      <div className="mt-10 grid gap-8">
        {groups.repos.map(([repo, rows]) => {
          const first = rows[0].source!;
          const shas = new Set(rows.map((r) => r.source!.sha));
          return (
            <section key={repo} aria-label={repo}>
              <div className="mb-2 flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <a
                    href={`https://github.com/${repo}`}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate text-[14px] font-medium text-ink underline-offset-2 hover:underline"
                  >
                    {repo}
                  </a>
                  <p className="truncate text-[12px] text-ink-3">
                    {first.license ?? "no license"} · {rows.length} {rows.length === 1 ? "skill" : "skills"} ·{" "}
                    {shas.size === 1 ? `at ${first.sha.slice(0, 7)}` : `${shas.size} commits`}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => handleUpdateAll(repo)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 text-[13px] font-medium text-ink outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40"
                >
                  <RefreshCw size={13} className={busy === repo ? "animate-spin" : ""} />
                  {busy === repo ? "Updating…" : "Update all from source"}
                </button>
              </div>
              <div className="overflow-hidden rounded-xl border border-line bg-panel">{list(rows)}</div>
            </section>
          );
        })}
        {groups.local.length > 0 && (
          <section aria-label="Written here">
            <div className="mb-2">
              <p className="text-[14px] font-medium text-ink">Written here</p>
              <p className="text-[12px] text-ink-3">{groups.local.length} {groups.local.length === 1 ? "skill" : "skills"}</p>
            </div>
            <div className="overflow-hidden rounded-xl border border-line bg-panel">{list(groups.local)}</div>
          </section>
        )}
      </div>
    </>
  );
}
