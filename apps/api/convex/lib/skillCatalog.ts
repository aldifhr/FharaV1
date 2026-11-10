/**
 * Skill marketplace catalog: parsing an "awesome" skills index (README
 * tables or bullet lists) into catalog entries, and matching entries
 * against library skills (installed / update available).
 *
 * Pure module: used by convex/skillCatalog.ts, the web Browse tab, and
 * scripts/build-skill-catalog.ts (which writes skillCatalog.json).
 */

export type CatalogEntry = {
  name: string;
  description: string;
  category: string;
  /** "owner/repo" holding the SKILL.md. */
  repo: string;
  /** Repo-relative SKILL.md path. */
  path: string;
  /** Branch the index points at; undefined → the repo's default branch. */
  ref?: string;
  /** SPDX id (or "Other"); null when unknown. */
  license: string | null;
  author: string | null;
};

/** One index the catalog is built from. */
export type CatalogSource = {
  /** "owner/repo" of the index itself. */
  repo: string;
  /** Index file inside that repo. */
  file: string;
  /** `##` section of the index that lists skills ("Skills"); unset → whole file. */
  section?: string;
  /** Category for entries with no `###` heading inside `section`. */
  category?: string;
  /** SPDX id of the index repo (applies to its metadata); null when unknown. */
  license: string | null;
  /** Shown in the Browse tab and THIRD_PARTY_NOTICES.md. */
  attribution: string;
};

export type BundledCatalog = {
  generatedAt: string;
  /** Each index with the entries parsed from it, in display order. */
  sources: Array<CatalogSource & { sha: string | null; entries: CatalogEntry[] }>;
};

const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** Collapse markdown inline syntax to plain text: links, code, emphasis. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, "$1$2")
    .replace(/\\\|/g, "|")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Where a link in an index points: a relative folder or SKILL.md in the
 * index repo itself, or a github.com /tree/ or /blob/ URL in any repo.
 * Returns null for anything that is not a skill (anchors, other hosts,
 * repo roots, files that are not SKILL.md).
 */
export function resolveSkillLink(
  href: string,
  indexRepo: string
): { repo: string; path: string; ref?: string } | null {
  const link = href.trim().replace(/[?#].*$/, "");
  if (!link) return null;
  const toSkillPath = (raw: string): string | null => {
    const segs = raw.split("/").filter(Boolean).map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
    if (segs.length === 0 || segs.some((s) => s === "." || s === "..")) return null;
    if (segs[segs.length - 1] === "SKILL.md") return segs.join("/");
    if (/\.[a-z0-9]+$/i.test(segs[segs.length - 1])) return null; // some other file
    return [...segs, "SKILL.md"].join("/");
  };
  if (/^https?:\/\//i.test(link) || /^(www\.)?github\.com\//i.test(link)) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 5 || (parts[2] !== "tree" && parts[2] !== "blob")) return null;
    const [owner, repo] = parts;
    if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(repo)) return null;
    const path = toSkillPath(parts.slice(4).join("/"));
    return path ? { repo: `${owner}/${repo.replace(/\.git$/i, "")}`, path, ref: parts[3] } : null;
  }
  if (link.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(link)) return null;
  const path = toSkillPath(link.replace(/^\.\//, ""));
  return path ? { repo: indexRepo, path } : null;
}

const LINK = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;

/** Split a markdown table row into cells ("| a | b |" → ["a", "b"]), honouring "\|". */
function tableCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

/**
 * Parse an awesome-style skills index. Entries are table rows
 * (`| [name](link) | description |`) or bullets (`- [name](link): desc` /
 * `- [name](link) - desc`). The category is the nearest `###` heading
 * (else `##`). Only links that resolve to a SKILL.md become entries;
 * a repeated repo+path keeps its first row.
 *
 * `opts.section` limits parsing to one `##` section (e.g. "Skills").
 */
export function parseSkillIndex(
  markdown: string,
  opts: {
    indexRepo: string;
    ref?: string;
    section?: string;
    /** Category when an entry has no `###` heading (default: the `##` heading, else "Other"). */
    category?: string;
    license?: string | null;
    author?: string | null;
  }
): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  let h2 = "";
  let h3 = "";
  let inFence = false;
  const wantSection = opts.section?.trim().toLowerCase();
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      if (heading[1] === "##") {
        h2 = plainText(heading[2]);
        h3 = "";
      } else {
        h3 = plainText(heading[2]);
      }
      continue;
    }
    if (wantSection && h2.toLowerCase() !== wantSection) continue;
    let linkText: string | undefined;
    let href: string | undefined;
    let description = "";
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s:|-]+\|?\s*$/.test(line)) continue; // separator row
      const cells = tableCells(line);
      const m = LINK.exec(cells[0] ?? "");
      if (!m) continue;
      [, linkText, href] = m;
      description = cells.slice(1).find((c) => c.length > 0) ?? "";
    } else {
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (!bullet) continue;
      const m = LINK.exec(bullet[1]);
      if (!m || m.index !== 0) continue;
      [, linkText, href] = m;
      description = bullet[1].slice(m[0].length).replace(/^\s*(?:[:—–-]\s*)/, "");
    }
    const target = resolveSkillLink(href!, opts.indexRepo);
    if (!target) continue;
    const key = catalogKey(target.repo, target.path);
    if (seen.has(key)) continue;
    seen.add(key);
    const sameRepo = target.repo.toLowerCase() === opts.indexRepo.toLowerCase();
    const ref = target.ref ?? (sameRepo ? opts.ref : undefined);
    entries.push({
      name: plainText(linkText!).slice(0, 120),
      description: plainText(description).slice(0, 400),
      category: h3 || opts.category || h2 || "Other",
      repo: target.repo,
      path: target.path,
      ...(ref ? { ref } : {}),
      // The index repo's license covers its own skills only; external
      // repos stay unknown until a refresh or the import preview reads them.
      license: sameRepo ? (opts.license ?? null) : null,
      author: sameRepo ? (opts.author ?? target.repo.split("/")[0]) : target.repo.split("/")[0],
    });
  }
  return entries;
}

