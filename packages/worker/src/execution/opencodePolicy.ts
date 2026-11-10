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
import { decideToolAccess } from "./opencodePermissions";

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
  /**
   * L1: the fixed role key (rolePolicy.resolveRoleKey), when the agent is
   * one of the nine. The role × operation table (opencodePermissions.ts)
   * can only take access away from `permissions`, never add it.
   */
  roleKey?: string | null;
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
  let permissions = input.permissions;
  if (input.roleKey) {
    const allowed = (operation: string) => decideToolAccess({ roleKey: input.roleKey, operation }) === "allow";
    permissions = {
      ...permissions,
      write: allowed("write") ? permissions.write : false,
      shell: allowed("shell") ? permissions.shell : "none",
      web: allowed("network") ? permissions.web : false,
    };
  }
  const web: OpencodeAction = permissions.web ? "allow" : "deny";
  return {
    external_directory: "deny",
    question: "deny",
    doom_loop: "deny",
    read: readRules(),
    edit: editRules({ ...input, permissions }),
    bash: bashRules(permissions),
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

// ── L1: layering and post-load check ──────────────────────────────────

/**
 * How OpenCode 1.19.5 (/workspace/work/bin/opencode) resolves permissions,
 * read from the shipped bundle and measured with `opencode debug config` /
 * `opencode debug agent` on 2026-11-11:
 *
 *  - Config layers load in this order: well-known remote, global
 *    (~/.config/opencode), OPENCODE_CONFIG, the worktree's opencode.json(c)
 *    (skipped with OPENCODE_DISABLE_PROJECT_CONFIG), `.opencode/` dirs (the
 *    worktree's skipped too) and OPENCODE_CONFIG_DIR, OPENCODE_CONFIG_CONTENT,
 *    org/account config, the managed dir (/etc/opencode), and finally the
 *    OPENCODE_PERMISSION env merged into `permission`.
 *  - The merge is a deep merge that KEEPS THE EARLIER LAYER'S KEY ORDER. A
 *    repo opencode.json with {"bash":{"git push*":"allow"}} turned Fhara's
 *    `{"*":"allow","git push*":"deny"}` into `{"git push*":"deny","*":"allow"}`
 *    and git push ran (last match wins), even though OPENCODE_CONFIG_CONTENT
 *    loads after the repo file. Loading "later" is not winning.
 *  - Agent rules are appended after every config-level rule (`debug agent`
 *    shows the flattened ruleset), so an agent's own `permission` is the last
 *    word. A repo may define `agent.build.permission` and loosen the built-in
 *    agent, so Fhara runs a per-run agent with an unguessable name
 *    (idea from agent-orchestrator's opencode adapter, Apache-2.0: it
 *    injects a session-scoped agent because "agent rules outrank every
 *    config layer"; re-written, no code copied).
 *  - `opencode run --auto` replies "once" to every `ask`; without it `run`
 *    auto-rejects every `ask`. Fhara no longer passes --auto.
 *
 * Fhara's stack, strongest first: per-run agent carrying the rules, the
 * project layer off, the same rules in OPENCODE_CONFIG_CONTENT and
 * OPENCODE_PERMISSION, external plugins off (a plugin can answer permission
 * prompts), no --auto, and `opencode debug agent <name>` checked against
 * the probes below before every run (fail closed).
 */

/** Tools OpenCode needs that carry no risk of their own (read-side, local). */
export const OPENCODE_SAFE_TOOLS: readonly string[] = ["glob", "grep", "list", "lsp", "todowrite", "todoread", "skill"];

export type OpencodePermissionBlock = Record<string, OpencodeAction | OpencodeRuleMap>;

/**
 * The `permission` block actually sent: deny every permission first (pattern
 * from codex-opencode-orchestrator's worker policy, re-written), then the
 * safe local tools, then the policy. A new OpenCode tool is denied until
 * Fhara lists it. `codesearch` is network (Exa) and follows webfetch.
 */
export function opencodePermissionBlock(policy: OpencodePolicy): OpencodePermissionBlock {
  const block: OpencodePermissionBlock = { "*": "deny" };
  for (const tool of OPENCODE_SAFE_TOOLS) block[tool] = "allow";
  block.codesearch = policy.webfetch;
  for (const [key, value] of Object.entries(policy)) block[key] = value as OpencodeAction | OpencodeRuleMap;
  return block;
}

/** One row of OpenCode's flattened ruleset (`opencode debug agent <name>`). */
export interface OpencodeRuleRow {
  permission: string;
  pattern: string;
  action: OpencodeAction;
}

/** A permission block → OpenCode's flattened rows, in order. */
export function flattenPermissionBlock(block: unknown): OpencodeRuleRow[] {
  if (block === "allow" || block === "deny" || block === "ask") return [{ permission: "*", pattern: "*", action: block }];
  if (!block || typeof block !== "object" || Array.isArray(block)) return [];
  const rows: OpencodeRuleRow[] = [];
  for (const [permission, value] of Object.entries(block as Record<string, unknown>)) {
    if (value === "allow" || value === "deny" || value === "ask") rows.push({ permission, pattern: "*", action: value });
    else if (value && typeof value === "object" && !Array.isArray(value))
      for (const [pattern, action] of Object.entries(value as Record<string, unknown>))
        if (action === "allow" || action === "deny" || action === "ask") rows.push({ permission, pattern, action });
  }
  return rows;
}

/** Evaluate rows as OpenCode does: last row whose permission and pattern match wins; none → ask. */
export function evaluateOpencodeRuleset(rows: readonly OpencodeRuleRow[], permission: string, value: string): OpencodeAction {
  let result: OpencodeAction = "ask";
  for (const row of rows) {
    if (opencodeWildcardMatch(permission, row.permission) && opencodeWildcardMatch(value, row.pattern)) result = row.action;
  }
  return result;
}

/** Parse the `permission` rows out of `opencode debug agent` output; null when absent. */
export function parseRuleRows(value: unknown): OpencodeRuleRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: OpencodeRuleRow[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") return null;
    const r = row as Record<string, unknown>;
    if (typeof r.permission !== "string" || typeof r.pattern !== "string") return null;
    if (r.action !== "allow" && r.action !== "deny" && r.action !== "ask") return null;
    rows.push({ permission: r.permission, pattern: r.pattern, action: r.action });
  }
  return rows;
}

