"use client";

import { useMemo, useState, type FormEvent } from "react";
import { permissionText } from "./SkillsV2";
import { useAction } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import Modal from "@/components/Modal";

type PreviewSkill = {
  path: string;
  name: string;
  description: string;
  size: number;
  exceedsCap: boolean;
  url: string;
  status: "new" | "imported" | "update";
  requires: string[];
  permissions: string[];
};

type Preview = {
  repo: string;
  ref: string;
  sha: string;
  license: { spdxId: string; url?: string } | null;
  cap: number;
  total: number;
  capped: boolean;
  treeTruncated: boolean;
  skills: PreviewSkill[];
};

const field =
  "w-full rounded-lg border border-line bg-transparent px-3 py-2 text-[14px] text-ink outline-none transition focus:border-ink-3";

const chars = (n: number) => `${n.toLocaleString("en-US")} chars`;

/** Convex wraps thrown errors ("[CONVEX A(skills:…)] Uncaught Error: msg"); keep the message. */
function errorText(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : "";
  const m = /Uncaught Error:\s*([\s\S]*?)(?:\n\s+at |\n\s*Called by|$)/.exec(raw);
  return (m?.[1] ?? raw).trim() || fallback;
}

/**
 * "Import from GitHub": paste a repo, folder or SKILL.md URL, preview every
 * SKILL.md found (name, description, size, trim note), pick, import.
 */
export function ImportFromGithubModal({ onClose }: { onClose: () => void }) {
  const preview = useAction(api.skills.previewGithubImport);
  const importSkills = useAction(api.skills.importFromGithub);
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const selectable = useMemo(() => (result?.skills ?? []).filter((s) => s.status !== "imported"), [result]);
  const allSelected = selectable.length > 0 && selectable.every((s) => selected.has(s.path));

  async function handlePreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!url.trim()) return;
    setError("");
    setDone("");
    setLoading(true);
    try {
      const next = (await preview({ url: url.trim() })) as Preview;
      setResult(next);
      setSelected(new Set(next.skills.filter((s) => s.status !== "imported").map((s) => s.path)));
    } catch (err) {
      setResult(null);
      setError(errorText(err, "Could not read that repository"));
    } finally {
      setLoading(false);
    }
  }

  async function handleImport() {
    if (!result || selected.size === 0) return;
    setError("");
    setImporting(true);
    try {
      const res = await importSkills({ url: url.trim(), paths: [...selected] });
      const parts = [
        res.created.length ? `${res.created.length} imported` : "",
        res.updated.length ? `${res.updated.length} updated` : "",
        res.unchanged.length ? `${res.unchanged.length} already up to date` : "",
        res.skipped.length ? `${res.skipped.length} skipped` : "",
      ].filter(Boolean);
      if (res.skipped.length === 0 && res.warnings.length === 0) {
        onClose();
        return;
      }
      setDone(
        [`${parts.join(" · ")}.`, ...res.skipped.map((s) => `${s.path}: ${s.reason}`), ...res.warnings].join(" ")
      );
    } catch (err) {
      setError(errorText(err, "Import failed"));
    } finally {
      setImporting(false);
    }
  }

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <Modal title="Import from GitHub" onClose={onClose} maxWidth="max-w-xl">
      <form onSubmit={handlePreview} className="mt-5 flex gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">GitHub URL</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className={field}
          />
        </label>
        <button
          type="submit"
          disabled={loading || !url.trim()}
          className="shrink-0 rounded-lg border border-line bg-panel px-3 py-1.5 text-[13px] font-medium text-ink transition hover:bg-hover disabled:opacity-40"
        >
          {loading ? "Reading…" : "Preview"}
        </button>
      </form>
      <p className="mt-2 text-[12px] text-ink-3">A repository, a folder (…/tree/main/skills) or one SKILL.md file.</p>

      {error && <p role="alert" className="mt-4 text-[13px] text-red-600 dark:text-red-400">{error}</p>}

      {result && (
        <div className="mt-5">
          <div className="flex items-baseline justify-between gap-3 text-[12.5px] text-ink-3">
            <p className="min-w-0 truncate">
              {result.repo} · {result.license ? result.license.spdxId : "no license"} · {result.sha.slice(0, 7)}
            </p>
            {selectable.length > 0 && (
              <button
                type="button"
                onClick={() => setSelected(allSelected ? new Set() : new Set(selectable.map((s) => s.path)))}
                className="shrink-0 rounded-md px-1.5 py-0.5 text-ink-2 transition hover:bg-hover"
              >
                {allSelected ? "Select none" : "Select all"}
              </button>
            )}
          </div>
          {!result.license && (
            <p className="mt-1 text-[12px] text-ink-3">No license found: check the repository's terms before using these.</p>
          )}
          <ul className="mt-2 max-h-[45vh] divide-y divide-line overflow-y-auto rounded-xl border border-line">
            {result.skills.map((s) => {
              const disabled = s.status === "imported";
              return (
                <li key={s.path}>
                  <label
                    className={`flex items-start gap-3 px-3 py-2.5 transition ${disabled ? "cursor-default" : "cursor-pointer hover:bg-hover"}`}
                  >
                    <input
                      type="checkbox"
                      checked={!disabled && selected.has(s.path)}
                      disabled={disabled}
                      onChange={() => toggle(s.path)}
                      className="mt-1 accent-current"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className={`truncate text-[14px] font-medium ${disabled ? "text-ink-3" : "text-ink"}`}>{s.name}</span>
                        <span className="shrink-0 text-[12px] tabular-nums text-ink-3">{chars(s.size)}</span>
                      </span>
                      {s.description && <span className="line-clamp-2 block text-[12.5px] text-ink-2">{s.description}</span>}
                      {(s.exceedsCap || s.status !== "new" || s.requires.length > 0 || s.permissions.length > 0) && (
                        <span className="mt-0.5 block text-[12px] text-ink-3">
                          {[
                            s.status === "imported" ? "Already in library" : "",
                            s.status === "update" ? "In library · newer version available" : "",
                            s.exceedsCap ? `Stored whole; trimmed to ${chars(result.cap)} only when inline` : "",
                            s.requires.length ? `requires ${s.requires.join(", ")}` : "",
                            s.permissions.length ? `needs ${permissionText(s.permissions)}` : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {(result.capped || result.treeTruncated) && (
            <p className="mt-2 text-[12px] text-ink-3">
              Showing the first {result.skills.length} of {result.total}
              {result.treeTruncated ? " (repository too large to list fully)" : ""}. Use a folder URL to narrow it.
            </p>
          )}
          {done && <p className="mt-3 text-[13px] text-ink-2">{done}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover">
              {done ? "Close" : "Cancel"}
            </button>
            <button
              type="button"
              onClick={handleImport}
              disabled={importing || selected.size === 0}
              className="rounded-lg bg-ink px-3.5 py-1.5 text-[13px] font-medium text-canvas transition hover:opacity-90 disabled:opacity-40"
            >
              {importing ? "Importing…" : `Import${selected.size ? ` ${selected.size}` : ""}`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
