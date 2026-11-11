/**
 * Orchestrator/CTO split O2: the Response Owner and the code-only gates.
 *
 * The Response Owner (RO) is the role that reports the task's outcome. It is
 * chosen deterministically from the plan, never by an LLM:
 *  1. Gate nodes (review, qa, the CTO `arch-decision`) are set aside.
 *  2. The role owning the most remaining nodes wins, `code_change` nodes
 *     counting double; a tie goes to the role of the earliest such node.
 *  3. A plan made only of gate nodes ("Review PR #12") is owned by the
 *     first gate's role.
 * A bug fix is therefore reported by the implementing role (Frontend), with
 * the QA evidence inside the report text.
 *
 * QA and Reviewer only gate code: a plan with no code-changing node (docs,
 * research, chat, commands; a Support README edit is a docs change) drops
 * its review/qa nodes, unless they are the whole plan.
 */
import { CAPABILITY, type AgentDefinition, type ExecutionPlan, type PlanSubtask } from "@/types";
import { ARCH_DECISION_KEY } from "@/api/convex/lib/architectureFlag";
import { canWritePath, ROLES, ROLE_KEYS, type RoleKey } from "@/api/convex/lib/roles";
import { normalizeCapability } from "@/utils/agentCapabilities";
import { resolveRoleKey } from "@/utils/rolePolicy";
import { routeCapability } from "./capabilities";

const GATE_KINDS = new Set<PlanSubtask["kind"]>(["review", "qa"]);

export function isGateNode(subtask: Pick<PlanSubtask, "key" | "kind">): boolean {
  return GATE_KINDS.has(subtask.kind) || subtask.key === ARCH_DECISION_KEY;
}

/** Default owner of a capability on the fixed team (no roster at hand). */
function defaultRoleFor(capability: string | undefined): RoleKey | null {
  if (typeof capability !== "string" || !capability.trim()) return null;
  const normalized = normalizeCapability(capability);
  return ROLE_KEYS.find((key) => ROLES[key].capabilities.includes(normalized)) ?? null;
}

/** The role a node routes to: the roster's owner when given, else the fixed-team default. */
export function roleForSubtask(subtask: Pick<PlanSubtask, "capability">, agents?: AgentDefinition[]): string | null {
  if (typeof subtask.capability !== "string" || !subtask.capability.trim()) return null;
  if (agents && agents.length > 0) {
    const agent = routeCapability(subtask.capability, agents);
    if (agent) return resolveRoleKey(agent.role ?? "") ?? (agent.role ?? "").trim().toLowerCase() ?? null;
  }
  return defaultRoleFor(subtask.capability);
}

/** The plan's Response Owner role, or null when no node maps to a role. */
export function pickResponseOwner(plan: Pick<ExecutionPlan, "subtasks">, agents?: AgentDefinition[]): string | null {
  const ordered = plan.subtasks.slice().sort((a, b) => a.order - b.order);
  const work = ordered.filter((subtask) => !isGateNode(subtask));
  const pool = work.length > 0 ? work : ordered;
  const score = new Map<string, { points: number; first: number }>();
  pool.forEach((subtask, index) => {
    const role = roleForSubtask(subtask, agents);
    if (!role) return;
    const entry = score.get(role) ?? { points: 0, first: index };
    entry.points += subtask.kind === "code_change" ? 2 : 1;
    score.set(role, entry);
  });
  let best: { role: string; points: number; first: number } | null = null;
  for (const [role, entry] of score) {
    if (!best || entry.points > best.points || (entry.points === best.points && entry.first < best.first)) {
      best = { role, ...entry };
    }
  }
  return best?.role ?? null;
}

/** The enabled agent that speaks for the RO role (first by priority), or undefined. */
export function responseOwnerAgent<A extends Pick<AgentDefinition, "_id" | "role" | "isEnabled" | "priority">>(
  role: string | null | undefined,
  agents: readonly A[]
): A | undefined {
  if (!role) return undefined;
  return agents
    .filter((agent) => agent.isEnabled !== false && (resolveRoleKey(agent.role ?? "") ?? agent.role?.trim().toLowerCase()) === role)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
}

/**
 * Whether a node changes code. A `code_change` that only writes docs (the
 * documentation capability, or every allowed path Markdown / docs/**) is a
 * docs change: it gets no QA or review.
 */
export function changesCode(subtask: Pick<PlanSubtask, "kind" | "capability" | "allowedPaths">): boolean {
  if (subtask.kind !== "code_change") return false;
  if (normalizeCapability(subtask.capability ?? "") === CAPABILITY.DOCUMENTATION) return false;
  const paths = subtask.allowedPaths ?? [];
  return !(paths.length > 0 && paths.every((path) => canWritePath(DOCS_ONLY, path)));
}

const DOCS_ONLY = ROLES.support.permissions;

/**
 * Drops review/qa nodes from a plan that changes no code (and keeps a plan
 * that is only gates). Dependencies on dropped nodes are removed.
 */
export function stripNonCodeGates(plan: ExecutionPlan): { plan: ExecutionPlan; dropped: string[] } {
  if (plan.subtasks.some(changesCode)) return { plan, dropped: [] };
  const gates = plan.subtasks.filter((subtask) => GATE_KINDS.has(subtask.kind));
  if (gates.length === 0 || gates.length === plan.subtasks.length) return { plan, dropped: [] };
  const dropped = new Set(gates.map((subtask) => subtask.key));
  return {
    dropped: [...dropped],
    plan: {
      ...plan,
      visualQa: undefined,
      subtasks: plan.subtasks
        .filter((subtask) => !dropped.has(subtask.key))
        .map((subtask, index) => ({
          ...subtask,
          dependencies: subtask.dependencies.filter((dep) => !dropped.has(dep)),
          order: index,
        })),
    },
  };
}

/** QA/Reviewer skip note (plan notes and the System line). */
export const GATES_SKIPPED_NOTE = "QA and review skipped: no code changes";

/** Final planner step: code-only gates, then the Response Owner on the plan. */
export function finishPlanOwnership(plan: ExecutionPlan, agents: AgentDefinition[], notes: string[] = []): ExecutionPlan {
  const { plan: gated, dropped } = stripNonCodeGates(plan);
  if (dropped.length > 0) notes.push(`${GATES_SKIPPED_NOTE} (${dropped.join(", ")})`);
  const owner = pickResponseOwner(gated, agents);
  return {
    ...gated,
    ...(dropped.length > 0 ? { gatesSkipped: true } : {}),
    ...(owner ? { responseOwner: owner } : {}),
  };
}