/** Probes the loaded rules must answer at least as strictly as Fhara's block. */
export const POLICY_PROBES: ReadonlyArray<{ key: string; value: string }> = [
  { key: "bash", value: "git push origin main" },
  { key: "bash", value: "git push --force" },
  { key: "bash", value: "git remote add x https://example.com/x.git" },
  { key: "bash", value: "gh auth token" },
  { key: "bash", value: "gh pr merge 1" },
  { key: "bash", value: "printenv" },
  { key: "bash", value: "cat ~/.ssh/id_rsa" },
  { key: "bash", value: "ls" },
  { key: "bash", value: "npm run test" },
  { key: "edit", value: ".env" },
  { key: "edit", value: ".git/config" },
  { key: "edit", value: "opencode.json" },
  { key: "edit", value: ".opencode/agent/build.md" },
  { key: "edit", value: "src/index.ts" },
  { key: "read", value: ".env" },
  { key: "read", value: ".git/config" },
  { key: "read", value: "src/index.ts" },
  { key: "external_directory", value: "/etc/passwd" },
  { key: "external_directory", value: "../other-repo/x" },
  { key: "webfetch", value: "https://example.com" },
  { key: "websearch", value: "query" },
  { key: "codesearch", value: "query" },
  { key: "task", value: "general" },
  { key: "question", value: "*" },
  { key: "doom_loop", value: "*" },
  { key: "some_future_tool", value: "*" },
];

/**
 * Null when `loaded` answers every probe at least as strictly as Fhara's
 * block, else the first difference. "ask" counts as looser than "deny"
 * (with --auto it would run). Stricter answers are fine.
 */
export function rulesetPolicyViolation(policy: OpencodePolicy, loaded: readonly OpencodeRuleRow[]): string | null {
  const ours = flattenPermissionBlock(opencodePermissionBlock(policy));
  for (const probe of POLICY_PROBES) {
    const want = evaluateOpencodeRuleset(ours, probe.key, probe.value);
    const got = evaluateOpencodeRuleset(loaded, probe.key, probe.value);
    if (want === "deny" && got !== "deny") return `${probe.key} "${probe.value}" is "${got}" in the loaded rules, Fhara requires "deny"`;
  }
  return null;
}

/** Same check against a config-shaped `permission` block (`opencode debug config`). */
export function mergedPolicyViolation(policy: OpencodePolicy, merged: unknown): string | null {
  return rulesetPolicyViolation(policy, flattenPermissionBlock(merged));
}
