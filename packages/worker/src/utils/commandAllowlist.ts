/**
 * The single source of truth for the commands the worker may run for an
 * agent: `tools/runCommand.ts` enforces it, the shell agent's prompt
 * (`prompts/shell.ts`) lists it, and the classifier maps "run the tests" /
 * "jalankan tes" onto it. Pure (no Node APIs) so every layer can read it.
 *
 * Exact argv allowlist. Substring/prefix allowlisting is unsafe because
 * `npm run test; rm -rf /` or `git status --short` would pass a prefix check.
 * Every element must match exactly (after trimming).
 */
export const ALLOWED_ARGV: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>> = {
  npm: [["run", "test"], ["run", "build"], ["run", "typecheck"]],
  npx: [["tsc", "--noEmit"]],
  git: [
    ["status"],
    ["status", "--short"],
    ["status", "-sb"],
    ["branch", "--show-current"],
    ["diff"],
    ["diff", "--no-color"],
    ["diff", "--stat"],
    ["log", "--oneline", "-n", "20"],
    ["fetch"],
    ["pull"],
    ["pull", "--ff-only"],
    ["pull", "--rebase"],
  ],
  node: [["--version"]],
};

export function isCommandAllowed(command: string, args: string[]): boolean {
  const allowed = ALLOWED_ARGV[command];
  if (!allowed) return false;
  if (args.some((arg) => /[\u0000-\u001f]/.test(arg))) return false;
  return allowed.some(
    (candidate) =>
      candidate.length === args.length &&
      candidate.every((value, index) => value === args[index])
  );
}

/** Every allowlisted command line ("npm run test", "git status", ...), in allowlist order. */
export function allowedCommandLines(): string[] {
  return Object.entries(ALLOWED_ARGV).flatMap(([command, variants]) =>
    variants.map((args) => [command, ...args].join(" "))
  );
}

/** Split an allowlisted command line back into argv; null when it is not allowlisted. */
export function parseAllowedCommandLine(line: string): { command: string; args: string[] } | null {
  const [command, ...args] = line.trim().split(/\s+/);
  if (!command || !isCommandAllowed(command, args)) return null;
  return { command, args };
}
