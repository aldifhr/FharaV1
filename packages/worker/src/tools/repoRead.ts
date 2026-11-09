import * as fs from "node:fs/promises";
import * as path from "node:path";
import { REPO_TOOL_CAPS, capToolOutput, type RepoToolResult } from "@/api/convex/lib/chat/repoTools";
import { maskStringSecrets, validateFilePath } from "@/governance/tools";
import { resolveSandboxPathAsync } from "./sandbox";

/**
 * Read-only repo tools for grounded chat replies (list_files, grep,
 * read_file). Every path resolves through the symlink-aware sandbox and
 * the governed path rules (no .env*, .git, node_modules, keys); walks skip
 * the same plus build output. Outputs are capped and secret-masked. There
 * is no write and no command execution here by design.
 */

/** Directories a walk never enters (noise or secrets). */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  ".convex",
  ".turbo",
  ".qa",
  "coverage",
  ".ssh",
  ".gnupg",
  ".moagent-worktrees",
  "_generated",
]);

/** File names a walk or read never touches, beyond validateFilePath. */
const SECRET_NAME =
  /^(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|credentials(\.json)?|secrets?(\.[a-z]+)?|.*\.(pem|key|p12|pfx|keystore|jks))$/i;

export class RepoPathError extends Error {}

const GREP_TIME_BUDGET_MS = 5_000;

/**
 * Guard one requested path: repo-relative, inside the workspace (also via
 * symlinks), and not a secret or ignored location. Returns the absolute
 * path and its normalized repo-relative form.
 */
export async function guardRepoPath(
  workspaceRoot: string,
  requested: string
): Promise<{ absolute: string; relative: string }> {
  const raw = (requested ?? "").trim();
  const normalized = raw === "" || raw === "." || raw === "./" ? "" : raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.includes("\0")) throw new RepoPathError("Invalid path.");
  if (normalized) {
    const governed = validateFilePath(normalized);
    if (!governed.ok) throw new RepoPathError(`Path not allowed: ${normalized}`);
    const segments = normalized.split("/").filter(Boolean);
    if (segments.some((s) => SKIP_DIRS.has(s)) || SECRET_NAME.test(segments[segments.length - 1] ?? "")) {
      throw new RepoPathError(`Path not allowed: ${normalized}`);
    }
  }
  let absolute: string;
  try {
    absolute = normalized ? await resolveSandboxPathAsync(workspaceRoot, normalized) : path.resolve(workspaceRoot);
  } catch {
    throw new RepoPathError(`Path is outside the repository: ${raw}`);
  }
  const relative = path.relative(path.resolve(workspaceRoot), absolute).replace(/\\/g, "/");
  return { absolute, relative };
}

/** Minimal glob → RegExp: `**` any depth, `*` within a segment, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  const g = glob.replace(/\\/g, "/");
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i += 1;
        if (g[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  // A bare pattern like "*.ts" matches at any depth.
  const anchored = g.includes("/") ? `^${out}$` : `(?:^|/)${out}$`;
  return new RegExp(anchored);
}

interface WalkEntry {
  relative: string;
  absolute: string;
  size: number;
}

/** Files under `startAbs` (or the file itself), skipping ignored dirs and secrets. */
async function walkFiles(
  workspaceRoot: string,
  startAbs: string,
  limit: number,
  filter?: RegExp
): Promise<{ files: WalkEntry[]; truncated: boolean }> {
  const root = path.resolve(workspaceRoot);
  const files: WalkEntry[] = [];
  let truncated = false;
  const stat = await fs.stat(startAbs).catch(() => null);
  if (!stat) throw new RepoPathError(`Not found: ${path.relative(root, startAbs) || "."}`);
  if (stat.isFile()) {
    return { files: [{ relative: path.relative(root, startAbs).replace(/\\/g, "/"), absolute: startAbs, size: stat.size }], truncated };
  }
  const stack = [startAbs];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // never follow links out of the repo
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(absolute);
        continue;
      }
      if (!entry.isFile() || SECRET_NAME.test(entry.name)) continue;
      const relative = path.relative(root, absolute).replace(/\\/g, "/");
      if (!validateFilePath(relative).ok) continue;
      if (filter && !filter.test(relative)) continue;
      if (files.length >= limit) {
        truncated = true;
        return { files, truncated };
      }
      const size = (await fs.stat(absolute).catch(() => null))?.size ?? 0;
      files.push({ relative, absolute, size });
    }
  }
  return { files, truncated };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8_000);
  return sample.includes(0);
}

async function listFiles(workspaceRoot: string, args: Record<string, unknown>): Promise<RepoToolResult> {
  const { absolute, relative } = await guardRepoPath(workspaceRoot, str(args.path));
  const glob = str(args.glob).slice(0, REPO_TOOL_CAPS.patternMaxChars);
  const { files, truncated } = await walkFiles(
    workspaceRoot,
    absolute,
    REPO_TOOL_CAPS.listMaxEntries,
    glob ? globToRegExp(glob) : undefined
  );
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  const lines = files.map((f) => `${f.relative} (${f.size} bytes)`);
  const header = `${files.length} file(s) under ${relative || "."}${glob ? ` matching ${glob}` : ""}${truncated ? ` (first ${REPO_TOOL_CAPS.listMaxEntries}; narrow path/glob for more)` : ""}:`;
  return { ok: true, text: capToolOutput([header, ...lines].join("\n")) };
}

