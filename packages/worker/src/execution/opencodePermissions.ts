/**
 * L1: role × operation table for OpenCode runs.
 *
 * Table shape and `decideToolAccess` (default deny for an unknown role or
 * operation) are copied from opencode-agent-orchestration-kit
 * `opencode/scripts/runtime-permission-policy.mjs` (Apache-2.0; see
 * THIRD_PARTY_NOTICES.md). Modified by Fhara: the agent ids are Fhara's
 * nine fixed roles, the values mirror `ROLES[k].permissions`
 * (apps/api/convex/lib/roles.ts) with no "ask" (OpenCode runs unattended),
 * and `delegate` is a plain decision because Fhara never lets OpenCode
 * spawn sub-agents.
 *
 * It is a second, independent statement of the role limits: CTO, Designer,
 * Reviewer, Support and Researcher get no shell through OpenCode, and only
 * the Researcher gets the network, even if a role row's permissions drift.
 */
import type { RoleKey } from "@/api/convex/lib/roles";

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
  designer: Object.freeze({ ...common, write: "deny", shell: "deny", network: "deny" }),
  frontend: Object.freeze({ ...common, write: "allow", shell: "allow", network: "deny" }),
  backend: Object.freeze({ ...common, write: "allow", shell: "allow", network: "deny" }),
  qa: Object.freeze({ ...common, write: "deny", shell: "allow", network: "deny" }),
  reviewer: Object.freeze({ ...common, write: "deny", shell: "deny", network: "deny" }),
  devops: Object.freeze({ ...common, write: "allow", shell: "allow", network: "deny" }),
  support: Object.freeze({ ...common, write: "deny", shell: "deny", network: "deny" }),
  researcher: Object.freeze({ ...common, write: "deny", shell: "deny", network: "allow" }),
});

/** Default deny: an unknown role or operation is never allowed. */
export function decideToolAccess(input: { roleKey?: string | null; operation?: string }): PolicyDecision {
  const policy = input.roleKey ? (ROLE_OPERATION_POLICY as Record<string, Record<string, PolicyDecision>>)[input.roleKey] : undefined;
  if (!policy || !POLICY_OPERATIONS.includes(input.operation as PolicyOperation)) return "deny";
  return policy[input.operation as PolicyOperation] === "allow" ? "allow" : "deny";
}
