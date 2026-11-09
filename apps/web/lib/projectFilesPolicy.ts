import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Path policy for /api/project-files (release audit P0-2). Pure node code,
 * no Next imports, so it is unit-tested directly.
 *
 *  - The base directory is the project's registered workspace (looked up
 *    server-side), never a path from the request.
 *  - A file must realpath() to somewhere under the realpath of that base,
 *    so `..`, absolute paths and symlinks pointing outside are refused.
 *  - Secret-shaped files are never listed or read: .env*, .git internals,
 *    private keys and certificates, credential stores.
 */

const DENIED_DIRS = new Set([".git", ".hg", ".svn", ".ssh", ".gnupg", ".aws", ".docker", ".kube", ".convex"]);

const DENIED_NAMES = new Set([
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".htpasswd",
  ".pgpass",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "credentials.json",
  "service-account.json",
  "secrets.json",
  "secrets.yml",
  "secrets.yaml",
  ".convex-local.sqlite3",
]);

const DENIED_EXT = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".asc", ".gpg", ".kdbx", ".ppk"]);

/** True when a workspace-relative path must never be listed or read. */
export function isDeniedPath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return false;
  for (const segment of segments.slice(0, -1)) {
    if (DENIED_DIRS.has(segment.toLowerCase())) return true;
  }
  const name = segments[segments.length - 1].toLowerCase();
  if (DENIED_DIRS.has(name)) return true; // e.g. a `.git` file in a worktree
  // .env, .env.local, .env.example, prod.env: all denied (templates included,
  // since people paste real values into them).
  if (name.startsWith(".env") || name.endsWith(".env")) return true;
  if (DENIED_NAMES.has(name)) return true;
  if (/^id_[a-z0-9]+$/.test(name)) return true; // ssh private keys without extension
  return DENIED_EXT.has(path.extname(name));
}

/** Resolve the project's base directory the way the worker does. */
export function resolveWorkspaceBase(
  workspacePath: string,
  env: Record<string, string | undefined> = process.env,
  workerDir?: string,
): string {
  const trimmed = workspacePath.trim();
  if (!trimmed || trimmed.includes("\0")) throw new Error("Project has no usable workspace path");
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  // packages/worker resolves relative paths against WORKSPACE_ROOT, itself
  // relative to the worker's cwd (packages/worker).
  const root = env.WORKSPACE_ROOT?.trim() || "./workspaces";
  const base = workerDir ?? path.resolve(process.cwd(), "../../packages/worker");
  return path.resolve(base, root, trimmed);
}

export class PathPolicyError extends Error {}

/**
 * Real path of `filePath` inside `realBase` (itself already realpath'd).
 * Throws PathPolicyError when the file escapes the base or is denied.
 */
export async function resolveContainedFile(realBase: string, filePath: string): Promise<string> {
  if (!filePath || filePath.includes("\0")) throw new PathPolicyError("Invalid file path");
  const relative = filePath.replace(/^[/\\]+/, "");
  if (isDeniedPath(relative)) throw new PathPolicyError("This file is not available for preview");
  const candidate = path.resolve(realBase, relative);
  if (!isInside(realBase, candidate)) throw new PathPolicyError("File is outside the workspace");
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    throw new PathPolicyError("File not found");
  }
  if (!isInside(realBase, real)) throw new PathPolicyError("File is outside the workspace");
  if (isDeniedPath(path.relative(realBase, real))) throw new PathPolicyError("This file is not available for preview");
  return real;
}

export function isInside(base: string, target: string): boolean {
  if (target === base) return true;
  const rel = path.relative(base, target);
  return !!rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
