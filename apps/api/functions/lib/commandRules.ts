/**
 * Command approval policy for agent-initiated shell commands
 * (`run_command` approvals). Pure and shared by the backend (which decides
 * and re-checks), the worker (local pre-check) and the web UI (whether the
 * card may show "Always allow").
 *
 * Order of checks, strictest first:
 * 1. The worker's exact-argv allowlist (`tools/runCommand.ts`) is a hard
 *    deny before any of this runs. A rule here never widens it.
 * 2. Dangerous or push-like commands always ask and never offer
 *    "Always allow", in every permission mode.
 * 3. A project "Always allow" rule whose head matches approves silently.
 * 4. Full access approves; Supervised and Auto-accept edits ask.
 *
 * A rule is the normalized command HEAD ("npm run test", "git status"),
 * never the full argument list and never a user-written pattern. Matching
 * compares head tokens for equality, not string prefixes, so the rule
 * "npm run test" does not match "npm run test-e2e".
 *
 * Plan 041: an "exact" entry is narrower than a head rule: the literal
 * program string plus the literal argument array. Only the identical argv
 * matches; dangerous / push-like commands never match one (step 2 above
 * runs first), and the worker allowlist (step 1) is untouched.
 */
import type { PermissionMode } from "./permissionModes";

export interface CommandAllowRule {
  prefix: string;
  createdAt: number;
  createdBy: string;
}

export type CommandDecision = "allow" | "always" | "always_exact" | "deny";

/** Plan 041: one "always allow this exact command" entry (literal argv). */
export interface CommandAllowExact {
  command: string;
  args: string[];
  createdAt: number;
  createdBy: string;
}

/** Most rules a project keeps; the oldest drop off past this. */
export const MAX_COMMAND_ALLOW_RULES = 50;

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const NPM_TEST_ALIASES = new Set(["test", "t", "tst"]);

/** `"/usr/bin/git"` → `"git"`, `"npm.cmd"` → `"npm"`, lowercased. */
function programName(command: string): string {
  const base = command.trim().split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(cmd|bat|exe)$/i, "").toLowerCase();
}

const isFlag = (arg: string) => arg.startsWith("-");

/**
 * The command head a rule is keyed on: the program plus its subcommand
 * ("git status", "npx tsc", "npm run lint"). `npm test` and `npm run test`
 * share one head. Flags and paths are never part of the head.
 */
export function commandHead(command: string, args: readonly string[] = []): string {
  const program = programName(command);
  if (!program) return "";
  const rest = args.map((a) => a.trim()).filter(Boolean);
  if (PACKAGE_MANAGERS.has(program)) {
    const sub = rest[0];
    if (!sub || isFlag(sub)) return program;
    if (sub === "run" || sub === "run-script") {
      const script = rest[1];
      return script && !isFlag(script) ? `${program} run ${script}` : `${program} run`;
    }
    if (NPM_TEST_ALIASES.has(sub)) return `${program} run test`;
    return `${program} ${sub}`;
  }
  const sub = rest[0];
  if (!sub || isFlag(sub) || /[\\/]/.test(sub)) return program;
  return `${program} ${sub.toLowerCase()}`;
}

/** Normalize a stored or typed rule prefix the same way as a head. */
export function normalizeRulePrefix(prefix: string): string {
  const tokens = prefix.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  return commandHead(tokens[0], tokens.slice(1));
}

