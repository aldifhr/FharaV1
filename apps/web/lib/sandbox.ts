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
 * pushed without an explicit approval. The guardrails below are instructions
 * in the brief — the enforced gate is supervised approval.
 */

export interface SandboxConfig {
  name: string;
  projectId: string;
  instruction: string;
  /** Fail the experiment if it touches production paths. */
  guardProduction: boolean;
  /** Never push anything outside the worktree. */
  guardPush: boolean;
  /** Advisory time box in minutes (shown in the brief only). */
  timeboxMinutes: number;
}

export const SANDBOX_PREFIX = "[Sandbox]";

export function defaultSandboxConfig(projectId = ""): SandboxConfig {
  return {
    name: "",
    projectId,
    instruction: "",
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
    `Sandbox experiment "${config.name.trim() || "Untitled experiment"}" (isolated from production, supervised mode).\n` +
    `Instruction: ${config.instruction.trim()}\n` +
    `Guardrails: ${guards.length ? guards.join("; ") + "." : "none."} ` +
    `Advisory time box: ${config.timeboxMinutes} minutes.\n` +
    `Everything you change stays in this worktree until a human approves it.`
  );
}

export function validateSandbox(config: SandboxConfig): string[] {
  const issues: string[] = [];
  if (!config.projectId) issues.push("Pick a project.");
  if (!config.instruction.trim()) issues.push("Describe what the experiment should try.");
  if (!config.name.trim()) issues.push("Give the experiment a name.");
  if (sandboxCommand(config).length > 4000) {
    issues.push("Instruction is too long — the dispatched command would exceed 4000 characters.");
  }
  return issues;
}
