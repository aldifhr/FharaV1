/**
 * Replanning intelligence (deterministic first). Everything here is pure:
 * the LLM is only asked for the replacement branch; which nodes failed,
 * what they affect, which completed nodes are frozen, whether the new plan
 * is acceptable and what changed are all computed without a model call.
 *
 *  - computeImpact      failed node(s) → affected downstream set in the DAG
 *  - frozenNodesFor     valid completed nodes (passed gates/acceptance): carried
 *                       over unchanged, never re-run, only referenced as deps
 *  - preserveFrozen     Preservation Guard: frozen nodes restored verbatim in
 *                       the new plan whatever the planner wrote for them
 *  - checkReplanQuality reject a repeated failed strategy, a dropped frozen
 *                       node, a cycle, a dangling dependency (hard); a changed
 *                       node without replanReasoning (soft)
 *  - diffPlans          added / removed / modified / preserved + reasoning
 */
import type { ExecutionPlan, PlanSubtask } from "@/types";
import type { ReplanDiff, ReplanDiffEntry } from "@/types/plan";

export type { ReplanDiff, ReplanDiffEntry, ReplanRecord } from "@/types/plan";
import { normalizeCapability } from "@/orchestrator/capabilities";
import { findCycle } from "@/orchestrator/planValidator";

type Node = Pick<PlanSubtask, "key" | "dependencies"> & Partial<PlanSubtask>;

/** Transitive dependents of `failedKeys` (the failed nodes themselves excluded). */
export function computeImpact(
  subtasks: Array<Pick<PlanSubtask, "key" | "dependencies">>,
  failedKeys: Iterable<string>
): string[] {
  const dependents = new Map<string, string[]>();
  for (const subtask of subtasks) {
    for (const dependency of subtask.dependencies) {
      const list = dependents.get(dependency) ?? [];
      list.push(subtask.key);
      dependents.set(dependency, list);
    }
  }
  const failed = new Set(failedKeys);
  const impact = new Set<string>();
  const queue = [...failed];
  while (queue.length > 0) {
    const key = queue.shift()!;
    for (const dependent of dependents.get(key) ?? []) {
      if (failed.has(dependent) || impact.has(dependent)) continue;
      impact.add(dependent);
      queue.push(dependent);
    }
  }
  // Plan order, so prompts and the diff read top-down.
  return subtasks.map((subtask) => subtask.key).filter((key) => impact.has(key));
}

/** Error texts that mean "blocked by an upstream failure", not a root failure. */
const BLOCKED_ERROR = /^(Dependency (deadlock|failed|does not exist|could not run)|Scheduling halted|Start gate never)/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The plan keys named as failed in the failure facts. Facts are the
 * runner's own deterministic strings: `key: error` (scheduler outcomes),
 * `Acceptance gates failed: k1: r1; k2: r2`, `Escalation from subtask k`.
 * A key whose error says it was only blocked by an upstream failure is a
 * downstream node, not a root failure (computeImpact finds it instead).
 */
export function resolveFailedKeys(
  plan: Pick<ExecutionPlan, "subtasks">,
  facts: string[],
  explicit?: string[]
): string[] {
  const keys = new Set(plan.subtasks.map((subtask) => subtask.key));
  if (explicit && explicit.length > 0) return explicit.filter((key) => keys.has(key));
  const failed = new Set<string>();
  const text = facts.join("\n");
  for (const key of keys) {
    const k = escapeRegExp(key);
    const keyed = new RegExp(`(?:^|[\\s;(|,])${k}(?: \\(attempt \\d+\\))?:\\s*([^;\\n]*)`, "g");
    let match: RegExpExecArray | null;
    while ((match = keyed.exec(text)) !== null) {
      if (!BLOCKED_ERROR.test(match[1].trim())) failed.add(key);
    }
    if (new RegExp(`subtask\\s+"?${k}"?(?![\\w-])`, "i").test(text)) failed.add(key);
  }
  return plan.subtasks.map((subtask) => subtask.key).filter((key) => failed.has(key));
}

