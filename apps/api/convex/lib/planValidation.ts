/**
 * The plan validator, shared by the worker (planner output, stored plans on
 * resume/recovery) and the backend (user plan edits from the Plan card, so an
 * invalid edit is refused before it is stored). Pure TypeScript: no Convex,
 * Node or DOM APIs. The worker re-exports it from
 * packages/worker/src/orchestrator/planValidator.ts with its own plan types.
 */
import { normalizeAllowedPaths } from "./ownershipPaths";
import {
  contractGateErrors,
  defaultGatesForKind,
  parseContract,
  type AcceptanceGate,
} from "./subtaskContract";
import { parseStoredRequirements, type Requirement } from "./requirements";

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
  /** Plan 025: the task requirements (ids) this subtask serves. */
  requirementIds?: string[];
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
  /** Plan 025: the requirements extracted from the request at plan time. */
  requirements?: Requirement[];
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
  /** What the read-only lock changed (converted / dropped nodes), for planner notes. */
  notes?: string[];
}

/**
 * Task types whose plans are read-only: a research task or a question never
 * gets a node that writes (code_change) or runs mutating commands (shell is
 * git-only but includes pull-style argv). "question" is accepted for
 * callers that name it; the worker classifier calls it "research". Audit is
 * deliberately not here: an audit's critical findings may still delegate a
 * fix (delegation.ts), which is existing, tested behaviour.
 */
export const READ_ONLY_TASK_KINDS: ReadonlySet<string> = new Set(["research", "question", "conversation"]);

/** Subtask kinds that write or apply changes; never allowed in a read-only plan. */
const WRITE_KINDS: ReadonlySet<string> = new Set(["code_change", "shell"]);
/** Kinds that only make sense on top of a code change (diff review, browser QA). */
const CHANGE_FOLLOWUP_KINDS: ReadonlySet<string> = new Set(["review", "qa"]);

export interface ValidatePlanOptions {
  /**
   * The task's classification kind. For a read-only kind (research,
   * question, conversation) write nodes are converted into read-only
   * research nodes and diff-review / QA nodes are dropped. Omitted: no lock
   * (user plan edits, stored plans).
   */
  taskKind?: string;
  /**
   * taskKind "command" only: the allowlisted command lines the user asked to
   * run ("npm run test"). The plan becomes one shell node per command.
   */
  commands?: string[];
}

/** Task kind for "run npm test" / "jalankan tes": a shell-only plan. */
export const COMMAND_TASK_KIND = "command";

export function isReadOnlyTaskKind(kind: string | undefined): boolean {
  return kind !== undefined && READ_ONLY_TASK_KINDS.has(kind);
}

const READ_ONLY_PREFIX =
  "Read-only: investigate and report findings with evidence (file references or URLs). Do not modify, create or delete files and do not run mutating commands.";

export function validatePlan(
  raw: unknown,
  maxSubtasks: number,
  options: ValidatePlanOptions = {}
): ValidationResult {
  if (options.taskKind === COMMAND_TASK_KIND) {
    const locked = lockCommand(raw, options.commands ?? []);
    const result = validatePlanInner(locked.raw, maxSubtasks, false);
    return locked.notes.length > 0 ? { ...result, notes: locked.notes } : result;
  }
  if (isReadOnlyTaskKind(options.taskKind)) {
    const locked = lockReadOnly(raw);
    const result = validatePlanInner(locked.raw, maxSubtasks, true);
    return locked.notes.length > 0 ? { ...result, notes: locked.notes } : result;
  }
  return validatePlanInner(raw, maxSubtasks, false);
}

/**
 * Read-only lock (research/question tasks): code_change and shell nodes
 * become research nodes (no allowedPaths, research gates); review and QA
 * nodes, which only check a diff or a running change, are dropped and their
 * dependents inherit their dependencies. Applied to the raw planner output
 * so every later validation step sees a read-only plan. Malformed input is
 * passed through for the normal validator to reject.
 */
