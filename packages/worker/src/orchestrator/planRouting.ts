/**
 * Plan routing passes moved out of planner.ts (its line budget): the
 * architecture gate + Response Owner, and dropping/blocking the nodes no
 * enabled agent can serve.
 */
import type { AgentDefinition, ExecutionPlan } from "@/types";
import { routeCapability, capabilitiesOf, normalizeCapability, unroutedReason } from "./capabilities";
import { canWriteAny, permissionsForAgent } from "@/utils/rolePolicy";
import { applyArchitectureGate } from "./architecture";
import { finishPlanOwnership } from "./responseOwner";
import type { PlannerInput } from "./planner";

export interface RoutingAdjustment {
  key: string;
  title: string;
  capability: string;
  kind: string;
  action: "dropped" | "blocked" | "made_read_only";
  reason: string;
}

/** O1 architecture flag + backstop → CTO decision node; O2 code-only gates + Response Owner. */
export function gateArchitecture(plan: ExecutionPlan, input: Pick<PlannerInput, "command" | "request" | "agents">, notes: string[]): ExecutionPlan {
  return finishPlanOwnership(applyArchitectureGate(plan, { command: input.request ?? input.command, agents: input.agents }, notes), input.agents, notes);
}

/**
 * Plan 005 Phase 3 Step 3.2: drop unroutable nodes instead of discarding
 * the whole LLM plan. The returned `dropped` keys are logged by the caller
 * as `plan.hint_dropped` events. Degrades (null) only when NO subtask
 * routes to an enabled agent.
 */
export function ensureRoutable(
  plan: ExecutionPlan,
  agents: AgentDefinition[]
): { plan: ExecutionPlan; dropped: string[]; adjustments: RoutingAdjustment[] } | null {
  const kept: ExecutionPlan["subtasks"] = [];
  const dropped: string[] = [];
  const adjustments: RoutingAdjustment[] = [];
  let changed = false;
  let anyRoutable = false;
  for (const subtask of plan.subtasks) {
    // Plan 040 (D8): no fallback owner. Unrouted work is never handed to
    // the highest-priority agent (the CTO).
    const routable = routeCapability(subtask.capability, agents);
    const base = { key: subtask.key, title: subtask.title, capability: subtask.capability, kind: subtask.kind };
    if (!routable) {
      if (subtask.kind === "code_change" || subtask.kind === "shell") {
        // The user's actual work: keep it, so it is BLOCKED at run time
        // with a reason instead of silently vanishing from the plan.
        kept.push(subtask);
        adjustments.push({ ...base, action: "blocked", reason: unroutedReason(subtask.capability, agents) });
        continue;
      }
      // A helper node (review / QA / analysis hint) nobody can serve is
      // dropped, visibly (plan.node_unrouted), never silently.
      dropped.push(subtask.key);
      adjustments.push({ ...base, action: "dropped", reason: unroutedReason(subtask.capability, agents) });
      changed = true;
      continue;
    }
    anyRoutable = true;
    // Plan 040: a code_change owned by a read-only role (a Designer spec,
    // Support docs guidance) becomes an analysis: the role delivers its
    // output as text, the executor would refuse a write anyway.
    if (subtask.kind === "code_change" && !canWriteAny(permissionsForAgent(routable))) {
      kept.push({ ...subtask, kind: "analysis" });
      adjustments.push({ ...base, action: "made_read_only", reason: `${routable.name} (${routable.role}) may not write files; the subtask delivers its output as text` });
      changed = true;
      continue;
    }
    // A fuzzy route (score 70/50) must not keep a capability label its
    // owner does not hold: the label drives the UI QA heuristic, so a
    // backend-only helper got browser QA. Relabel the node to the owner's
    // own capability.
    const ownCapabilities = capabilitiesOf(routable);
    if (
      subtask.kind === "code_change" &&
      ownCapabilities.length > 0 &&
      !ownCapabilities.includes(normalizeCapability(subtask.capability))
    ) {
      kept.push({ ...subtask, capability: ownCapabilities[0] });
      changed = true;
    } else {
      kept.push(subtask);
    }
  }
  if (kept.length === 0 || !anyRoutable) return null;
  if (!changed) return { plan, dropped: [], adjustments };
  const droppedSet = new Set(dropped);
  return {
    plan: {
      ...plan,
      strategy: kept.length > 1 ? "dag" : plan.strategy,
      subtasks: kept.map((subtask, index) => ({
        ...subtask,
        // A dependency on a dropped node would never resolve.
        dependencies: subtask.dependencies.filter((dependency) => !droppedSet.has(dependency)),
        order: index,
      })),
    },
    dropped,
    adjustments,
  };
}
