/**
 * The plan validator, shared by the worker (planner output, stored plans on
 * resume/recovery) and the backend (user plan edits from the Plan card, so an
 * invalid edit is refused before it is stored). Pure TypeScript: no Convex,
 * Node or DOM APIs. The worker re-exports it from
 * packages/worker/src/orchestrator/planValidator.ts with its own plan types.
 */
import { normalizeAllowedPaths } from "./ownershipPaths";
import { contractGateErrors, parseContract, type AcceptanceGate } from "./subtaskContract";

export type ValidatedSubtaskKind =
  | "analysis"
  | "code_change"
  | "review"
  | "qa"
  | "research"
  | "audit"
  | "shell";

export interface ValidatedSubtask {
  key: string;
  title: string;
  description: string;
  kind: ValidatedSubtaskKind;
  capability: string;
  dependencies: string[];
  order: number;
  allowedPaths?: string[];
  // Plan 022 contract (scope = allowedPaths). Gates are always present
  // after validation: derived from the kind when the plan gave none.
  objective?: string;
  constraints?: string[];
  deliverable?: string;
  acceptance?: AcceptanceGate[];
  /** Replan Reasoning (planner output in a replan; stripped before persist). */
  replanReasoning?: string;
}

export interface ValidatedPlan {
  version: 1;
  goal: string;
  strategy: "direct" | "single" | "dag";
  requiresApproval: boolean;
  maxConcurrency: number;
  subtasks: ValidatedSubtask[];
  /** Plan-level visual-QA intent, carried through when stored (resume / reviewed plans). */
  visualQa?: boolean;
  /** Planner output in a replan: why nodes were removed (stripped before persist). */
  replanRemovals?: Array<{ key: string; reasoning: string }>;
}

/** Same normalisation as the worker's `normalizeCapability`. */
export function normalizeCapability(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

export const SUBTASK_KINDS: ValidatedSubtaskKind[] = [
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
  plan?: ValidatedPlan;
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

  const subtasks: ValidatedSubtask[] = [];
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

    const capability =
      typeof value.capability === "string" ? normalizeCapability(value.capability) : "";
    if (!capability) errors.push(`subtask ${key}: capability is required`);
    // ponytail: shell-execution always runs the "shell" executor. Planner
    // sometimes emits kind "audit"/"analysis" for it, which routes to the
    // read-only executor (no shell access). Coerce at validation.
    const kind = (capability === "shell-execution"
      ? "shell"
      : (value.kind as ValidatedSubtaskKind)) as ValidatedSubtaskKind;
    // Shell executor is git-only exact-argv (see isCommandAllowed). A shell
    // subtask whose description asks for file creation / write (e.g.
    // "Create hello.txt", "printf '...' > file") can never succeed — the
    // shell agent replies with a self-delegation loop. Reject at validation
    // so the planner falls back to the heuristic code_change plan instead
    // of emitting a doomed shell DAG.
    if (capability === "shell-execution") {
      const desc = typeof value.description === "string" ? value.description : "";
      if (/\b(create|write|touch|echo|printf|mkdir|cp|mv|rm)\b.*\bfile\b|\bfile\b.*\b(create|write)|>|printf|hello\.txt/i.test(desc)) {
        errors.push(
          `subtask ${key}: shell-execution cannot create/write files (git-only allowlist); use code_change`
        );
      }
    }
    if (!SUBTASK_KINDS.includes(kind)) {
      errors.push(`subtask ${key}: kind must be one of ${SUBTASK_KINDS.join(", ")}`);
    }

    const dependencies = Array.isArray(value.dependencies)
      ? (value.dependencies as unknown[])
          .filter((dependency): dependency is string => typeof dependency === "string")
          .map((dependency) => dependency.trim().toLowerCase())
      : [];
    if (dependencies.includes(key)) errors.push(`subtask ${key} depends on itself`);

    // Plan 022: `scope` is the contract's name for allowedPaths; it is
    // accepted as an alias when allowedPaths is absent.
    const ownership = normalizeAllowedPaths(value.allowedPaths ?? value.scope);
    if (!ownership.ok) errors.push(`subtask ${key}: ${ownership.error}`);

    const contract = parseContract(value, kind, key);
    errors.push(...contract.errors);
    errors.push(...contractGateErrors({ key, kind, acceptance: contract.contract.acceptance }));

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
      ...(ownership.ok && ownership.paths ? { allowedPaths: ownership.paths } : {}),
      ...contract.contract,
      ...(typeof value.replanReasoning === "string" && value.replanReasoning.trim()
        ? { replanReasoning: value.replanReasoning.trim().slice(0, 1000) }
        : {}),
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
      ...(typeof candidate.visualQa === "boolean" ? { visualQa: candidate.visualQa } : {}),
      ...replanRemovalsOf(candidate.replanRemovals),
      subtasks: subtasks
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((subtask, index) => ({ ...subtask, order: index })),
    },
  };
}

/** Planner-provided removal reasons (replan only); malformed entries are dropped. */
function replanRemovalsOf(raw: unknown): { replanRemovals?: Array<{ key: string; reasoning: string }> } {
  if (!Array.isArray(raw)) return {};
  const removals = raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .filter((entry) => typeof entry.key === "string" && typeof entry.reasoning === "string")
    .map((entry) => ({
      key: (entry.key as string).trim().toLowerCase(),
      reasoning: (entry.reasoning as string).trim().slice(0, 1000),
    }))
    .filter((entry) => entry.key && entry.reasoning)
    .slice(0, 40);
  return removals.length > 0 ? { replanRemovals: removals } : {};
}

export function findCycle<T extends { key: string; dependencies: string[] }>(
  subtasks: T[]
): string[] | null {
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

/**
 * Validate a plan read back from storage (resume after approval, lease
 * recovery). The planner's subtask cap applies to what a PLANNER may
 * propose; the stored plan also carries the nodes the runner itself added
 * during the run (review/QA/verification fix nodes, delegations), each
 * bounded by its own loop limit. Re-applying the planner cap here failed a
 * review-approved e2e ULTRA task right after the user approved its diff
 * ("plan has 9 subtasks; limit is 8" -> "Stored plan is missing or
 * invalid"). Structure is still fully validated.
 */
export function validateStoredPlan(raw: unknown, maxSubtasks: number): ValidationResult {
  const count =
    raw && typeof raw === "object" && Array.isArray((raw as { subtasks?: unknown }).subtasks)
      ? (raw as { subtasks: unknown[] }).subtasks.length
      : 0;
  return validatePlan(raw, Math.max(maxSubtasks, count));
}
