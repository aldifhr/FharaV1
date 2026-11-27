import type { AgentDefinition } from "@/types";
import { canWriteAny, permissionsForAgent } from "@/utils/rolePolicy";
import { isAgentAvailable, routeCapability } from "./capabilities";
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

function hasGlobChar(segment: string): boolean {
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "*" || ch === "?" || ch === "[" || ch === "{") return true;
  }
  return false;
}

function normalizePathPrefix(raw: string): string {
  const segments = raw.trim().replaceAll("\\", "/").split("/");
  if (segments[0] === ".") segments.shift();
  // Keep only the literal directory part of a glob: "src/components/**/*.tsx"
  // scopes to "src/components".
  const literal: string[] = [];
  for (const segment of segments) {
    if (hasGlobChar(segment)) break;
    literal.push(segment);
  }
  let joined = literal.join("/");
  while (joined.endsWith("/")) joined = joined.slice(0, -1);
  return joined;
}

/**
 * True when a (possibly absolute, worktree-rooted) file sits inside scope.
 * A single-segment scope such as `lib` is rooted at the worktree: it must not
 * match every nested `lib` directory in a monorepo.
 */
function fileInScope(file: string, scope: string): boolean {
  if (file === scope || file.startsWith(`${scope}/`)) return true;
  if (!scope.includes("/")) return false;
  return file.endsWith(`/${scope}`) || file.includes(`/${scope}/`);
}

export interface FixCandidate {
  key: string;
  kind: string;
  capability: string;
  allowedPaths?: string[];
}

/**
 * Pick the fix owner for review findings: the code_change subtask whose
 * allowedPaths is the LONGEST prefix of a finding file. No finding path, or
 * no matching path, means no owner — the caller stops with that reason instead
 * of silently selecting the most recent code_change.
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
  if (files.length === 0) return undefined;

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
  return best;
}

export interface FixOwner {
  /** The code_change subtask that owns the findings' files. */
  subtask: FixCandidate;
  /** The agent that wrote that subtask's code (else its capability owner). */
  agent: AgentDefinition;
}

/**
 * Plan 040: the ONE rule for who gets a fix (review, QA, verification and
 * orchestrator critical findings): the code_change subtask that owns the
 * findings' files (`pickFixOwner`, or the caller's narrower candidate
 * list), and the agent that actually wrote it (`writerByKey`, the run's
 * assignment) — else the agent its capability routes to. Never the first
 * Frontend/Backend in the roster, never a catch-all ("general"),
 * never a role that may not write. Null = nobody owns it: the caller
 * stops with a reason instead of guessing.
 */
export function ownerForFix(input: {
  subtasks: FixCandidate[];
  findings: Array<{ filePath?: string }>;
  agents: AgentDefinition[];
  writerByKey?: ReadonlyMap<string, AgentDefinition>;
  /** Restrict owners first (e.g. QA prefers UI implementers); falls back to all. */
  prefer?: (candidate: FixCandidate) => boolean;
}): FixOwner | null {
  const preferred = input.prefer ? input.subtasks.filter((candidate) => candidate.kind === "code_change" && input.prefer!(candidate)) : [];
  const subtask = pickFixOwner(
    preferred.length > 0 ? preferred : input.subtasks,
    input.findings
  );
  if (!subtask) return null;
  const writer = input.writerByKey?.get(subtask.key);
  const enabled = input.agents.filter(isAgentAvailable);
  const agent =
    writer && enabled.some((candidate) => candidate._id === writer._id)
      ? writer
      : routeCapability(subtask.capability, enabled);
  if (!agent || !canWriteAny(permissionsForAgent(agent))) return null;
  return { subtask, agent };
}