function lockReadOnly(raw: unknown): { raw: unknown; notes: string[] } {
  const notes: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { raw, notes };
  const candidate = raw as Record<string, unknown>;
  if (!Array.isArray(candidate.subtasks)) return { raw, notes };
  const entries = candidate.subtasks as unknown[];

  const keyOf = (value: Record<string, unknown>) =>
    typeof value.key === "string" ? value.key.trim().toLowerCase() : "";
  const depsOf = (value: Record<string, unknown>) =>
    Array.isArray(value.dependencies)
      ? (value.dependencies as unknown[])
          .filter((dependency): dependency is string => typeof dependency === "string")
          .map((dependency) => dependency.trim().toLowerCase())
      : [];
  const isObject = (entry: unknown): entry is Record<string, unknown> =>
    Boolean(entry) && typeof entry === "object" && !Array.isArray(entry);
  const kindOf = (value: Record<string, unknown>) =>
    typeof value.capability === "string" && normalizeCapability(value.capability) === "shell-execution"
      ? "shell"
      : String(value.kind ?? "");

  // Drop review/QA nodes (keep at least one node so the plan stays valid).
  const objects = entries.filter(isObject);
  const droppable = objects.filter((value) => CHANGE_FOLLOWUP_KINDS.has(kindOf(value)));
  const dropped = new Map<string, string[]>();
  if (droppable.length < objects.length) {
    for (const value of droppable) dropped.set(keyOf(value), depsOf(value));
  }
  const resolveDeps = (deps: string[], seen = new Set<string>()): string[] =>
    deps.flatMap((dependency) => {
      if (!dropped.has(dependency)) return [dependency];
      if (seen.has(dependency)) return [];
      seen.add(dependency);
      return resolveDeps(dropped.get(dependency) ?? [], seen);
    });

  const subtasks: unknown[] = [];
  for (const entry of entries) {
    if (!isObject(entry)) {
      subtasks.push(entry);
      continue;
    }
    const key = keyOf(entry);
    if (dropped.has(key)) {
      notes.push(`read-only task: dropped ${kindOf(entry)} subtask ${key} (nothing to review or test without code changes)`);
      continue;
    }
    const dependencies = [...new Set(resolveDeps(depsOf(entry)))];
    const next: Record<string, unknown> = {
      ...entry,
      ...(Array.isArray(entry.dependencies) ? { dependencies } : {}),
    };
    const kind = kindOf(entry);
    if (WRITE_KINDS.has(kind)) {
      const description = typeof entry.description === "string" ? entry.description.trim() : "";
      next.kind = "research";
      if (kind === "shell") next.capability = "research";
      next.description = description ? `${READ_ONLY_PREFIX}\n${description}` : READ_ONLY_PREFIX;
      next.acceptance = defaultGatesForKind("research");
      delete next.allowedPaths;
      delete next.scope;
      notes.push(`read-only task: converted ${kind} subtask ${key || "(unnamed)"} to research`);
    }
    subtasks.push(next);
  }
  return {
    raw: { ...candidate, subtasks, requiresApproval: false },
    notes,
  };
}

