/**
 * O1: per-run, deny-by-default OpenCode permissions.
 *
 * The static rule set this replaces allowed every shell command except
 * `git push` / `git remote` and had no edit rule at all, so an OpenCode run
 * could edit any file in the worktree and read credential files with
 * `cat`. `buildOpencodePolicy` derives the rules for ONE run from the
 * agent's role permissions (apps/api/convex/lib/roles.ts) and the subtask's
 * ownership scope (`allowedPaths`):
 *
 *  - `edit` (OpenCode's write/edit/patch tools): denied unless the subtask
 *    mutates, the role may write, and the path is inside `allowedPaths`
 *    (and inside the role's own write globs for a path-scoped role).
 *  - `read`: allowed in the worktree except credential-shaped files.
 *  - `bash`: none → deny all; verify → only test/typecheck/build/read-only
 *    git; allowlist → allowed, minus credential and exfil commands.
 *  - `webfetch` / `websearch`: only for a role with web access (Researcher).
 *
 * OpenCode evaluates permission rules with "last matching rule wins"
 * (core/src/permission.ts `evaluate` uses findLast), so every map starts
 * with its `"*"` default and ends with the denies that must always hold.
 *
 * Written from scratch for Fhara. The sensitive-path list restates
 * well-known credential locations; it is not copied from any source.
 */
import type { RolePermissions } from "@/api/convex/lib/roles";

export type OpencodeAction = "allow" | "deny" | "ask";
export type OpencodeRuleMap = Record<string, OpencodeAction>;

export interface OpencodePolicy {
  external_directory: OpencodeAction;
  question: OpencodeAction;
  doom_loop: OpencodeAction;
  read: OpencodeRuleMap;
  edit: OpencodeRuleMap;
  bash: OpencodeRuleMap;
  webfetch: OpencodeAction;
  websearch: OpencodeAction;
  task: OpencodeAction;
}

/**
 * Files no role may read or edit through OpenCode's file tools: the git
 * dir, env files, keys, OpenCode's own config and auth store, and anything
 * credential-shaped. Globs are matched against the worktree-relative path
 * OpenCode resolves (absolute for external paths, which
 * `external_directory: deny` already refuses).
 */
export const SENSITIVE_PATH_GLOBS: readonly string[] = [
  ".git",
  ".git/*",
  "*/.git/*",
  ".opencode",
  ".opencode/*",
  "*/.opencode/*",
  "opencode.json",
  "opencode.jsonc",
  "*/opencode.json",
  "*/opencode.jsonc",
  ".env",
  "*.env",
  ".env.*",
  "*/.env.*",
  "*.env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*id_rsa*",
  "*id_ed25519*",
  "*id_ecdsa*",
  "*.ssh/*",
  "*credentials*",
  "*auth.json",
  "*.netrc",
  "*.npmrc",
  "*.git-credentials",
  "*/gh/hosts.yml",
];

/** `.env.example` stays readable (documents the variables, no values). */
const READ_EXCEPTIONS: readonly string[] = [".env.example", "*/.env.example"];

/**
 * Shell commands no role may run, whatever its shell permission. Patterns
 * are OpenCode wildcards over the command string. They block pushing and
 * remote changes (the runner pushes), the GitHub CLI, dumping the env, and
 * touching credential stores by path. Defense in depth only: the scoped
 * HOME (childEnv.scopedHome) is what keeps the real files out of reach.
 */
export const BASH_DENY_PATTERNS: readonly string[] = [
  "git push*",
  "git remote*",
  "git config --global*",
  "git credential*",
  "gh",
  "gh *",
  "printenv",
  "printenv *",
  "env",
  "env *",
  "export",
  "set",
  "ssh *",
  "scp *",
  "ssh-add*",
  "ssh-agent*",
  "curl * -d*",
  "curl * --data*",
  "curl * -F*",
  "curl * --form*",
  "curl * -T*",
  "curl * --upload-file*",
  "wget * --post*",
  "*.ssh/*",
  "*.git-credentials*",
  "*.config/gh*",
  "*gh/hosts.yml*",
  "*auth.json*",
  "*.config/opencode*",
  "*.local/share/opencode*",
  "*.netrc*",
  "*.npmrc*",
  "*/proc/*/environ*",
];

/** Commands a "verify" shell role (QA) may run inside OpenCode. */
export const VERIFY_BASH_PATTERNS: readonly string[] = [
  "npm test*",
  "npm run test*",
  "npm run typecheck*",
  "npm run build*",
  "npm run lint*",
  "npx tsc*",
  "npx vitest*",
  "git status*",
  "git diff*",
  "git log*",
  "git show*",
  "git branch --show-current",
  "node --version",
];