/** One printable line for a command (shown in the approval card). */
export function formatCommand(command: string, args: readonly string[] = []): string {
  return [command, ...args].map((part) => (/[\s"'`$]/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

const SHELL_CONTROL = /[;&|`<>]|\$\(/;
const PIPE_TO_SHELL = /\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/;
const PRIVILEGE = new Set(["sudo", "su", "doas", "pkexec"]);
const ALWAYS_DANGEROUS = new Set(["mkfs", "dd", "shutdown", "reboot", "halt", "poweroff", "kill", "killall", "pkill"]);

function hasRecursiveFlag(args: readonly string[]): boolean {
  return args.some((a) => a === "--recursive" || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a));
}

function escapesWorkspace(arg: string, workspaceRoot?: string): boolean {
  const value = arg.includes("=") && !arg.startsWith("/") ? arg.slice(arg.indexOf("=") + 1) : arg;
  if (!value) return false;
  if (value.startsWith("~")) return true;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) return true;
  const absolute = value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value);
  if (!absolute) return false;
  if (!workspaceRoot) return true;
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  return !(value === root || value.startsWith(`${root}/`) || value.startsWith(`${root}\\`));
}

/**
 * Why a command must always ask (and never offer "Always allow"), or null
 * when it is an ordinary command. Push-like commands count as dangerous.
 */
export function dangerousCommandReason(
  command: string,
  args: readonly string[] = [],
  workspaceRoot?: string
): string | null {
  const program = programName(command);
  const line = [command, ...args].join(" ");
  if (PRIVILEGE.has(program) || args.some((a) => PRIVILEGE.has(a.trim().toLowerCase()))) return "Runs with elevated privileges";
  if (PIPE_TO_SHELL.test(line)) return "Pipes a download or text into a shell";
  if (["sh", "bash", "zsh", "dash", "ksh"].includes(program) && args.some((a) => a === "-c")) return "Runs an inline shell script";
  if (args.some((a) => SHELL_CONTROL.test(a))) return "Contains shell control characters";
  if (ALWAYS_DANGEROUS.has(program)) return "Destructive system command";
  if (program === "rm" && (hasRecursiveFlag(args) || args.some((a) => /^-[a-zA-Z]*f/.test(a) || a === "--force"))) {
    return "Deletes files recursively or by force";
  }
  if ((program === "chmod" || program === "chown" || program === "chgrp") && hasRecursiveFlag(args)) {
    return "Changes permissions recursively";
  }
  if (program === "git") {
    const sub = (args.find((a) => !isFlag(a)) ?? "").toLowerCase();
    if (sub === "push") return "Pushes to a remote";
    if (sub === "reset" && args.includes("--hard")) return "Discards local changes (git reset --hard)";
    if (sub === "clean") return "Deletes untracked files (git clean)";
    if (sub === "branch" && args.some((a) => a === "-D" || a === "--delete")) return "Deletes a branch";
    if (args.some((a) => a === "--force" || a === "-f" || a.startsWith("--force-with-lease"))) return "Forced git operation";
  }
  if (program === "gh" && args[0] === "pr" && args[1] === "merge") return "Merges a pull request";
  if (args.some((a) => escapesWorkspace(a, workspaceRoot))) return "Touches a path outside the workspace";
  return null;
}

/** The project rule that covers this command, if any. Dangerous commands never match. */
export function matchCommandAllowRule(
  rules: readonly CommandAllowRule[] | undefined,
  command: string,
  args: readonly string[] = [],
  workspaceRoot?: string
): CommandAllowRule | null {
  if (!rules?.length) return null;
  if (dangerousCommandReason(command, args, workspaceRoot)) return null;
  const head = commandHead(command, args);
  if (!head) return null;
  return rules.find((rule) => normalizeRulePrefix(rule.prefix) === head) ?? null;
}

/** Same literal argv (no trimming, no normalisation, same order and count). */
function sameArgv(entry: { command: string; args: readonly string[] }, command: string, args: readonly string[]): boolean {
  return entry.command === command && entry.args.length === args.length && entry.args.every((arg, i) => arg === args[i]);
}

/** Plan 041: the exact entry for this argv, if any. Dangerous commands never match. */
export function matchCommandAllowExact(
  entries: readonly CommandAllowExact[] | undefined,
  command: string,
  args: readonly string[] = [],
  workspaceRoot?: string
): CommandAllowExact | null {
  if (!entries?.length) return null;
  if (dangerousCommandReason(command, args, workspaceRoot)) return null;
  return entries.find((entry) => sameArgv(entry, command, args)) ?? null;
}

export interface CommandApprovalPolicy {
  /** "auto": approve without a pause (still recorded); "ask": wait for the user. */
  action: "auto" | "ask";
  reason: string;
  /** Whether the card may offer "Always allow". */
  offerAlways: boolean;
  head: string;
  danger: string | null;
  rule?: CommandAllowRule;
  /** Plan 041: the exact entry that approved it. */
  exact?: CommandAllowExact;
}

/** Policy for one agent-initiated command under the task's permission mode. */
export function commandApprovalPolicy(input: {
  mode: PermissionMode;
  command: string;
  args?: readonly string[];
  rules?: readonly CommandAllowRule[];
  /** Plan 041: the project's exact entries. */
  exact?: readonly CommandAllowExact[];
  workspaceRoot?: string;
}): CommandApprovalPolicy {
  const args = input.args ?? [];
  const head = commandHead(input.command, args);
  const danger = dangerousCommandReason(input.command, args, input.workspaceRoot);
  if (danger) return { action: "ask", reason: danger, offerAlways: false, head, danger };
  const exact = matchCommandAllowExact(input.exact, input.command, args, input.workspaceRoot);
  if (exact) {
    return { action: "auto", reason: `Always allowed (exact): ${formatCommand(exact.command, exact.args)}`, offerAlways: true, head, danger, exact };
  }
  const rule = matchCommandAllowRule(input.rules, input.command, args, input.workspaceRoot);
  if (rule) return { action: "auto", reason: `Always allowed: ${normalizeRulePrefix(rule.prefix)}`, offerAlways: true, head, danger, rule };
  if (input.mode === "full_access") return { action: "auto", reason: "Full access", offerAlways: true, head, danger };
  return {
    action: "ask",
    reason: input.mode === "auto_edits" ? "Auto-accept edits still asks for commands" : "Supervised mode asks for every command",
    offerAlways: Boolean(head),
    head,
    danger,
  };
}

/**
 * Server-side downgrade: "always" only counts when the card offered it.
 * A client that sends "always" for a card that did not offer it gets a
 * one-time allow.
 */
export function effectiveCommandDecision(decision: CommandDecision, offerAlways: boolean | undefined): CommandDecision {
  return (decision === "always" || decision === "always_exact") && offerAlways !== true ? "allow" : decision;
}

/** Add a rule (deduped by normalized head, newest kept, capped). */
export function addCommandAllowRule(
  rules: readonly CommandAllowRule[] | undefined,
  prefix: string,
  createdBy: string,
  now: number
): CommandAllowRule[] {
  const head = normalizeRulePrefix(prefix);
  const kept = (rules ?? []).filter((rule) => normalizeRulePrefix(rule.prefix) !== head);
  const next = [...kept, { prefix: head, createdAt: now, createdBy }];
  return next.slice(-MAX_COMMAND_ALLOW_RULES);
}

/** Plan 041: add an exact entry (deduped by argv, newest kept, capped). */
export function addCommandAllowExact(
  entries: readonly CommandAllowExact[] | undefined,
  command: string,
  args: readonly string[],
  createdBy: string,
  now: number
): CommandAllowExact[] {
  const kept = (entries ?? []).filter((entry) => !sameArgv(entry, command, args));
  return [...kept, { command, args: [...args], createdAt: now, createdBy }].slice(-MAX_COMMAND_ALLOW_RULES);
}

/** Plan 041: drop the entry for this argv (unchanged list when absent). */
export function removeCommandAllowExact(
  entries: readonly CommandAllowExact[] | undefined,
  command: string,
  args: readonly string[]
): CommandAllowExact[] {
  return (entries ?? []).filter((entry) => !sameArgv(entry, command, args));
}
