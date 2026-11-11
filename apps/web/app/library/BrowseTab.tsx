"use client";

/**
 * Library → Browse: the skill marketplace. Lists the catalog
 * (api.skillCatalog.get: bundled index, or a refreshed copy), marks what
 * is already in the library, checks installed ones for upstream changes,
 * and installs through the existing GitHub import preview.
 * Theme tokens only, divide-y list, no pills.
 */
import { useEffect, useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { RefreshCw } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import Modal from "@/components/Modal";
import { useToast } from "@/components/Toasts";
import {
  catalogCategories,
  catalogInstallUrl,
  catalogKey,
  catalogStatus,
  filterCatalog,
  installedIndex,
  type CatalogEntry,
  type CatalogStatus,
  type UpdateCheck,
} from "@/api/convex/lib/skillCatalog";
import { ImportFromGithubModal } from "./ImportFromGithub";
import { errorText, type LibrarySkill } from "./SkillsV2";

type Entry = CatalogEntry & { source: string };

const field =
  "rounded-lg border border-line bg-transparent px-3 py-2 text-[14px] text-ink outline-none transition focus:border-ink-3";
const secondaryButton =
  "inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 text-[13px] font-medium text-ink outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40";

const UNKNOWN_LICENSE =
  "License unknown: this skill's source does not state a license. Check the repository's terms before you rely on it.";

function licenseText(entry: Entry): string {
  return entry.license ?? "license unknown";
}

function dateText(value: number | string): string {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function BrowseTab({ tabs, skills }: { tabs: React.ReactNode; skills: LibrarySkill[] | undefined }) {
  const catalog = useQuery(api.skillCatalog.get, {});
  const refreshCatalog = useAction(api.skillCatalog.refresh);
  const checkUpdates = useAction(api.skillCatalog.checkUpdates);
  const updateFromSource = useAction(api.skills.updateFromSource);
  const toast = useToast();

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [detail, setDetail] = useState<Entry | null>(null);
  const [installing, setInstalling] = useState<Entry | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [updates, setUpdates] = useState<Record<string, UpdateCheck>>({});
  const [checking, setChecking] = useState(false);

  const entries = useMemo(() => catalog?.entries ?? [], [catalog]);
  const categories = useMemo(() => catalogCategories(entries), [entries]);
  const visible = useMemo(() => filterCatalog(entries, query, category || null), [entries, query, category]);
  const installed = useMemo(() => installedIndex(skills ?? []), [skills]);

  // Library skills that come from a catalog entry, for the update check.
  const installedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of entries) {
      const skill = installed.get(catalogKey(e.repo, e.path));
      if (skill) ids.add(skill._id);
    }
    return [...ids].sort();
  }, [entries, installed]);
  const unchecked = useMemo(() => installedIds.filter((id) => !(id in updates)), [installedIds, updates]);
  const uncheckedKey = unchecked.join(",");

  useEffect(() => {
    if (!uncheckedKey) return;
    let cancelled = false;
    setChecking(true);
    checkUpdates({ skillIds: uncheckedKey.split(",") as never })
      .then((res) => {
        if (!cancelled) setUpdates((prev) => ({ ...prev, ...res }));
      })
      .catch(() => {
        if (!cancelled) {
          // Mark them checked so a failing GitHub call does not loop.
          setUpdates((prev) => ({ ...prev, ...Object.fromEntries(uncheckedKey.split(",").map((id) => [id, "error" as const])) }));
        }
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [uncheckedKey, checkUpdates]);

  const installedCount = installedIds.length;
  const updateCount = installedIds.filter((id) => updates[id] === "update").length;

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const res = await refreshCatalog({});
      const total = res.refreshed.reduce((n, r) => n + r.entries, 0);
      if (res.refreshed.length) toast("success", "Catalog refreshed", `${total} skills from ${res.refreshed.map((r) => r.repo).join(", ")}`);
      for (const f of res.failed) toast("error", `Could not refresh ${f.repo}`, f.error);
      // Re-check installed skills against the new upstream state.
      setUpdates({});
    } catch (err) {
      toast("error", "Refresh failed", errorText(err, "Could not read the catalog"));
    } finally {
      setRefreshing(false);
    }
  }

  async function handleUpdate(entry: Entry, skillId: string) {
    setUpdating(skillId);
    try {
      const res = await updateFromSource({ skillId: skillId as never });
      setUpdates((prev) => ({ ...prev, [skillId]: "current" }));
      toast(
        res.status === "updated" ? "success" : "info",
        res.status === "updated" ? "Skill updated" : "Already up to date",
        `${entry.name} · ${res.sha.slice(0, 7)}`
      );
    } catch (err) {
      toast("error", "Update failed", errorText(err, "Could not read the source"));
    } finally {
      setUpdating(null);
    }
  }

  const statusFor = (entry: Entry): CatalogStatus => catalogStatus(entry, installed, updates);

  const action = (entry: Entry) => {
    const status = statusFor(entry);
    if (status.kind === "install") {
      return (
        <button
          type="button"
          disabled={skills === undefined}
          onClick={() => {
            setDetail(null);
            setInstalling(entry);
          }}
          className={secondaryButton}
        >
          Install
        </button>
      );
    }
    if (status.kind === "update") {
      return (
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-[12px] text-ink-2">Update available</span>
          <button
            type="button"
            disabled={updating !== null}
            onClick={() => handleUpdate(entry, status.skillId)}
            className={secondaryButton}
          >
            {updating === status.skillId ? "Updating…" : "Update"}
          </button>
        </span>
      );
    }
    return <span className="shrink-0 px-1 text-[12px] text-ink-3">Installed</span>;
  };

  const summary =
    catalog === undefined
      ? "Loading…"
      : [
          `${entries.length} ${entries.length === 1 ? "skill" : "skills"}`,
          installedCount ? `${installedCount} installed` : "",
          checking ? "checking for updates…" : updateCount ? `${updateCount} ${updateCount === 1 ? "update" : "updates"} available` : "",
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <>
      <header className="flex items-end justify-between gap-4">
        <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Library</h1>
        <button type="button" disabled={refreshing} onClick={handleRefresh} className={secondaryButton}>
          <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
          {refreshing ? "Refreshing…" : "Refresh catalog"}
        </button>
      </header>
      <div className="mt-5">{tabs}</div>
      <p className="mt-6 text-[15px] text-ink-2">{summary}</p>

      <div className="mt-6 flex gap-2 max-[560px]:flex-col">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Search skills</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills"
            autoComplete="off"
            spellCheck={false}
            className={`${field} w-full`}
          />
        </label>
        <label className="shrink-0">
          <span className="sr-only">Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={`${field} w-full bg-panel pr-8`}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>

      {catalog === undefined ? (
        <p className="mt-8 text-[13px] text-ink-3" aria-label="Loading catalog">
          Loading…
        </p>
      ) : visible.length === 0 ? (
        <p className="mt-8 text-[13px] text-ink-3">No skills match.</p>
      ) : (
        <ul className="mt-6 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
          {visible.map((entry) => (
            <li key={catalogKey(entry.repo, entry.path)} className="flex items-center gap-3 pr-3 transition hover:bg-hover">
              <button
                type="button"
                onClick={() => setDetail(entry)}
                className="min-w-0 flex-1 px-4 py-3 text-left outline-none focus-visible:bg-hover"
              >
                <p className="truncate text-[14px] font-medium text-ink">{entry.name}</p>
                {entry.description && <p className="truncate text-[12.5px] text-ink-2">{entry.description}</p>}
                <p className="truncate text-[12px] text-ink-3">
                  {entry.repo} · {licenseText(entry)}
                </p>
              </button>
              {action(entry)}
            </li>
          ))}
        </ul>
      )}

      {catalog && (
        <p className="mt-6 text-[12px] text-ink-3">
          Catalog from{" "}
          {catalog.sources.map((s, i) => (
            <span key={s.repo}>
              {i > 0 ? "; " : ""}
              <a href={`https://github.com/${s.repo}`} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-ink hover:underline">
                {s.attribution}
              </a>
              {s.origin === "refreshed" && s.fetchedAt ? `, refreshed ${dateText(s.fetchedAt)}` : `, bundled ${dateText(catalog.bundledAt)}`}
            </span>
          ))}
          . Each skill keeps its own repository&apos;s license.
        </p>
      )}

      {detail && (
        <SkillDetailModal
          entry={detail}
          status={statusFor(detail)}
          action={action(detail)}
          onClose={() => setDetail(null)}
        />
      )}
      {installing && (
        <ImportFromGithubModal
          key={catalogKey(installing.repo, installing.path)}
          title={`Install ${installing.name}`}
          initialUrl={catalogInstallUrl(installing)}
          notice={installing.license ? undefined : UNKNOWN_LICENSE}
          onImported={(created, updated) => {
            if (created || updated) toast("success", "Installed", installing.name);
          }}
          onClose={() => setInstalling(null)}
        />
      )}
    </>
  );
}

