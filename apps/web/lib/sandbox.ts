/**
 * Agent Sandbox model (frontend only).
 *
 * A sandbox experiment is a *task* created through the existing
 * `tasks.createFromCommand` path, but with the sandbox guardrails framing
 * it: the title is prefixed `[Sandbox]`, the command opens with an
 * isolation instruction, and the permission mode is forced to `supervised`
 * (every approval is asked). The worker still owns execution — this file
 * only shapes the brief and the preview.
 *
 * Honest limits (shown in the UI, not hidden): the sandbox does not get a
 * separate production database or network namespace; isolation here means
 * worktree-scoped changes, the supervised approval gate, and nothing being
 * pushed without an explicit approval.
 */

export type SandboxMode = "plan" | "dry-run" | "run";

export interface SandboxConfig {
  name: string;
  projectId: string;
  instruction: string;
  mode: SandboxMode;
  /** Fail the experiment if it touches production paths. */
  guardProduction: boolean;
  /** Never push anything outside the worktree. */
  guardPush: boolean;
  /** Time box in minutes (advisory — shown in the brief). */
  timeboxMinutes: number;
}

export const SANDBOX_PREFIX = "[Sandbox]";

export function defaultSandboxConfig(projectId = ""): SandboxConfig {
  return {
    name: "Untitled experiment",
    projectId,
    instruction: "",
    mode: "run",
    guardProduction: true,
    guardPush: true,
    timeboxMinutes: 30,
  };
}

/** The task command the sandbox will dispatch. */
export function sandboxCommand(config: SandboxConfig): string {
  const guards: string[] = [];
  if (config.guardProduction) guards.push("do not touch production code paths or secrets");
  if (config.guardPush) guards.push("never push to a remote or open a PR");
  return (
    `Sandbox experiment "${config.name}" (isolated from production, supervised mode).\n` +
    `Instruction: ${config.instruction}\n` +
    `Mode: ${config.mode}. ${guards.length ? `Guardrails: ${guards.join("; ")}.` : "No extra guardrails."} ` +
    `Advisory time box: ${config.timeboxMinutes} minutes.\n` +
    `Everything you change stays in this worktree until a human approves it.`
  );
}

/** Task command length limit, mirrored from `api.tasks.createFromCommand` (convex/tasks.ts). */
export const SANDBOX_COMMAND_MAX = 4000;

export function validateSandbox(config: SandboxConfig): string[] {
  const issues: string[] = [];
  if (!config.projectId) issues.push("Pick a project.");
  if (!config.instruction.trim()) issues.push("Describe what the experiment should try.");
  if (!config.name.trim()) issues.push("Give the experiment a name.");
  const preview = sandboxCommand(config);
  if (preview.length > SANDBOX_COMMAND_MAX) {
    issues.push(`The command preview is too long (${preview.length} chars; max ${SANDBOX_COMMAND_MAX}).`);
  }
  return issues;
}
