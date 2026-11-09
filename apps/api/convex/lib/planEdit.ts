/**
 * Light plan editing from the Plan card (Plan Inspector). Pure: applies the
 * user's edit operations to a stored plan payload and validates the result
 * with the shared plan validator (lib/planValidation.ts — the same rules the
 * worker applies to planner output and stored plans). An edit that leaves
 * the plan invalid is refused as a whole; nothing is partially applied.
 *
 * The edited RAW payload is returned (not the validator's normalised copy)
 * so plan-level fields the validator does not carry (e.g. `visualQa`) and
 * per-subtask extras survive the edit.
 */
import { ROLE_KEYS, ROLES, type RoleKey } from "./roles";
import { validateStoredPlan, type ValidatedSubtaskKind } from "./planValidation";

export type PlanEditOp =
  | { op: "update"; key: string; title?: string; description?: string }
  | { op: "reassign"; key: string; role: string }
  /**
   * Remove a subtask. Its dependents are re-linked to the removed subtask's
   * own dependencies ("relink", default), or the removal is refused while
   * anything still depends on it ("reject").
   */
  | { op: "remove"; key: string; dependents?: "relink" | "reject" };

export type PlanEditResult =
  | { ok: true; plan: Record<string, unknown>; changed: string[]; removed: string[] }
  | { ok: false; errors: string[] };

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 4000;

/** Kinds a reassigned role implies; writer roles fall back to code_change. */
const ROLE_KIND: Partial<Record<RoleKey, ValidatedSubtaskKind>> = {
  reviewer: "review",
  qa: "qa",
  researcher: "research",
  devops: "shell",
  cto: "analysis",
};
const WRITER_ROLES = new Set<RoleKey>(["frontend", "backend", "designer", "support"]);
const NON_WRITING_KINDS = new Set<string>(["review", "qa", "research", "shell", "analysis", "audit"]);

/** The capability a role's subtask is routed by (its first seeded capability). */
export function capabilityForRoleKey(role: RoleKey): string {
  return ROLES[role].capabilities[0] ?? "general";
}

/** Best-effort capability → role (first role that seeds the capability). */
export function roleKeyForCapability(capability: string): RoleKey | null {
  const normalized = capability.trim().toLowerCase();
  for (const key of ROLE_KEYS) {
    if (ROLES[key].capabilities.includes(normalized) || ROLES[key].registryCapabilities.includes(normalized)) {
      return key;
    }
  }
  return null;
}

function kindForRole(role: RoleKey, current: string): ValidatedSubtaskKind {
  const implied = ROLE_KIND[role];
  if (implied) return implied;
  if (WRITER_ROLES.has(role) && NON_WRITING_KINDS.has(current)) return "code_change";
  return current as ValidatedSubtaskKind;
}

type RawSubtask = Record<string, unknown> & { key: string; dependencies: string[] };

export function applyPlanEdits(input: {
  plan: unknown;
  ops: PlanEditOp[];
  /** Role keys of the enabled agents a subtask may be reassigned to. */
  enabledRoles: string[];
  maxSubtasks: number;
}): PlanEditResult {
  const errors: string[] = [];
  if (!input.plan || typeof input.plan !== "object" || !Array.isArray((input.plan as any).subtasks)) {
    return { ok: false, errors: ["stored plan is missing or malformed"] };
  }
  if (input.ops.length === 0) return { ok: false, errors: ["no edits to apply"] };
  // Deep copy: the stored payload is never mutated.
  const plan = JSON.parse(JSON.stringify(input.plan)) as Record<string, unknown> & { subtasks: RawSubtask[] };
  plan.subtasks = plan.subtasks.map((raw) => ({
    ...raw,
    key: String(raw.key ?? "").trim().toLowerCase(),
    dependencies: Array.isArray(raw.dependencies)
      ? (raw.dependencies as unknown[]).filter((d): d is string => typeof d === "string").map((d) => d.trim().toLowerCase())
      : [],
  }));
  const enabled = new Set(input.enabledRoles.map((role) => role.trim().toLowerCase()));
  const changed = new Set<string>();
  const removed: string[] = [];
  const find = (key: string) => plan.subtasks.find((s) => s.key === key.trim().toLowerCase());

  for (const op of input.ops) {
    const subtask = find(op.key);
    if (!subtask) {
      errors.push(
        removed.includes(op.key.trim().toLowerCase())
          ? `subtask ${op.key} was already removed`
          : `unknown subtask: ${op.key}`
      );
      continue;
    }
    if (op.op === "update") {
      if (op.title !== undefined) {
        const title = op.title.trim();
        if (!title) errors.push(`subtask ${subtask.key}: title cannot be empty`);
        else if (title.length > TITLE_MAX) errors.push(`subtask ${subtask.key}: title is longer than ${TITLE_MAX} characters`);
        else subtask.title = title;
      }
      if (op.description !== undefined) {
        const description = op.description.trim();
        if (description.length > DESCRIPTION_MAX) {
          errors.push(`subtask ${subtask.key}: description is longer than ${DESCRIPTION_MAX} characters`);
        } else subtask.description = description;
      }
      changed.add(subtask.key);
      continue;
    }
    if (op.op === "reassign") {
      const role = op.role.trim().toLowerCase();
      if (!(ROLE_KEYS as readonly string[]).includes(role)) {
        errors.push(`subtask ${subtask.key}: unknown role ${op.role}`);
        continue;
      }
      if (!enabled.has(role)) {
        errors.push(`subtask ${subtask.key}: no enabled ${ROLES[role as RoleKey].label} agent on this team`);
        continue;
      }
      subtask.capability = capabilityForRoleKey(role as RoleKey);
      subtask.kind = kindForRole(role as RoleKey, String(subtask.kind ?? ""));
      changed.add(subtask.key);
      continue;
    }
    // remove
    const dependents = plan.subtasks.filter((s) => s.key !== subtask.key && s.dependencies.includes(subtask.key));
    if (dependents.length > 0 && op.dependents === "reject") {
      errors.push(
        `subtask ${subtask.key} cannot be removed: ${dependents.map((d) => d.key).join(", ")} depend${dependents.length === 1 ? "s" : ""} on it`
      );
      continue;
    }
    for (const dependent of dependents) {
      const next = dependent.dependencies.filter((d) => d !== subtask.key);
      for (const inherited of subtask.dependencies) {
        if (inherited !== dependent.key && !next.includes(inherited)) next.push(inherited);
      }
      dependent.dependencies = next;
      changed.add(dependent.key);
    }
    plan.subtasks = plan.subtasks.filter((s) => s.key !== subtask.key);
    changed.delete(subtask.key);
    removed.push(subtask.key);
  }

  if (errors.length > 0) return { ok: false, errors };

  // Keep `order` dense and stable after removals.
  plan.subtasks = plan.subtasks
    .slice()
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
    .map((s, index) => ({ ...s, order: index }));
  if (plan.subtasks.length <= 1 && plan.strategy === "dag") plan.strategy = "single";

  const validation = validateStoredPlan(plan, input.maxSubtasks);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  return { ok: true, plan, changed: [...changed], removed };
}
