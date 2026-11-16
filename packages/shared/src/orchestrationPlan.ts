/**
 * Static analysis for generated orchestration plans: validation, topological
 * execution order and dependency levels for DAG layout. Pure functions shared
 * by the server (plan generation) and the web client (diagnostics, layout).
 */
import {
  AGENT_ROLE_IDS,
  type OrchestrationPlan,
  type OrchestrationPlanDiagnostic,
  type OrchestrationPlanDiagnosticCode,
  type OrchestrationPlanValidation,
} from "@fhara/contracts";

const ROLE_ID_SET: ReadonlySet<string> = new Set(AGENT_ROLE_IDS);

const diagnostic = (
  code: OrchestrationPlanDiagnosticCode,
  message: string,
  stepId?: string,
): OrchestrationPlanDiagnostic => ({
  severity: "error",
  code,
  message,
  ...(stepId === undefined ? {} : { stepId }),
});

/** First occurrence per step id; duplicate ids are reported by validation. */
const uniqueSteps = (
  steps: OrchestrationPlan["steps"],
): Array<OrchestrationPlan["steps"][number]> => {
  const seen = new Set<string>();
  const result: Array<OrchestrationPlan["steps"][number]> = [];
  for (const step of steps) {
    if (seen.has(step.id)) continue;
    seen.add(step.id);
    result.push(step);
  }
  return result;
};

/**
 * Kahn's algorithm with input order breaking ties, so the result is stable
 * across runs. Edges to unknown steps and self loops are ignored. Returns the
 * processed order and the ids that were blocked (in or downstream of a cycle).
 */
function kahn(steps: OrchestrationPlan["steps"]): {
  order: string[];
  blocked: string[];
} {
  const unique = uniqueSteps(steps);
  const indexOf = new Map(unique.map((step, index) => [step.id, index]));
  const indeg = new Map<string, number>();
  const dependents = new Map<string, Array<string>>();
  for (const step of unique) {
    indeg.set(step.id, 0);
    dependents.set(step.id, []);
  }
  for (const step of unique) {
    const deps = new Set(step.dependsOn.filter((dep) => indexOf.has(dep) && dep !== step.id));
    indeg.set(step.id, deps.size);
    for (const dep of deps) dependents.get(dep)!.push(step.id);
  }
  // Ready nodes are kept in input order for a deterministic result.
  const ready = unique.filter((step) => indeg.get(step.id) === 0).map((step) => step.id);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const next = indeg.get(dependent)! - 1;
      indeg.set(dependent, next);
      if (next === 0) {
        const index = indexOf.get(dependent)!;
        let insertAt = 0;
        while (insertAt < ready.length && indexOf.get(ready[insertAt]!)! < index) insertAt += 1;
        ready.splice(insertAt, 0, dependent);
      }
    }
  }
  const ordered = new Set(order);
  const blocked = unique.map((step) => step.id).filter((id) => !ordered.has(id));
  return { order, blocked };
}

/**
 * Deterministic topological order of the steps, or null when a cycle makes one
 * impossible. Ignores edges to unknown steps and self loops.
 */
export function topologicalOrder(steps: OrchestrationPlan["steps"]): ReadonlyArray<string> | null {
  const { order, blocked } = kahn(steps);
  return blocked.length === 0 ? order : null;
}

/**
 * Longest-path layering used to lay the DAG out left-to-right. Steps blocked
 * by a cycle are placed after their last acyclic dependency. Deterministic.
 */
export function orchestrationPlanLevels(plan: OrchestrationPlan): ReadonlyMap<string, number> {
  const stepById = new Map<string, OrchestrationPlan["steps"][number]>();
  for (const step of plan.steps) {
    if (!stepById.has(step.id)) stepById.set(step.id, step);
  }
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  const levelOf = (id: string): number => {
    const cached = levels.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // cycle: break the loop at this node
    const step = stepById.get(id);
    if (!step) return 0;
    visiting.add(id);
    let level = 0;
    for (const dep of step.dependsOn) {
      if (dep === id || !stepById.has(dep)) continue;
      level = Math.max(level, levelOf(dep) + 1);
    }
    visiting.delete(id);
    levels.set(id, level);
    return level;
  };
  for (const step of plan.steps) levelOf(step.id);
  return levels;
}

/**
 * Validates structure, roles, references and acyclicity. Diagnostics carry
 * every problem found; `executionOrder` is only set when there are no
 * error-severity diagnostics.
 */
export function validateOrchestrationPlan(plan: OrchestrationPlan): OrchestrationPlanValidation {
  const diagnostics: OrchestrationPlanDiagnostic[] = [];
  const steps = plan.steps;
  if (steps.length === 0) {
    diagnostics.push(diagnostic("empty-plan", "The plan contains no steps."));
  }
  const counts = new Map<string, number>();
  for (const step of steps) counts.set(step.id, (counts.get(step.id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count > 1) {
      diagnostics.push(
        diagnostic("duplicate-step-id", `Step id "${id}" is used ${count} times.`, id),
      );
    }
  }
  const known = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    if (!ROLE_ID_SET.has(step.roleId)) {
      diagnostics.push(
        diagnostic(
          "unknown-role",
          `Step "${step.id}" uses unregistered role "${step.roleId}".`,
          step.id,
        ),
      );
    }
    if (step.dependsOn.includes(step.id)) {
      diagnostics.push(
        diagnostic("self-dependency", `Step "${step.id}" depends on itself.`, step.id),
      );
    }
    for (const dep of new Set(step.dependsOn)) {
      if (dep !== step.id && !known.has(dep)) {
        diagnostics.push(
          diagnostic(
            "missing-dependency",
            `Step "${step.id}" depends on unknown step "${dep}".`,
            step.id,
          ),
        );
      }
    }
  }
  const { order, blocked } = kahn(steps);
  if (blocked.length > 0) {
    diagnostics.push(
      diagnostic(
        "cycle",
        `Steps participate in or are blocked by a circular dependency: ${blocked.join(", ")}.`,
      ),
    );
  }
  const valid = !diagnostics.some((entry) => entry.severity === "error");
  return {
    valid,
    diagnostics,
    executionOrder: valid ? order : [],
  };
}