/** Stable identity of a catalog entry / imported skill: lowercased repo + exact path. */
export function catalogKey(repo: string, path: string): string {
  return `${repo.toLowerCase()}::${path.replace(/^\/+/, "")}`;
}

/** Subset of a library skill the matcher needs. */
export type SourcedSkill = {
  _id: string;
  source?: { kind: "github"; repo: string; path: string; url?: string; sha?: string } | null;
  /** Fhara built-in key (lib/builtinSkills.ts) on seeded rows. */
  builtin?: string | null;
};

/** Repo the built-in skills are listed under in the Browse catalog. */
export const BUILTIN_CATALOG_REPO = "aldifhr/Fhara";

/** Catalog path of a built-in skill's SKILL.md. */
export function builtinCatalogPath(key: string): string {
  return `skills/builtin/${key}/SKILL.md`;
}

/** repo+path of a GitHub blob URL ("https://github.com/o/r/blob/<ref>/a/SKILL.md"). */
function sourceFromUrl(url: string | undefined): { repo: string; path: string } | null {
  if (!url) return null;
  const m = /^https:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:blob|tree)\/[^/]+\/(.+)$/i.exec(url.replace(/[?#].*$/, ""));
  if (!m) return null;
  try {
    return { repo: `${m[1]}/${m[2]}`, path: m[3].split("/").map(decodeURIComponent).join("/") };
  } catch {
    return null;
  }
}

/**
 * Library skills by catalog key. A skill is matched by its stored
 * source repo+path, and also by the repo+path in its source URL (covers
 * a repo that was renamed or transferred after import).
 */
export function installedIndex<S extends SourcedSkill>(skills: readonly S[]): Map<string, S> {
  const map = new Map<string, S>();
  for (const skill of skills) {
    // A seeded built-in counts as installed for its catalog row.
    if (skill.builtin) {
      const key = catalogKey(BUILTIN_CATALOG_REPO, builtinCatalogPath(skill.builtin));
      if (!map.has(key)) map.set(key, skill);
    }
    const source = skill.source;
    if (!source || source.kind !== "github") continue;
    const keys = [catalogKey(source.repo, source.path)];
    const fromUrl = sourceFromUrl(source.url);
    if (fromUrl) keys.push(catalogKey(fromUrl.repo, fromUrl.path));
    for (const key of keys) if (!map.has(key)) map.set(key, skill);
  }
  return map;
}

export type UpdateCheck = "current" | "update" | "missing" | "error";

export type CatalogStatus =
  | { kind: "install" }
  | { kind: "installed"; skillId: string }
  | { kind: "update"; skillId: string };

/** What the Browse row shows on the right for an entry. */
export function catalogStatus<S extends SourcedSkill>(
  entry: Pick<CatalogEntry, "repo" | "path">,
  installed: Map<string, S>,
  updates: Readonly<Record<string, UpdateCheck | undefined>>
): CatalogStatus {
  const skill = installed.get(catalogKey(entry.repo, entry.path));
  if (!skill) return { kind: "install" };
  return updates[skill._id] === "update" ? { kind: "update", skillId: skill._id } : { kind: "installed", skillId: skill._id };
}

/**
 * The comparison applyGithubImport uses to call a re-import "unchanged":
 * same commit and same stored content. A newer commit alone is not an
 * update for the Browse tab, so `ignoreSha` compares content only.
 */
export function importedContentMatches(
  existing: { sha: string; instructions: string; description: string; permissions?: readonly string[] },
  incoming: { sha: string; instructions: string; description: string; permissions?: readonly string[] },
  opts: { ignoreSha?: boolean } = {}
): boolean {
  const a = existing.permissions ?? [];
  const b = incoming.permissions ?? [];
  return (
    (opts.ignoreSha || existing.sha === incoming.sha) &&
    existing.instructions === incoming.instructions &&
    existing.description === incoming.description &&
    a.length === b.length &&
    a.every((x, i) => x === b[i])
  );
}

/** URL previewGithubImport / importFromGithub take for one catalog entry. */
export function catalogInstallUrl(entry: Pick<CatalogEntry, "repo" | "path" | "ref">): string {
  const encoded = entry.path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${entry.repo}/blob/${encodeURIComponent(entry.ref ?? "HEAD")}/${encoded}`;
}

/** Case-insensitive search over name, description, repo and category; optional exact category. */
export function filterCatalog<E extends CatalogEntry>(entries: readonly E[], query: string, category?: string | null): E[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    if (category && e.category !== category) return false;
    if (terms.length === 0) return true;
    const hay = `${e.name} ${e.description} ${e.repo} ${e.category}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** Categories in first-seen order. */
export function catalogCategories(entries: readonly CatalogEntry[]): string[] {
  return Array.from(new Set(entries.map((e) => e.category)));
}
