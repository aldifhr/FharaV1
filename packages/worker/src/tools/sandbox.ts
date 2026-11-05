import * as path from "node:path";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/**
 * Tot: every tool must resolve paths through here.
 * ponytail: path.resolve + startsWith check cukup; symlink escape belum ditutup.
 * Upgrade: realpath + lstat check saat baca file di disk.
 */
export function resolveSandboxPath(workspaceRoot: string, requested: string): string {
  // Reject absolute paths first (Unix /, Windows drive C:\, UNC \\)
  if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(requested)) {
    throw new SandboxError(`Absolute path not allowed: "${requested}"`);
  }
  const normalized = requested.replace(/\\/g, "/").replace(/^\/+/, "");
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolved = path.resolve(resolvedRoot, normalized);

  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new SandboxError(
      `Path escapes workspace: "${requested}" -> "${resolved}" (root: ${resolvedRoot})`
    );
  }
  if (rel === "" && normalized !== "") {
    throw new SandboxError(`Invalid path: "${requested}"`);
  }
  return resolved;
}

export function isWithinWorkspace(workspaceRoot: string, filepath: string): boolean {
  const root = path.resolve(workspaceRoot);
  const file = path.resolve(filepath);
  const rel = path.relative(root, file);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}
