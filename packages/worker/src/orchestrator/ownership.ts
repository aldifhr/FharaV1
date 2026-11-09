// Pure path-scope helpers live in `@/utils/ownershipPaths` (shared with the
// execution layer and the scheduler); re-exported for existing importers.
export {
  MAX_ALLOWED_PATHS,
  MAX_ALLOWED_PATH_LENGTH,
  normalizeAllowedPaths,
  isPathWithinOwnership,
  pathsOverlap,
  type NormalizeOwnershipResult,
} from "@/utils/ownershipPaths";

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
