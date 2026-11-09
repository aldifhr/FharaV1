/**
 * "Import from GitHub" for the skills library: pure helpers (no Convex,
 * no network). The Convex actions in skills.ts do the fetching and call
 * these to parse URLs, read SKILL.md front matter, pick SKILL.md files out
 * of a git tree and fit oversized skills under the import cap.
 */

import { SKILL_DESCRIPTION_MAX, SKILL_NAME_MAX, SKILLS_PROMPT_BUDGET } from "./skills";

/** Most SKILL.md files one preview scans (and one import accepts). */
export const GITHUB_SKILL_SCAN_MAX = 100;

/**
 * Largest instructions body an import stores. A skill is injected as
 * `## Skill: <name>\n<instructions>` inside SKILLS_PROMPT_BUDGET (12k), so
 * the cap leaves room for the header of the longest allowed name: a skill
 * at the cap still reaches the prompt whole when it is the only one.
 */
export const SKILL_IMPORT_MAX = SKILLS_PROMPT_BUDGET - (SKILL_NAME_MAX + "## Skill: \n".length);

/**
 * Since Skill v2 imports are stored UNTRIMMED (up to SKILL_STORED_MAX);
 * SKILL_IMPORT_MAX is now the inline cap: `inlineSkillBody` fits a long
 * skill under it at heading boundaries only when it is injected inline.
 */
export function inlineSkillBody(body: string, url: string | undefined): string {
  if (body.length <= SKILL_IMPORT_MAX) return body;
  return fitSkillBody(body, SKILL_IMPORT_MAX, url ?? "the skill's source").text;
}

export type GithubSkillUrl = {
  owner: string;
  repo: string;
  /** Branch, tag or sha from a /tree/ or /blob/ URL; undefined → default branch. */
  ref?: string;
  /** Folder (tree URL) or SKILL.md file (blob URL) inside the repo; "" = root. */
  path: string;
  kind: "repo" | "tree" | "blob";
};

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Accepts https://github.com/o/r, …/tree/<ref>/<path>, …/blob/<ref>/<path>/SKILL.md
 * (also without scheme, with .git, trailing slashes, ?query or #hash).
 * `<ref>` is taken as the first segment after tree/blob, which covers
 * every branch name without a slash.
 */
export function parseGithubSkillUrl(raw: string): GithubSkillUrl {
  const input = raw.trim();
  if (!input) throw new Error("Paste a GitHub URL");
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error("That is not a valid URL");
  }
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    throw new Error("Only github.com URLs are supported");
  }
  const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  if (parts.length < 2) throw new Error("The URL needs an owner and a repository");
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) throw new Error("That is not a GitHub repository URL");
  if (parts.length === 2) return { owner, repo, path: "", kind: "repo" };
  const mode = parts[2];
  if ((mode !== "tree" && mode !== "blob") || parts.length < 4) {
    throw new Error("Use a repository, folder (/tree/…) or SKILL.md (/blob/…) URL");
  }
  const ref = parts[3];
  const path = parts.slice(4).join("/");
  if (path.split("/").some((seg) => seg === ".." || seg === ".")) throw new Error("Invalid path in URL");
  if (mode === "blob") {
    if (!/(^|\/)SKILL\.md$/.test(path)) throw new Error("A file URL must point at a SKILL.md");
    return { owner, repo, ref, path, kind: "blob" };
  }
  return { owner, repo, ref, path, kind: "tree" };
}

