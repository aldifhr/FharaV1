/**
 * Skill dependencies, required permissions and version diffs (pure).
 *
 * - Dependencies: a skill may declare `requires` (other skills). Assigning
 *   it pulls the required skills in too (with a warning naming them);
 *   removing a skill another attached skill requires is allowed but warns.
 * - Permissions: a skill may declare the tools it needs (`permissions`).
 *   They are ADVISORY only: assigning such a skill to an agent whose role
 *   lacks the tool warns, and nothing ever grants a tool because of a skill.
 */
import { ROLES, isRoleKey, normalizeRoleKey } from "./roles";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Most skills one skill may require. */
export const SKILL_REQUIRES_MAX = 12;

export type RequiresMap = ReadonlyMap<string, readonly string[]>;

/**
 * `ids` plus every skill they transitively require, in order: the given ids
 * keep their order and each newly pulled dependency is appended after them.
 * Unknown ids (deleted skills) are reported in `missing`; cycles are safe.
 */
export function expandWithDependencies(
  ids: readonly string[],
  requires: RequiresMap,
  exists: (id: string) => boolean = (id) => requires.has(id)
): { ids: string[]; added: string[]; missing: string[] } {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  const added: string[] = [];
  const missing: string[] = [];
  const queue = [...out];
  while (queue.length) {
    const id = queue.shift()!;
    for (const dep of requires.get(id) ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      if (!exists(dep)) {
        missing.push(dep);
        continue;
      }
      out.push(dep);
      added.push(dep);
      queue.push(dep);
    }
  }
  return { ids: out, added, missing };
}

/**
 * Would `skillId` requiring `deps` create a cycle? (Some dep already
 * reaches `skillId` through its own requires.)
 */
export function createsDependencyCycle(skillId: string, deps: readonly string[], requires: RequiresMap): boolean {
  if (deps.includes(skillId)) return true;
  const seen = new Set<string>();
  const stack = [...deps];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === skillId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(requires.get(id) ?? []));
  }
  return false;
}

/**
 * Skills still attached (`remaining`) that require one of `removed`:
 * `[{ removed, requiredBy: [...] }]`, one entry per removed skill that is
 * still needed.
 */
export function brokenDependencies(
  removed: readonly string[],
  remaining: readonly string[],
  requires: RequiresMap
): Array<{ removed: string; requiredBy: string[] }> {
  const out: Array<{ removed: string; requiredBy: string[] }> = [];
  for (const gone of removed) {
    const requiredBy = remaining.filter((id) => id !== gone && (requires.get(id) ?? []).includes(gone));
    if (requiredBy.length) out.push({ removed: gone, requiredBy });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** Tools/permissions a skill can declare it needs. */
export const SKILL_PERMISSIONS = ["read_file", "write_file", "run_command", "browser", "network", "github"] as const;
export type SkillPermission = (typeof SKILL_PERMISSIONS)[number];

export const SKILL_PERMISSION_LABELS: Record<SkillPermission, string> = {
  read_file: "read files",
  write_file: "write files",
  run_command: "run commands",
  browser: "browser",
  network: "network",
  github: "GitHub",
};

/**
 * Map a declared tool name (ours, or a SKILL.md `allowed-tools` entry such
 * as `Bash(npm test:*)`, `Edit`, `WebFetch`) to a permission. Unknown → null.
 */
export function normalizeSkillPermission(raw: string): SkillPermission | null {
  const name = raw.trim().replace(/\(.*$/, "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!name) return null;
  if ((SKILL_PERMISSIONS as readonly string[]).includes(name)) return name as SkillPermission;
  if (["read", "grep", "glob", "ls", "list_files", "readfile"].includes(name)) return "read_file";
  if (["write", "edit", "multiedit", "multi_edit", "notebookedit", "writefile"].includes(name)) return "write_file";
  if (["bash", "shell", "command", "run", "exec", "terminal", "runcommand"].includes(name)) return "run_command";
  if (["webfetch", "web_fetch", "websearch", "web_search", "fetch", "http"].includes(name)) return "network";
  if (name.includes("browser") || name.includes("playwright") || name.includes("puppeteer")) return "browser";
  if (name.startsWith("github") || name === "gh") return "github";
  return null;
}

export function normalizeSkillPermissions(raw: readonly string[] | undefined): SkillPermission[] {
  const out: SkillPermission[] = [];
  for (const item of raw ?? []) {
    const perm = normalizeSkillPermission(item);
    if (perm && !out.includes(perm)) out.push(perm);
  }
  return out;
}

/** Roles that never write files or run commands (mirrors the worker's broker matrix). */
const READ_ONLY_ROLE_DENIED: Readonly<Record<string, readonly SkillPermission[]>> = {
  reviewer: ["write_file", "run_command"],
  researcher: ["write_file", "run_command"],
};

/**
 * What an agent can actually use, for the advisory check: its declared
 * `supportedTools` (else its role's default tools), plus `browser` /
 * `github` / `network` from capabilities, minus what the role is denied.
 */
export function agentPermissions(agent: {
  role: string;
  supportedTools?: readonly string[];
  capabilities?: readonly string[];
}): Set<SkillPermission> {
  const role = normalizeRoleKey(agent.role);
  const tools = agent.supportedTools?.length
    ? agent.supportedTools
    : isRoleKey(role)
      ? ROLES[role].defaultTools
      : ["read_file"];
  const caps = agent.capabilities ?? (isRoleKey(role) ? ROLES[role].capabilities : []);
  const out = new Set<SkillPermission>();
  for (const tool of tools) {
    const perm = normalizeSkillPermission(tool);
    if (perm) out.add(perm);
  }
  if (caps.includes("browser-testing")) out.add("browser");
  if (caps.includes("github")) out.add("github");
  if (caps.includes("research")) out.add("network");
  for (const denied of READ_ONLY_ROLE_DENIED[role] ?? []) out.delete(denied);
  return out;
}

/** Declared permissions this agent lacks. */
export function missingPermissions(
  required: readonly string[] | undefined,
  agent: { role: string; supportedTools?: readonly string[]; capabilities?: readonly string[] }
): SkillPermission[] {
  const have = agentPermissions(agent);
  return normalizeSkillPermissions(required).filter((perm) => !have.has(perm));
}

// ---------------------------------------------------------------------------
// Version diff
// ---------------------------------------------------------------------------

export type DiffLine = { op: "same" | "add" | "del"; text: string };

/** Above this many lines per side the diff is a plain replace (LCS is O(n·m)). */
export const DIFF_MAX_LINES = 3_000;

/** Line diff (LCS). Equal inputs → all "same". */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    return [...a.map((text) => ({ op: "del" as const, text })), ...b.map((text) => ({ op: "add" as const, text }))];
  }
  // Trim common prefix/suffix first: most edits are local.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      mid.push({ op: "same", text: midA[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      mid.push({ op: "del", text: midA[i++] });
    } else {
      mid.push({ op: "add", text: midB[j++] });
    }
  }
  while (i < n) mid.push({ op: "del", text: midA[i++] });
  while (j < m) mid.push({ op: "add", text: midB[j++] });
  return [
    ...a.slice(0, start).map((text) => ({ op: "same" as const, text })),
    ...mid,
    ...a.slice(endA).map((text) => ({ op: "same" as const, text })),
  ];
}

/** "+3 −1" summary counts. */
export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.op === "add") added++;
    else if (line.op === "del") removed++;
  }
  return { added, removed };
}