function commandNodeKey(line: string, used: Set<string>): string {
  const base = `run-${line.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 60) || "run";
  let key = base;
  for (let n = 2; used.has(key); n += 1) key = `${base}-${n}`;
  used.add(key);
  return key;
}

/**
 * Command lock ("run npm test" / "jalankan tes"): the plan is the shell
 * nodes that run the requested commands, in request order, and nothing
 * else. A planner that turned the run into a code_change ("no file changes")
 * or a report-writing node is overridden; review / QA nodes are dropped.
 * Without known commands the planner's own shell nodes are kept, code_change
 * nodes become shell nodes and everything else is dropped. Each command is
 * approved when it runs (run_command approval), so requiresApproval is false.
 */
function lockCommand(raw: unknown, commands: string[]): { raw: unknown; notes: string[] } {
  const notes: string[] = [];
  const candidate: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  const entries = Array.isArray(candidate.subtasks) ? (candidate.subtasks as unknown[]) : [];
  const isObject = (entry: unknown): entry is Record<string, unknown> =>
    Boolean(entry) && typeof entry === "object" && !Array.isArray(entry);
  const kindOf = (value: Record<string, unknown>) =>
    typeof value.capability === "string" && normalizeCapability(value.capability) === "shell-execution"
      ? "shell"
      : String(value.kind ?? "");
  const keyOf = (value: Record<string, unknown>) =>
    typeof value.key === "string" && value.key.trim() ? value.key.trim().toLowerCase() : "(unnamed)";

  const lines = [...new Set(commands.map((line) => line.trim()).filter(Boolean))];
  let subtasks: Record<string, unknown>[];
  if (lines.length > 0) {
    for (const entry of entries.filter(isObject)) {
      if (kindOf(entry) !== "shell") notes.push(`run-command task: replaced ${kindOf(entry) || "unknown"} subtask ${keyOf(entry)} with the requested command`);
    }
    const used = new Set<string>();
    subtasks = lines.map((line, index) => ({
      key: commandNodeKey(line, used),
      title: `Run ${line}`,
      description: `Run exactly: ${line}`,
      kind: "shell",
      capability: "shell-execution",
      dependencies: [],
      order: index,
    }));
    subtasks.forEach((node, index) => {
      if (index > 0) node.dependencies = [subtasks[index - 1].key];
    });
  } else {
    const kept = entries.filter(isObject).filter((entry) => {
      const kind = kindOf(entry);
      if (kind === "shell" || kind === "code_change") return true;
      notes.push(`run-command task: dropped ${kind || "unknown"} subtask ${keyOf(entry)}`);
      return false;
    });
    const keptKeys = new Set(kept.map(keyOf));
    subtasks = kept.map((entry) => {
      const kind = kindOf(entry);
      const next: Record<string, unknown> = { ...entry, kind: "shell", capability: "shell-execution" };
      if (Array.isArray(entry.dependencies)) {
        next.dependencies = (entry.dependencies as unknown[]).filter(
          (dependency) => typeof dependency === "string" && keptKeys.has(dependency.trim().toLowerCase())
        );
      }
      if (kind === "code_change") {
        notes.push(`run-command task: converted code_change subtask ${keyOf(entry)} to shell`);
        delete next.allowedPaths;
        delete next.scope;
        delete next.acceptance;
      }
      return next;
    });
  }
  return { raw: { ...candidate, subtasks, requiresApproval: false }, notes };
}

function validatePlanInner(raw: unknown, maxSubtasks: number, readOnly: boolean): ValidationResult {
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
      ...requirementIdsOf(value.requirementIds),
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
  // A read-only (research/question) plan has nothing to approve.
  const requiresApproval =
    (!readOnly && candidate.requiresApproval === true) ||
    subtasks.some((subtask) => subtask.kind === "code_change");

  const maxConcurrency =
    typeof candidate.maxConcurrency === "number" && Number.isFinite(candidate.maxConcurrency)
      ? Math.max(1, Math.floor(candidate.maxConcurrency))
      : 2;

  if (errors.length > 0) return { ok: false, errors };
  const requirements = parseStoredRequirements(candidate.requirements);

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
      ...(requirements.length > 0 ? { requirements } : {}),
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

/** Plan 025: requirement ids a subtask declares (strings, lowercased, deduped, ≤ 12). */
function requirementIdsOf(raw: unknown): { requirementIds?: string[] } {
  if (!Array.isArray(raw)) return {};
  const ids = [
    ...new Set(
      raw
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        .map((id) => id.trim().toLowerCase().slice(0, 32))
    ),
  ].slice(0, 12);
  return ids.length > 0 ? { requirementIds: ids } : {};
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
  return validatePlanInner(raw, Math.max(maxSubtasks, count), false);
}