/**
 * Valid completed nodes: produced output, are neither failed nor in the
 * impact set, and are not QA (a replan means the code changed, so QA must
 * re-validate — QA audit P1-7) nor runner-added dynamic nodes (fixes and
 * delegations are re-derived by the runner, not by the planner). A review
 * only counts when its verdict was an approval.
 */
export function frozenNodesFor(input: {
  plan: Pick<ExecutionPlan, "subtasks">;
  completed: Iterable<string>;
  failedKeys: Iterable<string>;
  impactKeys: Iterable<string>;
  reviewVerdicts?: Record<string, { verdict: string }>;
}): string[] {
  const completed = new Set(input.completed);
  const excluded = new Set([...input.failedKeys, ...input.impactKeys]);
  return input.plan.subtasks
    .filter((subtask) => {
      if (!completed.has(subtask.key) || excluded.has(subtask.key)) return false;
      if (subtask.kind === "qa" || subtask.origin === "dynamic") return false;
      if (subtask.kind === "review") {
        const verdict = input.reviewVerdicts?.[subtask.key]?.verdict;
        if (verdict !== undefined && verdict !== "approved") return false;
      }
      return true;
    })
    .map((subtask) => subtask.key);
}

/** Lowercase, punctuation-free, single-spaced: the comparison form for free text. */
export function normalizeText(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Same objective + agent (capability) + approach (kind, description, scope). */
export function strategyFingerprint(subtask: Partial<PlanSubtask>): string {
  return [
    subtask.kind ?? "",
    normalizeCapability(subtask.capability ?? ""),
    normalizeText(subtask.objective ?? subtask.title),
    normalizeText(subtask.description),
    [...(subtask.allowedPaths ?? [])].map((p) => p.trim().toLowerCase()).sort().join(","),
  ].join("|");
}

/**
 * Preservation Guard: every frozen node that the new plan still names is
 * restored to its old definition verbatim (title, description, contract,
 * dependencies), so it carries forward and is never re-run. Returns the
 * keys whose definition the planner had changed (restored).
 */
export function preserveFrozen(
  previous: ExecutionPlan,
  next: ExecutionPlan,
  frozenKeys: Iterable<string>
): { plan: ExecutionPlan; restored: string[] } {
  const frozen = new Set(frozenKeys);
  const oldByKey = new Map(previous.subtasks.map((subtask) => [subtask.key, subtask]));
  const restored: string[] = [];
  const subtasks = next.subtasks.map((subtask) => {
    if (!frozen.has(subtask.key)) return subtask;
    const original = oldByKey.get(subtask.key);
    if (!original) return subtask;
    if (changedFields(original, subtask).length > 0) restored.push(subtask.key);
    // Keep the new plan's order slot; everything else is the original.
    return { ...original, order: subtask.order };
  });
  return { plan: { ...next, subtasks }, restored };
}

export type ReplanViolationCode =
  | "repeated_failed_strategy"
  | "dropped_frozen_node"
  | "dependency_cycle"
  | "dangling_dependency"
  | "missing_reasoning";

export interface ReplanViolation {
  code: ReplanViolationCode;
  key?: string;
  message: string;
  /** Soft violations trigger the one retry but never reject on their own. */
  soft?: boolean;
}

export interface ReplanQuality {
  ok: boolean;
  violations: ReplanViolation[];
  /** Hard violations only (what rejects the plan). */
  hard: ReplanViolation[];
}

/**
 * Deterministic Replan Quality Check over the new plan (AFTER the
 * Preservation Guard and any timeout split ran).
 */
export function checkReplanQuality(input: {
  previous: ExecutionPlan;
  next: ExecutionPlan;
  failedKeys: string[];
  frozenKeys: string[];
}): ReplanQuality {
  const { previous, next } = input;
  const violations: ReplanViolation[] = [];
  const nextKeys = new Set(next.subtasks.map((subtask) => subtask.key));
  const oldByKey = new Map(previous.subtasks.map((subtask) => [subtask.key, subtask]));

  for (const key of input.frozenKeys) {
    if (!nextKeys.has(key)) {
      violations.push({
        code: "dropped_frozen_node",
        key,
        message: `frozen completed node "${key}" was dropped; keep it exactly as-is (it is never re-run)`,
      });
    }
  }

  for (const failedKey of input.failedKeys) {
    const failed = oldByKey.get(failedKey);
    if (!failed) continue;
    const fingerprint = strategyFingerprint(failed);
    for (const subtask of next.subtasks) {
      if (strategyFingerprint(subtask) !== fingerprint) continue;
      violations.push({
        code: "repeated_failed_strategy",
        key: subtask.key,
        message: `"${subtask.key}" repeats failed node "${failedKey}" with the same objective, agent (${failed.capability}) and approach; change the approach, scope or split it`,
      });
    }
  }

  const cycle = findCycle(next.subtasks);
  if (cycle) {
    violations.push({
      code: "dependency_cycle",
      key: cycle[0],
      message: `dependency cycle: ${cycle.join(" -> ")}`,
    });
  }

  for (const subtask of next.subtasks) {
    for (const dependency of subtask.dependencies) {
      if (!nextKeys.has(dependency)) {
        violations.push({
          code: "dangling_dependency",
          key: subtask.key,
          message: `"${subtask.key}" depends on "${dependency}", which is not in the new plan`,
        });
      }
    }
  }

  const frozen = new Set(input.frozenKeys);
  for (const subtask of next.subtasks) {
    if (frozen.has(subtask.key)) continue;
    const original = oldByKey.get(subtask.key);
    const changed = !original || changedFields(original, subtask).length > 0;
    if (changed && !subtask.replanReasoning?.trim()) {
      violations.push({
        code: "missing_reasoning",
        key: subtask.key,
        message: `"${subtask.key}" was ${original ? "changed" : "added"} without replanReasoning`,
        soft: true,
      });
    }
  }

  const hard = violations.filter((violation) => !violation.soft);
  return { ok: violations.length === 0, violations, hard };
}

const DIFF_FIELDS = [
  "title",
  "description",
  "kind",
  "capability",
  "dependencies",
  "allowedPaths",
  "objective",
  "constraints",
  "deliverable",
  "acceptance",
] as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value === undefined || value === null || value === "") return "";
  return typeof value === "string" ? value.trim() : JSON.stringify(value);
}

