/** The allowlisted shell commands, as shown to the shell agent. */
export const SHELL_REGISTRY_LIST = [
  "Allowlisted commands:",
  "git status, git status --short, git status -sb, git branch --show-current,",
  "git diff, git diff --no-color, git diff --stat, git log --oneline -n 20,",
  "git fetch, git pull, git pull --ff-only, git pull --rebase",
].join("\n");

/** Instruction for the allowlisted shell agent (single JSON argv reply). */
export function shellInstruction(): string {
  return [
    "Reply with a single-line JSON object for the shell command to run:",
    '{"command":"<binary>","args":[<exact argv>]}',
    "",
    SHELL_REGISTRY_LIST,
    "Rules:",
    "- Only run the command the user asked for. Prefer the narrowest variant.",
    "- If the user request needs a command outside the allowlist (including",
    "  file creation / write / printf / redirect), do NOT invent argv and",
    "  do NOT delegate to shell-execution (that is yourself — a loop).",
    "  Reply with a plain one-line explanation; the orchestrator will replan",
    "  as code_change.",
  ].join("\n");
}

/** User content of the shell call. */
export function shellUserContent(instruction: string, command: string): string {
  return `${instruction}\n\nTask: ${command}`;
}