export interface BuildOpencodePolicyInput {
  /** The role's enforced permissions (rolePolicy.permissionsForAgent). */
  permissions: RolePermissions;
  /** Subtask ownership scope; empty/undefined = the whole worktree. */
  allowedPaths?: readonly string[];
  /** Whether the subtask kind may change files at all (code_change/shell). */
  mutating: boolean;
}

/** `src/app` → `["src/app", "src/app/*"]` (OpenCode `*` spans `/`). */
function scopeGlobs(scope: string): string[] {
  const clean = scope.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!clean) return ["*"];
  // A glob scope (DevOps "Dockerfile*", ".github/**") is passed through,
  // with `**` folded into OpenCode's `*` (which already crosses `/`).
  if (/[*?]/.test(clean)) return [clean.replace(/\*\*\/?/g, "*")];
  return [clean, `${clean}/*`];
}

/** The `edit` rule map: deny by default, allow only the scoped globs. */
function editRules(input: BuildOpencodePolicyInput): OpencodeRuleMap {
  const rules: OpencodeRuleMap = { "*": "deny" };
  const write = input.permissions.write;
  if (input.mutating && write !== false) {
    const ownership = input.allowedPaths && input.allowedPaths.length > 0 ? [...input.allowedPaths] : null;
    const roleGlobs = Array.isArray(write) ? (write as readonly string[]) : null;
    let globs: string[];
    if (ownership && roleGlobs) {
      // Both apply: allow the ownership scope, and the staging gate (the
      // second line, agentExecutor) still reverts anything outside the
      // role's own globs. OpenCode cannot intersect two glob sets.
      globs = ownership.flatMap(scopeGlobs);
    } else if (ownership) {
      globs = ownership.flatMap(scopeGlobs);
    } else if (roleGlobs) {
      globs = roleGlobs.flatMap(scopeGlobs);
    } else {
      globs = ["*"];
    }
    for (const glob of globs) rules[glob] = "allow";
  }
  for (const glob of SENSITIVE_PATH_GLOBS) rules[glob] = "deny";
  return rules;
}

function readRules(): OpencodeRuleMap {
  const rules: OpencodeRuleMap = { "*": "allow" };
  for (const glob of SENSITIVE_PATH_GLOBS) rules[glob] = "deny";
  for (const glob of READ_EXCEPTIONS) rules[glob] = "allow";
  return rules;
}

function bashRules(permissions: RolePermissions): OpencodeRuleMap {
  const rules: OpencodeRuleMap = { "*": "deny" };
  if (permissions.shell === "allowlist") rules["*"] = "allow";
  else if (permissions.shell === "verify") for (const pattern of VERIFY_BASH_PATTERNS) rules[pattern] = "allow";
  for (const pattern of BASH_DENY_PATTERNS) rules[pattern] = "deny";
  return rules;
}

/**
 * The OpenCode `permission` block for one run. Pure; the same input always
 * gives the same rules (key order is part of the contract: last match wins).
 */
export function buildOpencodePolicy(input: BuildOpencodePolicyInput): OpencodePolicy {
  const web: OpencodeAction = input.permissions.web ? "allow" : "deny";
  return {
    external_directory: "deny",
    question: "deny",
    doom_loop: "deny",
    read: readRules(),
    edit: editRules(input),
    bash: bashRules(input.permissions),
    webfetch: web,
    websearch: web,
    // Sub-agents would inherit nothing of this scoping guarantee.
    task: "deny",
  };
}

/** Policy for calls with no role context (detection probe, tests). Read-only, no shell, no web. */
export const READ_ONLY_OPENCODE_POLICY: OpencodePolicy = buildOpencodePolicy({
  permissions: { read: true, write: false, shell: "none", web: false, push: false },
  mutating: false,
});

/** OpenCode's wildcard: `*` any run of chars (incl. `/`), `?` one char. Used by tests and the denial log. */
export function opencodeWildcardMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "s").test(value);
}

/** Evaluate a rule map the way OpenCode does (last match wins; default ask). */
export function evaluateOpencodeRule(rules: OpencodeRuleMap, value: string): OpencodeAction {
  let result: OpencodeAction = "ask";
  for (const [pattern, action] of Object.entries(rules)) {
    if (opencodeWildcardMatch(value, pattern)) result = action;
  }
  return result;
}