function compilePattern(pattern: string, ignoreCase: boolean): RegExp {
  const flags = ignoreCase ? "i" : "";
  try {
    return new RegExp(pattern, flags);
  } catch {
    // Not a valid regex: search it literally.
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  }
}

async function grep(workspaceRoot: string, args: Record<string, unknown>): Promise<RepoToolResult> {
  const pattern = str(args.pattern);
  if (!pattern.trim()) return { ok: false, text: "grep needs a non-empty \"pattern\"." };
  if (pattern.length > REPO_TOOL_CAPS.patternMaxChars) {
    return { ok: false, text: `grep pattern is longer than ${REPO_TOOL_CAPS.patternMaxChars} chars.` };
  }
  const regex = compilePattern(pattern, args.ignoreCase === true);
  const { absolute, relative } = await guardRepoPath(workspaceRoot, str(args.path));
  const glob = str(args.glob).slice(0, REPO_TOOL_CAPS.patternMaxChars);
  const { files } = await walkFiles(
    workspaceRoot,
    absolute,
    REPO_TOOL_CAPS.grepMaxFilesScanned,
    glob ? globToRegExp(glob) : undefined
  );
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  const matches: string[] = [];
  let truncated = false;
  // Wall-clock budget: a pathological regex must not stall the worker.
  const deadline = Date.now() + GREP_TIME_BUDGET_MS;
  for (const file of files) {
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }
    if (file.size > REPO_TOOL_CAPS.grepMaxFileBytes) continue;
    const buffer = await fs.readFile(file.absolute).catch(() => null);
    if (!buffer || looksBinary(buffer)) continue;
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!regex.test(lines[i])) continue;
      if (matches.length >= REPO_TOOL_CAPS.grepMaxMatches) {
        truncated = true;
        break;
      }
      const line = lines[i].trim();
      const clipped = line.length > REPO_TOOL_CAPS.grepMaxLineChars ? `${line.slice(0, REPO_TOOL_CAPS.grepMaxLineChars)}…` : line;
      matches.push(`${file.relative}:${i + 1}: ${clipped}`);
    }
    if (truncated) break;
  }
  const scope = relative || ".";
  if (matches.length === 0) return { ok: true, text: `No matches for ${JSON.stringify(pattern)} under ${scope}.` };
  const header = `${matches.length} match(es) for ${JSON.stringify(pattern)} under ${scope}${truncated ? ` (first ${REPO_TOOL_CAPS.grepMaxMatches}; narrow the search for more)` : ""}:`;
  return { ok: true, text: capToolOutput(maskStringSecrets([header, ...matches].join("\n"))) };
}

async function readRepoFile(workspaceRoot: string, args: Record<string, unknown>): Promise<RepoToolResult> {
  const requested = str(args.path);
  if (!requested.trim()) return { ok: false, text: "read_file needs a \"path\"." };
  const { absolute, relative } = await guardRepoPath(workspaceRoot, requested);
  if (!relative) return { ok: false, text: "read_file needs a file path, not the repository root." };
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat) return { ok: false, text: `Not found: ${relative}` };
  if (!stat.isFile()) return { ok: false, text: `${relative} is a directory; use list_files.` };
  const buffer = await fs.readFile(absolute);
  if (looksBinary(buffer)) return { ok: true, text: `${relative}: binary file, ${stat.size} bytes (not shown).`, files: [relative] };
  const all = buffer.toString("utf8").split(/\r?\n/);
  const start = int(args.startLine, 1, 1, Math.max(1, all.length));
  const maxLines = int(args.maxLines, REPO_TOOL_CAPS.readDefaultLines, 1, REPO_TOOL_CAPS.readMaxLines);
  const out: string[] = [];
  let bytes = 0;
  let end = start - 1;
  for (let i = start - 1; i < all.length && out.length < maxLines; i += 1) {
    const line = `${i + 1}: ${all[i]}`;
    if (bytes + line.length + 1 > REPO_TOOL_CAPS.readMaxBytes) break;
    out.push(line);
    bytes += line.length + 1;
    end = i + 1;
  }
  const more = end < all.length ? ` — showing lines ${start}-${end}; call again with startLine ${end + 1} for more` : "";
  const header = `${relative}: ${stat.size} bytes, ${all.length} lines${more}`;
  return { ok: true, text: capToolOutput(maskStringSecrets([header, ...out].join("\n"))), files: [relative] };
}

/** Run one read-only repo tool. Never throws; failures are ok:false with a reason. */
export async function runRepoReadTool(
  workspaceRoot: string,
  tool: string,
  args: Record<string, unknown>
): Promise<RepoToolResult> {
  try {
    switch (tool) {
      case "list_files":
        return await listFiles(workspaceRoot, args);
      case "grep":
        return await grep(workspaceRoot, args);
      case "read_file":
        return await readRepoFile(workspaceRoot, args);
      default:
        return { ok: false, text: `Unknown tool "${tool}". Read-only tools: list_files, grep, read_file.` };
    }
  } catch (error) {
    const message = error instanceof RepoPathError ? error.message : `${tool} failed: ${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, text: maskStringSecrets(message.replace(path.resolve(workspaceRoot), "<repo>")) };
  }
}