/** Row detail: metadata, license note, the row's action, and the SKILL.md as published. */
function SkillDetailModal({
  entry,
  status,
  action,
  onClose,
}: {
  entry: Entry;
  status: CatalogStatus;
  action: React.ReactNode;
  onClose: () => void;
}) {
  const readSkillFile = useAction(api.skillCatalog.readSkillFile);
  const [file, setFile] = useState<{ text: string; truncated: boolean; url: string } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setError("");
    readSkillFile({ repo: entry.repo, path: entry.path, ...(entry.ref ? { ref: entry.ref } : {}) })
      .then((res) => {
        if (!cancelled) setFile(res);
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err, "Could not read the SKILL.md"));
      });
    return () => {
      cancelled = true;
    };
  }, [entry.repo, entry.path, entry.ref, readSkillFile]);

  const githubUrl = file?.url ?? `https://github.com/${entry.repo}/blob/${entry.ref ?? "HEAD"}/${entry.path}`;

  return (
    <Modal title={entry.name} onClose={onClose} maxWidth="max-w-2xl">
      <div className="mt-4 grid gap-1">
        {entry.description && <p className="text-[14px] text-ink-2">{entry.description}</p>}
        <p className="text-[12.5px] text-ink-3">
          {[entry.category, entry.author ? `by ${entry.author}` : "", licenseText(entry)].filter(Boolean).join(" · ")}
        </p>
        <a
          href={githubUrl}
          target="_blank"
          rel="noreferrer"
          className="w-fit max-w-full truncate text-[12.5px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
        >
          {entry.repo}/{entry.path}
        </a>
        {!entry.license && <p className="mt-2 text-[12.5px] text-ink-2">{UNKNOWN_LICENSE}</p>}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-[12.5px] text-ink-3">
          {status.kind === "install"
            ? "Install shows the import preview first."
            : status.kind === "update"
              ? "The source changed since it was installed."
              : "In your library."}
        </p>
        {action}
      </div>

      <div className="mt-4">
        {error ? (
          <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : file === null ? (
          <p className="text-[13px] text-ink-3">Loading SKILL.md…</p>
        ) : (
          <>
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-canvas p-3 font-mono text-[12.5px] leading-relaxed text-ink-2">
              {file.text}
            </pre>
            {file.truncated && <p className="mt-2 text-[12px] text-ink-3">Preview cut short. The full file is on GitHub.</p>}
          </>
        )}
      </div>
    </Modal>
  );
}
