import type { ExecutionPlan, PlanSubtask, SubtaskKind } from "./types";
import { normalizeCapability } from "./capabilities";

export const SUBTASK_KINDS: SubtaskKind[] = [
  "analysis",
  "code_change",
  "review",
  "qa",
  "research",
  "audit",
  "shell",
];

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  plan?: ExecutionPlan;
}

export function validatePlan(raw: unknown, maxSubtasks: number): ValidationResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["plan must be an object"] };
  }
  const candidate = raw as Record<string, unknown>;

  const goal = typeof candidate.goal === "string" ? candidate.goal.trim() : "";
  if (!goal) errors.push("plan.goal is required");

  const rawSubtasks = candidate.subtasks;
  if (!Array.isArray(rawSubtasks) || rawSubtasks.length === 0) {
    errors.push("plan.subtasks must be a non-empty array");
    return { ok: false, errors };
  }
  if (rawSubtasks.length > maxSubtasks) {
    errors.push(`plan has ${rawSubtasks.length} subtasks; limit is ${maxSubtasks}`);
  }

  const subtasks: PlanSubtask[] = [];
  const seen = new Set<string>();
  rawSubtasks.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      errors.push(`subtask[${index}] must be an object`);
      return;
    }
    const value = entry as Record<string, unknown>;
    const key = typeof value.key === "string" ? value.key.trim().toLowerCase() : "";
    if (!KEY_PATTERN.test(key)) {
      errors.push(`subtask[${index}].key is invalid (use lowercase letters, digits, - or _)`);
      return;
    }
    if (seen.has(key)) {
      errors.push(`duplicate subtask key: ${key}`);
      return;
    }
    seen.add(key);

    const kind = value.kind as SubtaskKind;
    if (!SUBTASK_KINDS.includes(kind)) {
      errors.push(`subtask ${key}: kind must be one of ${SUBTASK_KINDS.join(", ")}`);
    }
    const capability =
      typeof value.capability === "string" ? normalizeCapability(value.capability) : "";
    if (!capability) errors.push(`subtask ${key}: capability is required`);

    const dependencies = Array.isArray(value.dependencies)
      ? (value.dependencies as unknown[])
          .filter((dependency): dependency is string => typeof dependency === "string")
          .map((dependency) => dependency.trim().toLowerCase())
      : [];
    if (dependencies.includes(key)) errors.push(`subtask ${key} depends on itself`);

    subtasks.push({
      key,
      title:
        typeof value.title === "string" && value.title.trim()
          ? value.title.trim().slice(0, 200)
          : key,
      description:
        typeof value.description === "string" ? value.description.trim().slice(0, 4000) : "",
      kind,
      capability,
      dependencies,
      order: typeof value.order === "number" && Number.isFinite(value.order) ? value.order : index,
    });
  });

  for (const subtask of subtasks) {
    for (const dependency of subtask.dependencies) {
      if (!seen.has(dependency)) {
        errors.push(`subtask ${subtask.key} depends on unknown subtask ${dependency}`);
      }
    }
  }

  const cycle = findCycle(subtasks);
  if (cycle) errors.push(`dependency cycle detected: ${cycle.join(" -> ")}`);

  const strategy =
    candidate.strategy === "direct" || candidate.strategy === "dag" || candidate.strategy === "single"
      ? candidate.strategy
      : subtasks.length > 1
        ? "dag"
        : "single";

  // An explicit `false` can never disable the gate for code changes.
  const requiresApproval =
    candidate.requiresApproval === true ||
    subtasks.some((subtask) => subtask.kind === "code_change");

  const maxConcurrency =
    typeof candidate.maxConcurrency === "number" && Number.isFinite(candidate.maxConcurrency)
      ? Math.max(1, Math.floor(candidate.maxConcurrency))
      : 2;

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    errors: [],
    plan: {
      version: 1,
      goal,
      strategy,
      requiresApproval,
      maxConcurrency,
      subtasks: subtasks
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((subtask, index) => ({ ...subtask, order: index })),
    },
  };
}

export function findCycle(subtasks: PlanSubtask[]): string[] | null {
  const byKey = new Map(subtasks.map((subtask) => [subtask.key, subtask]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (key: string): string[] | null => {
    const current = state.get(key) ?? 0;
    if (current === 2) return null;
    if (current === 1) {
      const start = stack.indexOf(key);
      return [...stack.slice(start), key];
    }
    state.set(key, 1);
    stack.push(key);
    const subtask = byKey.get(key);
    for (const dependency of subtask?.dependencies ?? []) {
      if (!byKey.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(key, 2);
    return null;
  };

  for (const subtask of subtasks) {
    const cycle = visit(subtask.key);
    if (cycle) return cycle;
  }
  return null;
}

export function topologicalOrder(subtasks: PlanSubtask[]): PlanSubtask[] {
  const remaining = new Map(subtasks.map((subtask) => [subtask.key, subtask]));
  const result: PlanSubtask[] = [];
  const done = new Set<string>();
  while (remaining.size > 0) {
    let progressed = false;
    for (const [key, subtask] of Array.from(remaining.entries())) {
      if (subtask.dependencies.every((dependency) => done.has(dependency))) {
        result.push(subtask);
        done.add(key);
        remaining.delete(key);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return result;
}