/** Safe repo-relative path of a SKILL.md (what importFromGithub accepts). */
export function isSkillPath(path: string): boolean {
  if (!/(^|\/)SKILL\.md$/.test(path) || path.length > 400) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

type TreeEntry = { path?: string; type?: string; size?: number };

/**
 * SKILL.md blobs under `base` (a folder, a SKILL.md path, or "" for the
 * whole repo), sorted by path, at most `max`. `total` counts all matches
 * so the caller can say the scan was capped.
 */
export function findSkillFiles(
  tree: readonly TreeEntry[],
  base: string,
  max: number = GITHUB_SKILL_SCAN_MAX
): { files: Array<{ path: string; size?: number }>; total: number } {
  const prefix = base.replace(/\/+$/, "");
  const matches = tree
    .filter((e): e is TreeEntry & { path: string } => e.type === "blob" && typeof e.path === "string")
    .filter((e) => isSkillPath(e.path))
    .filter((e) => !prefix || e.path === prefix || e.path.startsWith(`${prefix}/`))
    .map((e) => ({ path: e.path, ...(typeof e.size === "number" ? { size: e.size } : {}) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { files: matches.slice(0, max), total: matches.length };
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    const inner = v.slice(1, -1);
    return v.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\n/g, "\n") : inner.replace(/''/g, "'");
  }
  return v;
}

/**
 * Minimal YAML front matter: top-level `key: value` pairs, quoted values,
 * and `|` / `>` block scalars. Nested maps and lists are kept as their raw
 * text, which is all a SKILL.md header needs. No front matter → `{}` and
 * the whole text as body.
 */
export function parseFrontMatter(markdown: string): { data: Record<string, string>; body: string } {
  const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!match) return { data: {}, body: text.trim() };
  const lines = match[1].split("\n");
  const data: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    const rest = m[2].trim();
    const block: string[] = [];
    let j = i + 1;
    while (j < lines.length && (/^[ \t]+\S/.test(lines[j]) || lines[j].trim() === "")) {
      block.push(lines[j]);
      j++;
    }
    while (block.length && block[block.length - 1].trim() === "") block.pop();
    if (/^[|>][+-]?$/.test(rest)) {
      const indent = Math.min(...block.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
      const raw = block.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      data[key] = rest.startsWith("|")
        ? raw.join("\n").trim()
        : raw.join("\n").split(/\n{2,}/).map((p) => p.replace(/\n/g, " ").trim()).join("\n").trim();
      i = j - 1;
    } else if (rest === "" && block.length) {
      data[key] = block.join("\n").trim();
      i = j - 1;
    } else {
      // Plain scalars may continue on indented lines (YAML folding).
      const folded = [rest, ...block.map((l) => l.trim())].filter(Boolean).join(" ");
      data[key] = unquote(folded);
      i = j - 1;
    }
  }
  return { data, body: text.slice(match[0].length).trim() };
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** First prose paragraph of a markdown body (skips headings, fences, quotes). */
export function firstParagraph(body: string): string {
  let inFence = false;
  for (const para of body.split(/\n\s*\n/)) {
    const lines = para.split("\n");
    const out: string[] = [];
    for (const line of lines) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence || /^\s*#/.test(line) || /^\s*>/.test(line) || /^\s*[-*_]{3,}\s*$/.test(line)) continue;
      out.push(line.trim());
    }
    const text = out.join(" ").trim();
    if (text) return text;
  }
  return "";
}

/** Folder holding the SKILL.md (`skills/break-ui/SKILL.md` → `break-ui`); root → repo name. */
export function skillFolderName(path: string, repo: string): string {
  const parts = path.split("/");
  return parts.length >= 2 ? parts[parts.length - 2] : repo;
}

export type ParsedSkill = {
  name: string;
  description: string;
  /** Instructions body with the front matter stripped. */
  body: string;
  /** Skill names from `requires:` / `dependencies:` (resolved by name on import). */
  requires: string[];
  /** Raw tool names from `allowed-tools:` / `permissions:` / `tools:`. */
  permissions: string[];
};

/**
 * A front matter list as our minimal parser keeps it: `[a, b]`, `a, b`,
 * `a b` (allowed-tools style) or a `- a` block. Quotes are stripped.
 */
export function parseFrontMatterList(raw: string | undefined): string[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  let items: string[];
  if (/^\s*-\s/m.test(text)) {
    items = text.split("\n").map((l) => l.replace(/^\s*-\s*/, ""));
  } else {
    const inner = text.replace(/^\[/, "").replace(/\]$/, "");
    // Keep "Bash(npm test:*)" whole: split on commas, else on spaces outside parens.
    items = inner.includes(",") ? inner.split(",") : inner.match(/[^\s(]+(?:\([^)]*\))?/g) ?? [];
  }
  return Array.from(new Set(items.map((i) => unquote(i.trim())).filter(Boolean)));
}

/** Name/description from front matter, else folder name + first paragraph. */
export function parseSkillMarkdown(markdown: string, path: string, repo: string): ParsedSkill {
  const { data, body } = parseFrontMatter(markdown);
  const name = clip(data.name?.trim() || skillFolderName(path, repo), SKILL_NAME_MAX);
  const description = clip(data.description?.trim() || firstParagraph(body), SKILL_DESCRIPTION_MAX);
  const requires = parseFrontMatterList(data.requires ?? data.dependencies ?? data["depends-on"]);
  const permissions = parseFrontMatterList(data["allowed-tools"] ?? data.permissions ?? data.tools);
  return { name, description, body, requires, permissions };
}

type Section = { text: string; isHeading: boolean };

/** Split a markdown body into chunks that each start at a heading line (fences respected). */
function splitAtHeadings(body: string): Section[] {
  const sections: Section[] = [];
  let current: string[] = [];
  let currentIsHeading = false;
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence && /^#{1,6}\s/.test(line);
    if (heading && current.length) {
      sections.push({ text: current.join("\n"), isHeading: currentIsHeading });
      current = [];
    }
    if (heading) currentIsHeading = true;
    current.push(line);
  }
  if (current.length) sections.push({ text: current.join("\n"), isHeading: currentIsHeading });
  return sections;
}

