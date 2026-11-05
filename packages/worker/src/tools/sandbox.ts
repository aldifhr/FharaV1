import * as fs from "node:fs/promises";
import * as path from "node:path";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/**
 * Lexical containment check. Every tool must resolve paths through this first.
 */
export function resolveSandboxPath(workspaceRoot: string, requested: string): string {
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
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return true;
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  if (left === right) return true;
  return process.platform === "win32" && left.toLowerCase() === right.toLowerCase();
}

async function realpathOrCurrent(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Symlink-aware sandbox resolution.
 *
 * The lexical check alone is bypassable: an in-workspace symlink can point
 * outside the workspace. We resolve the nearest existing ancestor with
 * `realpath` and verify the real target is still inside the real workspace
 * root. Non-existent path segments are appended afterwards.
 */
export async function resolveSandboxPathAsync(
  workspaceRoot: string,
  requested: string
): Promise<string> {
  const lexical = resolveSandboxPath(workspaceRoot, requested);
  const realRoot = await realpathOrCurrent(path.resolve(workspaceRoot));

  let current = lexical;
  const missing: string[] = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const realAncestor = await fs.realpath(current);
      const resolved = path.join(realAncestor, ...missing.slice().reverse());
      if (!isWithinWorkspace(realRoot, resolved)) {
        throw new SandboxError(
          `Path escapes workspace via symlink: "${requested}" -> "${resolved}" (root: ${realRoot})`
        );
      }
      return resolved;
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      const parent = path.dirname(current);
      if (samePath(parent, current)) break;
      missing.push(path.basename(current));
      current = parent;
    }
  }

  throw new SandboxError(`Unable to resolve path safely: "${requested}"`);
}
