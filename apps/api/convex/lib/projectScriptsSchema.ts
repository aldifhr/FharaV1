import { v } from "convex/values";

/**
 * GOAT G9 (+ threadbear T6): one `projects.scripts` field for the project's
 * setup script (run when a task worktree is created) and
 * its check script (run by the host after a task reaches Done).
 *
 * Exact-argv allowlist, the same rule as the worker's command allowlist: a
 * script is stored as argv and must equal one of the entries below element
 * for element. No shell, no prefixes, no free-form strings, so a stored
 * script can never become `npm ci && curl …`. Pure (no Node APIs): the
 * Convex mutation, the worker and the Settings UI all read it.
 */
export type ProjectScriptKind = "setup" | "check";

export const PROJECT_SCRIPT_KINDS: readonly ProjectScriptKind[] = ["setup", "check"];

export const PROJECT_SCRIPT_ARGV: Readonly<Record<ProjectScriptKind, ReadonlyArray<ReadonlyArray<string>>>> = {
  setup: [
    ["npm", "ci"],
    ["npm", "ci", "--ignore-scripts"],
    ["npm", "install"],
    ["pnpm", "install", "--frozen-lockfile"],
    ["yarn", "install", "--frozen-lockfile"],
    ["bun", "install", "--frozen-lockfile"],
  ],
  check: [
    ["npm", "test"],
    ["npm", "run", "test"],
    ["npm", "run", "check"],
    ["npm", "run", "typecheck"],
    ["npm", "run", "lint"],
    ["npm", "run", "build"],
    ["npx", "tsc", "--noEmit"],
    ["pnpm", "test"],
    ["pnpm", "run", "check"],
    ["yarn", "test"],
    ["bun", "test"],
  ],
};

export const PROJECT_SCRIPT_LABELS: Record<ProjectScriptKind, string> = {
  setup: "Setup script",
  check: "Check script",
};

export const PROJECT_SCRIPT_HINTS: Record<ProjectScriptKind, string> = {
  setup: "Runs once in each new task worktree, before any agent starts.",
  check: "Runs on the host after a task is Done. Its result is shown next to what the agents reported.",
};

/** Host check limits: 10 minutes, then the last 40 lines and at most 4,000 characters of output. */
export const HOST_CHECK_TIMEOUT_MS = 10 * 60_000;
export const SCRIPT_TAIL_LINES = 40;
export const SCRIPT_TAIL_CHARS = 4_000;

export interface ProjectScripts {
  setup?: string[];
  check?: string[];
}

export const projectScriptsValidator = v.object({
  setup: v.optional(v.array(v.string())),
  check: v.optional(v.array(v.string())),
});

export function isProjectScriptAllowed(kind: ProjectScriptKind, argv: readonly string[]): boolean {
  return PROJECT_SCRIPT_ARGV[kind].some(
    (candidate) => candidate.length === argv.length && candidate.every((value, index) => value === argv[index])
  );
}

/** "npm run test", for display and for the Settings select values. */
export function projectScriptLine(argv: readonly string[]): string {
  return argv.join(" ");
}

/** The allowlisted argv for a select value; null for "" (none) or anything not on the list. */
export function parseProjectScriptLine(kind: ProjectScriptKind, line: string): string[] | null {
  const argv = line.trim().split(/\s+/).filter(Boolean);
  if (argv.length === 0) return null;
  return isProjectScriptAllowed(kind, argv) ? argv : null;
}

/**
 * The configured, still-allowlisted script of a kind, or null. A stored
 * entry that is no longer on the list (the list shrank) counts as not
 * configured and is never run.
 */
export function configuredProjectScript(scripts: unknown, kind: ProjectScriptKind): string[] | null {
  if (!scripts || typeof scripts !== "object") return null;
  const argv = (scripts as Record<string, unknown>)[kind];
  if (!Array.isArray(argv) || !argv.every((part) => typeof part === "string")) return null;
  return isProjectScriptAllowed(kind, argv) ? [...argv] : null;
}
