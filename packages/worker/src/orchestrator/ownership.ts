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
    // A directory scope written with a trailing slash ("src/", as the
    // planner's workspace layout lists directories) is the same scope.
    const normalized = normalizeEntry(entry.trim().replace(/\/+$/, ""));
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

function normalizePathPrefix(raw: string): string {
  const segments = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").split("/");
  // Keep only the literal directory part of a glob: "src/components/**/*.tsx"
  // scopes to "src/components".
  const literal: string[] = [];
  for (const segment of segments) {
    if (/[*?[{]/.test(segment)) break;
    literal.push(segment);
  }
  return literal.join("/").replace(/\/+$/, "");
}

/** True when a (possibly absolute, worktree-rooted) file sits inside scope. */
function fileInScope(file: string, scope: string): boolean {
  return (
    file === scope ||
    file.startsWith(`${scope}/`) ||
    file.endsWith(`/${scope}`) ||
    file.includes(`/${scope}/`)
  );
}

export interface FixCandidate {
  key: string;
  kind: string;
  capability: string;
  allowedPaths?: string[];
}

/**
 * Pick the fix owner for review findings: the code_change subtask whose
 * allowedPaths is the LONGEST prefix of a finding file. Ties fall back to
 * the most recent (last) code_change, never the first — a first code_change
 * is often a Backend type-only node while findings live in Frontend files.
 */
export function pickFixOwner(
  candidates: FixCandidate[],
  findings: Array<{ filePath?: string }>
): FixCandidate | undefined {
  const codeChanges = candidates.filter((s) => s.kind === "code_change");
  if (codeChanges.length === 0) return undefined;
  const files = findings
    .map((f) => (f.filePath ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter(Boolean)
    .map((f) => f.toLowerCase());

  let best: FixCandidate | undefined;
  let bestLen = -1;
  for (const candidate of codeChanges) {
    for (const scopeRaw of candidate.allowedPaths ?? []) {
      const scope = normalizePathPrefix(scopeRaw).toLowerCase();
      if (!scope || scope === "src") continue; // generic src/ matches everything — skip
      if (files.some((file) => fileInScope(file, scope))) {
        if (scope.length > bestLen) {
          bestLen = scope.length;
          best = candidate;
        }
      }
    }
  }
  return best ?? codeChanges.at(-1) ?? codeChanges[0];
}
