/**
 * L1: role × operation table for OpenCode runs.
 *
 * Table shape and `decideToolAccess` (default deny for an unknown role or
 * operation) are copied from opencode-agent-orchestration-kit
 * `opencode/scripts/runtime-permission-policy.mjs` (Apache-2.0; see
 * THIRD_PARTY_NOTICES.md). Modified by Fhara: the agent ids are Fhara's live
 * roles, the values mirror `ROLES[k].permissions`
 * (apps/api/convex/lib/roles.ts) with no "ask" (OpenCode runs unattended),
 * and `delegate` is a plain decision because Fhara never lets OpenCode
 * spawn sub-agents.
 */
import type { RoleKey } from "@/api/convex/lib/roles";

/**
 * It is a second, independent statement of the role limits: the CTO gets no
 * shell or network through OpenCode; Frontend and Backend write, and QA runs
 * verification commands. Retired roles are refused by default.
 */

export type PolicyDecision = "allow" | "deny";

export const POLICY_OPERATIONS = Object.freeze([
  "read",
  "write",
  "shell",
  "network",
  "commit",
  "push",
  "deploy",
  "delegate",
] as const);
export type PolicyOperation = (typeof POLICY_OPERATIONS)[number];

const common = {
  read: "allow",
  commit: "deny",
  push: "deny",
  deploy: "deny",
  delegate: "deny",
} as const;

/** `write: "allow"` still means "inside the subtask's allowedPaths / the role's write globs". */
export const ROLE_OPERATION_POLICY: Readonly<Record<RoleKey, Readonly<Record<PolicyOperation, PolicyDecision>>>> = Object.freeze({
  cto: Object.freeze({ ...common, write: "deny", shell: "deny", network: "deny" }),
  frontend: Object.freeze({ ...common, write: "allow", shell: "allow", network: "deny" }),
  backend: Object.freeze({ ...common, write: "allow", shell: "allow", network: "deny" }),
  qa: Object.freeze({ ...common, write: "deny", shell: "allow", network: "deny" }),
  designer: Object.freeze({ ...common, write: "deny", shell: "deny", network: "deny" }),
});

/**
 * No live role is path-limited by the table itself: Frontend and Backend
 * write code, QA is read-only, and the CTO and Designer are read-only.
 * Retired roles have no policy row and are refused by `decideToolAccess`.
 */
export const ROLE_WRITE_SCOPE: Readonly<Partial<Record<RoleKey, readonly string[]>>> = Object.freeze({});

/** Default deny: an unknown role or operation is never allowed. */
export function decideToolAccess(input: { roleKey?: string | null; operation?: string }): PolicyDecision {
  const policy = input.roleKey ? (ROLE_OPERATION_POLICY as Record<string, Record<string, PolicyDecision>>)[input.roleKey] : undefined;
  if (!policy || !POLICY_OPERATIONS.includes(input.operation as PolicyOperation)) return "deny";
  return policy[input.operation as PolicyOperation] === "allow" ? "allow" : "deny";
}