/** The fields that differ between two definitions of the same key. */
export function changedFields(a: Node, b: Node): string[] {
  return DIFF_FIELDS.filter((field) => {
    if (field === "dependencies" || field === "allowedPaths") {
      const left = [...((a[field] as string[] | undefined) ?? [])].sort();
      const right = [...((b[field] as string[] | undefined) ?? [])].sort();
      return JSON.stringify(left) !== JSON.stringify(right);
    }
    if (field === "capability") {
      return normalizeCapability(a.capability ?? "") !== normalizeCapability(b.capability ?? "");
    }
    return canonical(a[field]) !== canonical(b[field]);
  });
}

/** Old vs new DAG by key, with the planner's reasoning per changed node. */
export function diffPlans(input: {
  previous: ExecutionPlan;
  next: ExecutionPlan;
  frozenKeys?: string[];
  restoredKeys?: string[];
  failedKeys?: string[];
  impactKeys?: string[];
  removals?: Array<{ key: string; reasoning: string }>;
}): ReplanDiff {
  const frozen = new Set(input.frozenKeys ?? []);
  const restored = new Set(input.restoredKeys ?? []);
  const scope = new Set([...(input.failedKeys ?? []), ...(input.impactKeys ?? [])]);
  const scoped = scope.size > 0;
  const removalReason = new Map((input.removals ?? []).map((entry) => [entry.key, entry.reasoning]));
  const oldByKey = new Map(input.previous.subtasks.map((subtask) => [subtask.key, subtask]));
  const newKeys = new Set(input.next.subtasks.map((subtask) => subtask.key));
  const entry = (subtask: PlanSubtask): ReplanDiffEntry => ({
    key: subtask.key,
    title: subtask.title,
    kind: subtask.kind,
    capability: subtask.capability,
  });
  const diff: ReplanDiff = { added: [], removed: [], modified: [], preserved: [] };
  for (const subtask of input.next.subtasks) {
    const original = oldByKey.get(subtask.key);
    const reasoning = subtask.replanReasoning?.trim() || undefined;
    if (!original) {
      diff.added.push({ ...entry(subtask), ...(reasoning ? { reasoning } : {}) });
      continue;
    }
    const fields = changedFields(original, subtask);
    if (fields.length === 0) {
      diff.preserved.push({
        ...entry(subtask),
        ...(frozen.has(subtask.key) ? { frozen: true } : {}),
        ...(restored.has(subtask.key) ? { restored: true } : {}),
      });
      continue;
    }
    diff.modified.push({
      ...entry(subtask),
      fields,
      ...(reasoning ? { reasoning } : {}),
      ...(scoped && !scope.has(subtask.key) ? { outsideImpact: true } : {}),
    });
  }
  for (const subtask of input.previous.subtasks) {
    if (newKeys.has(subtask.key)) continue;
    const reasoning = removalReason.get(subtask.key)?.trim();
    diff.removed.push({
      ...entry(subtask),
      ...(reasoning ? { reasoning } : {}),
      ...(scoped && !scope.has(subtask.key) && subtask.origin !== "dynamic" ? { outsideImpact: true } : {}),
    });
  }
  return diff;
}

