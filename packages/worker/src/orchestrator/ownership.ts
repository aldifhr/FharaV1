export const MAX_ALLOWED_PATHS = 20;
export const MAX_ALLOWED_PATH_LENGTH = 200;

export type NormalizeOwnershipResult =
  | { ok: true; paths?: string[] }
  | { ok: false; error: string };

function normalizeEntry(entry: string): string | null {
  const normalized = entry.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === "." ) return null;
  if (normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) return null;
  if (normalized.split("/").some((segment) => segment === ".." || segment === "")) return null;
  return normalized;
}

export function normalizeAllowedPaths(raw: unknown): NormalizeOwnershipResult {
  if (raw === undefined || raw === null) return { ok: true };
  if (!Array.isArray(raw)) return { ok: false, error: "allowedPaths must be an array of paths" };
  if (raw.length > MAX_ALLOWED_PATHS) {
    return { ok: false, error: `allowedPaths has ${raw.length} entries; limit is ${MAX_ALLOWED_PATHS}` };
  }
  const paths: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      return { ok: false, error: "allowedPaths entries must be strings" };
    }
    if (entry.length > MAX_ALLOWED_PATH_LENGTH) {
      return { ok: false, error: `allowedPaths entry exceeds ${MAX_ALLOWED_PATH_LENGTH} characters` };
    }
    const normalized = normalizeEntry(entry);
    if (!normalized) {
      return { ok: false, error: `allowedPaths entry is not a workspace-relative path: ${entry}` };
    }
    if (!paths.includes(normalized)) paths.push(normalized);
  }
  return { ok: true, paths: paths.length > 0 ? paths : undefined };
}

export function isPathWithinOwnership(filePath: string, allowedPaths?: string[]): boolean {
  if (!allowedPaths || allowedPaths.length === 0) return true;
  const normalized = normalizeEntry(filePath);
  if (!normalized) return false;
  return allowedPaths.some(
    (scope) => normalized === scope || normalized.startsWith(`${scope}/`)
  );
}

export function pathsOverlap(a?: string[], b?: string[]): boolean {
  if (!a || a.length === 0) return b !== undefined && b.length > 0;
  if (!b || b.length === 0) return true;
  return a.some((scopeA) =>
    b.some((scopeB) => scopeA === scopeB || scopeA.startsWith(`${scopeB}/`) || scopeB.startsWith(`${scopeA}/`))
  );
}