export function trimNote(originalLength: number, url: string): string {
  return `(trimmed from ${originalLength.toLocaleString("en-US")} chars; full: ${url})`;
}

/**
 * Fit a skill body under `max` without cutting mid-sentence: keep it whole
 * when it fits; otherwise drop trailing sections at markdown heading
 * boundaries until it fits, then append the trim note. When even the first
 * section is too long, fall back to whole paragraphs, then whole lines.
 */
export function fitSkillBody(
  body: string,
  max: number,
  url: string
): { text: string; trimmed: boolean; originalLength: number } {
  const originalLength = body.length;
  if (body.length <= max) return { text: body, trimmed: false, originalLength };
  const note = `\n\n${trimNote(originalLength, url)}`;
  const room = max - note.length;
  const join = (parts: string[], sep: string) => parts.join(sep).trimEnd();

  const sections = splitAtHeadings(body).map((s) => s.text);
  for (let keep = sections.length - 1; keep >= 1; keep--) {
    const text = join(sections.slice(0, keep), "\n");
    if (text.length <= room && text.trim()) return { text: text + note, trimmed: true, originalLength };
  }
  const paragraphs = body.split(/\n{2,}/);
  for (let keep = paragraphs.length - 1; keep >= 1; keep--) {
    const text = join(paragraphs.slice(0, keep), "\n\n");
    if (text.length <= room && text.trim()) return { text: text + note, trimmed: true, originalLength };
  }
  const lines = body.split("\n");
  let text = "";
  for (const line of lines) {
    const next = text ? `${text}\n${line}` : line;
    if (next.length > room) break;
    text = next;
  }
  return { text: text.trimEnd() + note, trimmed: true, originalLength };
}

/** Public URLs for a file at a commit. */
export function githubFileUrls(owner: string, repo: string, sha: string, path: string) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return {
    html: `https://github.com/${owner}/${repo}/blob/${sha}/${encoded}`,
    raw: `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${encoded}`,
  };
}

/**
 * Recommended role mapping for github.com/emilkowalski/skills (MIT), keyed
 * by team role → skill names (front matter `name`). Documented in
 * docs/skills-import.md; applied with skills.assignRoles after an import.
 */
export const EMIL_SKILLS_ROLE_MAPPING: Readonly<Record<string, readonly string[]>> = {
  designer: ["emil-design-eng", "apple-design", "animation-vocabulary"],
  frontend: ["pick-ui-library", "mobile-native", "animation-performance"],
  qa: ["break-ui", "review-animations"],
  reviewer: ["improve-animations", "remove-animations"],
};