/** Planner-only fields moved off the subtasks once read (never persisted on rows). */
export function stripReplanAnnotations(plan: ExecutionPlan): ExecutionPlan {
  const { replanRemovals: _removals, ...rest } = plan;
  return {
    ...rest,
    subtasks: plan.subtasks.map(({ replanReasoning: _reasoning, ...subtask }) => subtask),
  };
}

/** The scope block appended to the replan feedback (what the LLM may change). */
export function buildReplanScope(input: {
  plan: ExecutionPlan;
  failedKeys: string[];
  impactKeys: string[];
  frozenKeys: string[];
  facts: string[];
}): string {
  const byKey = new Map(input.plan.subtasks.map((subtask) => [subtask.key, subtask]));
  const describe = (key: string) => {
    const subtask = byKey.get(key);
    if (!subtask) return key;
    return `${key} [${subtask.kind}/${subtask.capability}] objective: ${
      subtask.objective ?? subtask.title
    } | approach: ${subtask.description.slice(0, 300)}`;
  };
  const lines = ["REPLAN SCOPE — re-plan ONLY the affected branch:"];
  if (input.failedKeys.length > 0) {
    lines.push("Failed nodes (replace with a DIFFERENT objective, agent or approach — never the same one again):");
    for (const key of input.failedKeys) lines.push(`- ${describe(key)}`);
  } else {
    lines.push("Failed nodes: none attributable to a single node (the failure is plan-level).");
  }
  if (input.impactKeys.length > 0) {
    lines.push(`Affected downstream (re-plan these as needed): ${input.impactKeys.join(", ")}`);
  }
  const facts = input.facts.filter(Boolean).slice(0, 8);
  if (facts.length > 0) {
    lines.push("Failure facts:");
    for (const fact of facts) lines.push(`- ${fact.slice(0, 400)}`);
  }
  if (input.frozenKeys.length > 0) {
    lines.push(
      "FROZEN completed nodes — copy each one EXACTLY (same key, title, description, kind, capability, dependencies). They are never re-run; new nodes may only reference them as dependencies:"
    );
    for (const key of input.frozenKeys) lines.push(`- ${describe(key)}`);
  }
  lines.push(
    'For every node you ADD or CHANGE, set "replanReasoning": one sentence on why (what is different from the failed attempt). For every node you REMOVE, add {"key","reasoning"} to the plan-level "replanRemovals" list. Keep the DAG acyclic.'
  );
  return lines.join("\n");
}

/** One-line rejection message for the user / the retry feedback. */
export function describeViolations(violations: ReplanViolation[]): string {
  return violations.map((violation) => violation.message).join("; ");
}
