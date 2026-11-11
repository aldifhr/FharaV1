// Adapted from GOAT (https://github.com/goat-si/goat) packages/shared/src/projectScripts.ts @ 718f5b11,
// MIT License, Copyright (c) 2026 T3 Tools Inc. and goat-si contributors. See THIRD_PARTY_NOTICES.md.
//
// Changed by Fhara (GOAT G9): ported `projectScriptCwd`, `projectScriptRuntimeEnv`,
// `setupProjectScript` and `checkProjectScript` only. Fhara stores one `{ setup, check }`
// object of exact argv (apps/api/convex/lib/projectScriptsSchema.ts) instead of GOAT's
// script list with role flags, the env names are FHARA_*, and there are no legacy
// T3 env names, settings overrides or project-file fallback.

import { configuredProjectScript } from "@/api/convex/lib/projectScriptsSchema";

interface ProjectScriptRuntimeEnvInput {
  project: { cwd: string };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

/** Scripts run in the worktree when there is one, else in the project folder. */
export function projectScriptCwd(input: { project: { cwd: string }; worktreePath?: string | null }): string {
  return input.worktreePath ?? input.project.cwd;
}

/** The two paths a script may need, on top of the scrubbed child env. */
export function projectScriptRuntimeEnv(input: ProjectScriptRuntimeEnvInput): Record<string, string> {
  const env: Record<string, string> = { FHARA_PROJECT_ROOT: input.project.cwd };
  if (input.worktreePath) env.FHARA_WORKTREE_PATH = input.worktreePath;
  return input.extraEnv ? { ...env, ...input.extraEnv } : env;
}

/** The script to run when a worktree is created, or null when none is configured. */
export function setupProjectScript(scripts: unknown): string[] | null {
  return configuredProjectScript(scripts, "setup");
}

/** The host check run after Done, or null when none is configured. */
export function checkProjectScript(scripts: unknown): string[] | null {
  return configuredProjectScript(scripts, "check");
}
