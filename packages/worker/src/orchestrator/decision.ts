import {
  CAPABILITY,
  type AgentDefinition,
  type Classification,
  type ExecutionPlan,
  type PlanSubtask,
  type SubtaskKind,
} from "./types";
import type { BudgetSnapshot } from "./budget";
import type { ExecutionPolicy } from "./policy";
import type { ExecutionHistoryEntry, OutstandingIssue } from "./taskContext";
import type { ReviewFinding } from "@/utils/json";
import {
  routeCapability,
  normalizeCapability,
} from "./capabilities";
import { findCycle } from "./planValidator";
import { preventCircularDelegation } from "./delegation";
import type { DelegationDecision } from "./delegation";

/**
 * Plan 006 Phase 2 (adopts plan 005 Phase 2): the decision contract.
 *
 * A decision is a *request*. `validateDecision` plus `policy.ts` plus
 * `BudgetTracker` can refuse any of them; the LLM never bypasses a gate.
 * The runner (`taskRunner.ts`) owns execution and applies a validated
 * decision, so this module contains no side effects.
 */

export type DecisionAction =
  | "execute" // run the selected agent on one node
  | "delegate" // add work for another capability
  | "parallel" // add independent nodes in one batch
  | "replan" // replace the remaining graph, keep completed work
  | "complete" // objective evidence satisfied
  | "ask_user"; // blocked on missing information/approval

export const DECISION_ACTIONS: readonly DecisionAction[] = [
  "execute",
  "delegate",
  "parallel",
  "replan",
  "complete",
  "ask_user",
];

export interface DecisionContext {
  taskId: string;
  objective: string;
  classification: Classification;
  planVersion: number;
  plan: ExecutionPlan;
  /** Summarized history, not raw agent outputs. */
  results: ExecutionHistoryEntry[];
  openIssues: OutstandingIssue[];
  budget: BudgetSnapshot;
  policy: ExecutionPolicy;
  agents: AgentDefinition[];
  completedKeys: ReadonlySet<string>;
  /**
   * Subtask keys added after planning (delegation / fix / recovery). They
   * are execution details, never objective requirements — the planned graph
   * is the only thing completion is measured against.
   */
  dynamicKeys?: ReadonlySet<string>;
  step: number;
  /** Plan 005 Phase 5 Step 5.1: objective evidence inputs from the runner. */
  objectiveEvidence?: ObjectiveEvidence;
  /** Per-branch capability chain of the subtask that produced the observation. */
  chainCapabilities?: string[];
  /** Live per-agent execution counts for the concurrency gate. */
  activeByAgent?: ReadonlyMap<string, number>;
}

/**
 * Plan 005 Phase 5 Step 5.1: the objective-evidence inputs the runner feeds
 * `evaluateObjective`. Files are attributed per subtask (the runner records
 * them with the producing subtask key); QA verdicts and the static
 * verification result are the runner's own. `verification` is undefined
 * until it runs — a criterion on evidence that has not been produced yet is
 * skipped, not failed.
 */
export interface ObjectiveEvidence {
  /** Applied file paths per completed subtask key (code_change nodes). */
  appliedFiles?: Record<string, string[]>;
  /** QA verdicts by subtask key. */
  qaVerdicts?: Record<string, "passed" | "failed" | "inconclusive">;
  /** Static verification result; undefined when it did not run. */
  verification?: { status: "passed" | "failed" | "skipped"; details?: string };
  /** The decision whose expectedOutcome is being checked for satisfaction. */
  lastDecision?: { action: DecisionAction; expectedOutcome?: string };
}

export interface ObjectiveEvaluation {
  satisfied: boolean;
  evidence: string[];
  missing: string[];
}

/** Outcomes that signal the objective is NOT yet met. "policy:budget" is
 *  deliberately absent: in warn mode a budget warning is non-fatal by
 *  design and must not poison the objective forever (that produced
 *  bogus "last decision outcome policy:budget is not met" verdicts in live
 *  runs); in enforce mode exhaustion ends the task via the explicit
 *  budget-exhausted path, not via objective evaluation. */
const UNMET_OUTCOMES = new Set(["retry", "recovery", "decision:step_limit"]);

/**
 * Plan 005 Phase 5 Step 5.1: is the task objective satisfied? Pure: it reads
 * the plan, completed keys, open issues, and the runner-supplied evidence.
 * `complete` may only be emitted when this returns `satisfied`.
 */
export function evaluateObjective(ctx: DecisionContext): ObjectiveEvaluation {
  const evidence: string[] = [];
  const missing: string[] = [];
  const ev = ctx.objectiveEvidence ?? {};

  // Every executed code_change has an applied file change. Research/audit
  // tasks have no code_change nodes and are exempt.
  const codeChanges = ctx.plan.subtasks.filter(
    (subtask) => subtask.kind === "code_change" && ctx.completedKeys.has(subtask.key)
  );
  if (codeChanges.length === 0) {
    evidence.push("no code_change nodes in the executed graph (research/audit task)");
  } else {
    for (const subtask of codeChanges) {
      const files = ev.appliedFiles?.[subtask.key] ?? [];
      if (files.length > 0) {
        evidence.push(`${subtask.key}: ${files.length} file change(s) applied`);
      } else {
        missing.push(`${subtask.key}: code_change completed with no applied file change`);
      }
    }
  }

  // Static verification ran and did not fail when a code_change was applied.
  if (ev.verification) {
    if (ev.verification.status === "failed") {
      missing.push(`static verification failed: ${ev.verification.details ?? "no details"}`);
    } else if (ev.verification.status === "passed") {
      evidence.push("static verification passed");
    }
  }

  // Scaffold evidence (runTeam, from open-multi-agent): a React/Vite
  // migration must leave a real project structure (package.json + entry +
  // App), not a single CDN index.html.
  const allFiles = Object.values(ev.appliedFiles ?? {}).flat();
  const needsScaffold = /\b(react|vite|next)\b/i.test(ctx.plan.goal ?? "");
  if (needsScaffold && allFiles.length > 0) {
    const hasPkg = allFiles.some((f) => f === "package.json" || f.endsWith("/package.json"));
    const hasApp = allFiles.some((f) => /(src\/(main|App)\.(jsx|tsx|js|ts))$$/.test(f));
    if (!hasPkg || !hasApp) {
      missing.push(
        "React scaffold incomplete: missing " +
          [!hasPkg ? "package.json" : null, !hasApp ? "src/main.jsx or src/App.jsx" : null]
            .filter(Boolean)
            .join(", ")
      );
    } else {
      evidence.push("scaffold complete: package.json + entry App present");
    }
  }

  // Required QA (if present in the plan) has a passed verdict.
  for (const subtask of ctx.plan.subtasks) {
    if (subtask.kind !== "qa") continue;
    // Dynamic delegation/recovery nodes are execution details, not new
    // objective requirements. The runner marks them explicitly; the planned
    // QA node is the only authoritative one, otherwise every retry creates
    // another required verdict and the task can never complete.
    if (ctx.dynamicKeys?.has(subtask.key)) continue;
    const verdict = ev.qaVerdicts?.[subtask.key];
    if (verdict === "passed") {
      evidence.push(`${subtask.key}: QA passed`);
    } else {
      missing.push(`${subtask.key}: QA verdict is ${verdict ?? "missing"}`);
    }
  }

  // No open issue with critical/high severity.
  const openSevere = ctx.openIssues.filter(
    (issue) => issue.status === "open" && (issue.severity === "critical" || issue.severity === "high")
  );
  if (openSevere.length > 0) {
    for (const issue of openSevere) {
      missing.push(`open ${issue.severity} issue: ${issue.description}`);
    }
  } else {
    evidence.push("no open critical/high issues");
  }

  // The last decision's expectedOutcome is met.
  if (ev.lastDecision?.expectedOutcome) {
    if (UNMET_OUTCOMES.has(ev.lastDecision.expectedOutcome)) {
      missing.push(`last decision outcome "${ev.lastDecision.expectedOutcome}" is not met`);
    } else {
      evidence.push(`last decision outcome "${ev.lastDecision.expectedOutcome}" met`);
    }
  }

  return { satisfied: missing.length === 0, evidence, missing };
}

export interface DecisionTask {
  key: string;
  title: string;
  description: string;
  kind: SubtaskKind;
  capability?: string;
}

export interface OrchestratorDecision {
  id: string;
  action: DecisionAction;
  /** <= 500 chars, persisted. */
  reasoning: string;
  target?: { agentId?: string; capability?: string };
  task?: DecisionTask;
  /** Batch form for `parallel`. */
  tasks?: DecisionTask[];
  dependencies?: string[];
  expectedOutcome?: string;
  question?: string;
  constraints?: {
    maxConcurrency?: number;
    deadlineMs?: number;
    requiresApproval?: boolean;
  };
  decidedBy: "deterministic" | "llm";
  planVersion: number;
  createdAt: number;
}

export type DecisionValidation =
  | { ok: true; decision: OrchestratorDecision }
  | { ok: false; reason: string; violated: "contract" | "policy" | "routing" };

export interface DecisionObservation {
  outcome: "completed" | "failed";
  /** The live `evaluateDelegation` verdict that produced this observation. */
  decision: DelegationDecision;
  nextAgent?: AgentDefinition | null;
  nextCapability?: string | null;
  reason: string;
  findings?: ReviewFinding[];
  delegationRecommendation?: { targetCapability: string; reason: string } | null;
  error?: string;
  /** Transient failures are the scheduler retry's job, not a new node. */
  retryable?: boolean;
}

const MAX_REASONING = 500;

function clampReasoning(value: string): string {
  return value.length > MAX_REASONING ? value.slice(0, MAX_REASONING) : value;
}

function isSubtaskKind(value: unknown): value is SubtaskKind {
  return (
    value === "analysis" ||
    value === "code_change" ||
    value === "review" ||
    value === "qa" ||
    value === "research" ||
    value === "audit" ||
    value === "shell"
  );
}

interface NormalizedDecision {
  action: DecisionAction;
  reasoning: string;
  target?: { agentId?: string; capability?: string };
  task?: DecisionTask;
  tasks?: DecisionTask[];
  dependencies?: string[];
  expectedOutcome?: string;
  question?: string;
  constraints?: OrchestratorDecision["constraints"];
}

function normalizeRawDecision(raw: unknown): { ok: true; value: NormalizedDecision } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "decision must be a JSON object" };
  }
  const record = raw as Record<string, unknown>;
  const action = record.action;
  if (typeof action !== "string" || !DECISION_ACTIONS.includes(action as DecisionAction)) {
    return { ok: false, reason: `unknown action: ${String(action)}` };
  }
  const reasoning = record.reasoning;
  if (typeof reasoning !== "string" || reasoning.trim().length === 0) {
    return { ok: false, reason: "reasoning must be a non-empty string" };
  }
  const target =
    record.target && typeof record.target === "object" && !Array.isArray(record.target)
      ? (record.target as { agentId?: unknown; capability?: unknown })
      : undefined;
  const task = normalizeTask(record.task);
  const tasks = Array.isArray(record.tasks)
    ? record.tasks.map((entry) => normalizeTask(entry))
    : undefined;
  if (tasks && tasks.some((entry) => entry === null)) {
    return { ok: false, reason: "every parallel task must be an object with key/title/description/kind" };
  }
  const dependencies =
    record.dependencies === undefined
      ? undefined
      : Array.isArray(record.dependencies) && record.dependencies.every((d) => typeof d === "string")
        ? (record.dependencies as string[])
        : undefined;
  if (record.dependencies !== undefined && dependencies === undefined) {
    return { ok: false, reason: "dependencies must be an array of strings" };
  }
  const expectedOutcome =
    typeof record.expectedOutcome === "string" && record.expectedOutcome.trim().length > 0
      ? record.expectedOutcome
      : undefined;
  const question =
    typeof record.question === "string" && record.question.trim().length > 0
      ? record.question
      : undefined;
  const constraints =
    record.constraints && typeof record.constraints === "object" && !Array.isArray(record.constraints)
      ? (record.constraints as OrchestratorDecision["constraints"])
      : undefined;
  return {
    ok: true,
    value: {
      action: action as DecisionAction,
      reasoning: clampReasoning(reasoning.trim()),
      target: target as DecisionTarget | undefined,
      task: task ?? undefined,
      tasks: tasks ? (tasks as DecisionTask[]) : undefined,
      dependencies,
      expectedOutcome,
      question,
      constraints,
    },
  };
}

type DecisionTarget = { agentId?: string; capability?: string };

function normalizeTask(raw: unknown): DecisionTask | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.key !== "string" ||
    record.key.trim().length === 0 ||
    typeof record.title !== "string" ||
    record.title.trim().length === 0 ||
    typeof record.description !== "string" ||
    !isSubtaskKind(record.kind)
  ) {
    return null;
  }
  return {
    key: record.key,
    title: record.title,
    description: record.description,
    kind: record.kind,
    capability: typeof record.capability === "string" ? record.capability : undefined,
  };
}

/**
 * Validate a decision request against the contract, the policy, and live
 * routing. Never throws: a rejection is a typed value the caller records.
 */
export function validateDecision(
  raw: unknown,
  ctx: DecisionContext,
  meta: { id: string; decidedBy: "deterministic" | "llm" }
): DecisionValidation {
  const normalized = normalizeRawDecision(raw);
  if (!normalized.ok) return { ok: false, reason: normalized.reason, violated: "contract" };
  const decision = normalized.value;

  if (decision.action === "complete") {
    if (!decision.expectedOutcome) {
      return { ok: false, reason: "complete requires an expectedOutcome", violated: "contract" };
    }
  }
  if (decision.action === "ask_user") {
    if (!decision.question) {
      return { ok: false, reason: "ask_user requires a question", violated: "contract" };
    }
  }

  const tasks: DecisionTask[] =
    decision.action === "parallel"
      ? decision.tasks ?? []
      : decision.task
        ? [decision.task]
        : [];

  if (decision.action === "execute" || decision.action === "delegate" || decision.action === "parallel") {
    if (decision.action === "parallel" && tasks.length === 0) {
      return { ok: false, reason: "parallel requires at least one task", violated: "contract" };
    }
    if (decision.action !== "parallel" && tasks.length === 0) {
      return { ok: false, reason: `${decision.action} requires a task`, violated: "contract" };
    }

    const existingKeys = new Set(ctx.plan.subtasks.map((subtask) => subtask.key));
    const batchKeys = new Set<string>();
    let capabilityMissing = false;

    for (const task of tasks) {
      const capability = task.capability ?? decision.target?.capability;
      if (typeof capability !== "string" || capability.trim().length === 0) {
        return { ok: false, reason: `task ${task.key} has no capability`, violated: "contract" };
      }
      if (existingKeys.has(task.key) || batchKeys.has(task.key)) {
        return { ok: false, reason: `duplicate subtask key: ${task.key}`, violated: "contract" };
      }
      batchKeys.add(task.key);
      if (!capabilityMissing && !routeCapability(capability, ctx.agents, { allowFallback: false })) {
        capabilityMissing = true;
      }
    }
    if (capabilityMissing) {
      return {
        ok: false,
        reason: "no enabled agent serves the requested capability (allowFallback is disabled)",
        violated: "routing",
      };
    }

    // Node budget: the plan may not grow past maxSubtasks.
    if (ctx.plan.subtasks.length + tasks.length > ctx.policy.maxSubtasks) {
      return {
        ok: false,
        reason: `node budget exceeded (${ctx.plan.subtasks.length}+${tasks.length} > ${ctx.policy.maxSubtasks})`,
        violated: "policy",
      };
    }

    // Dependencies must reference the existing plan or the same batch.
    const known = new Set([...existingKeys, ...batchKeys]);
    for (const task of tasks) {
      for (const dependency of decision.dependencies ?? []) {
        if (!known.has(dependency)) {
          return {
            ok: false,
            reason: `task ${task.key} depends on unknown subtask ${dependency}`,
            violated: "contract",
          };
        }
      }
    }

    // No cycle: merge the requested nodes with the plan and run the same
    // cycle detector the plan validator uses.
    const merged: PlanSubtask[] = [
      ...ctx.plan.subtasks,
      ...tasks.map((task) => ({
        key: task.key,
        title: task.title,
        description: task.description,
        kind: task.kind,
        capability: task.capability ?? decision.target?.capability ?? CAPABILITY.GENERAL,
        dependencies: decision.dependencies ?? [],
        order: ctx.plan.subtasks.length,
      })),
    ];
    const cycle = findCycle(merged);
    if (cycle) {
      return { ok: false, reason: `dependency cycle detected: ${cycle.join(" -> ")}`, violated: "contract" };
    }

    if (decision.action === "delegate") {
      const capability = tasks[0].capability ?? decision.target?.capability ?? "";
      const chain = ctx.chainCapabilities;
      if (chain && chain.length - 1 >= ctx.policy.maxDelegationDepth) {
        return {
          ok: false,
          reason: `delegation depth exhausted for this branch (${chain.length - 1}/${ctx.policy.maxDelegationDepth})`,
          violated: "policy",
        };
      }
      if (
        ctx.policy.maxDelegations !== undefined &&
        ctx.budget.delegationDepth >= ctx.policy.maxDelegations
      ) {
        return {
          ok: false,
          reason: `delegation budget exhausted (${ctx.budget.delegationDepth}/${ctx.policy.maxDelegations})`,
          violated: "policy",
        };
      }
      if (ctx.budget.agentCount >= ctx.policy.maxAgentsPerTask) {
        return {
          ok: false,
          reason: `agent budget exhausted (${ctx.budget.agentCount}/${ctx.policy.maxAgentsPerTask})`,
          violated: "policy",
        };
      }
      if (chain && preventCircularDelegation(chain, capability)) {
        return {
          ok: false,
          reason: `circular delegation prevented for capability ${capability}`,
          violated: "policy",
        };
      }
      const target = routeCapability(capability, ctx.agents, { allowFallback: false });
      if (target && ctx.activeByAgent) {
        const limit = target.maxConcurrency ?? 1;
        const active = ctx.activeByAgent.get(target._id) ?? 0;
        if (active >= limit) {
          return {
            ok: false,
            reason: `agent ${target.name} is at its concurrency limit (${active}/${limit})`,
            violated: "policy",
          };
        }
      }
    }
  }

  return {
    ok: true,
    decision: {
      id: meta.id,
      action: decision.action,
      reasoning: decision.reasoning,
      target: decision.target,
      task: decision.task,
      tasks: decision.tasks,
      dependencies: decision.dependencies,
      expectedOutcome: decision.expectedOutcome,
      question: decision.question,
      constraints: decision.constraints,
      decidedBy: meta.decidedBy,
      planVersion: ctx.planVersion,
      createdAt: Date.now(),
    },
  };
}

/**
 * Deterministic decision. Returns `"ambiguous"` when the observation does
 * not map to a clear request — the only case where the LLM advisor may be
 * consulted (policy `decisionLlmMode`).
 */
export function nextDeterministicDecision(
  ctx: DecisionContext,
  observation: DecisionObservation
): OrchestratorDecision | "ambiguous" {
  const base = {
    id: "",
    planVersion: ctx.planVersion,
    createdAt: Date.now(),
    decidedBy: "deterministic" as const,
  };

  if (observation.outcome === "failed") {
    if (observation.retryable) {
      // The scheduler owns backoff for transient failures.
      return {
        ...base,
        action: "execute",
        reasoning: clampReasoning(observation.error ?? observation.reason).slice(0, MAX_REASONING),
        expectedOutcome: "retry",
      };
    }
    // A permanent failure with no findings: no capability can be named, so
    // the request is a replan. Phase 5 gives this a real implementation.
    return {
      ...base,
      action: "replan",
      reasoning: clampReasoning(observation.error ?? observation.reason).slice(0, MAX_REASONING),
      expectedOutcome: "recovery",
    };
  }

  switch (observation.decision) {
    case "BLOCKED":
      return {
        ...base,
        action: "complete",
        reasoning: clampReasoning(observation.reason).slice(0, MAX_REASONING),
        expectedOutcome: "policy:budget",
      };
    case "APPROVE": {
      const capability = observation.nextCapability;
      if (!capability) return "ambiguous";
      return {
        ...base,
        action: "delegate",
        reasoning: clampReasoning(observation.reason).slice(0, MAX_REASONING),
        target: {
          agentId: observation.nextAgent?._id,
          capability,
        },
        expectedOutcome: "delegated",
      };
    }
    case "REVISE": {
      const capability = observation.nextCapability;
      if (!capability || observation.findings?.length === 0) return "ambiguous";
      return {
        ...base,
        action: "execute",
        reasoning: clampReasoning(observation.reason).slice(0, MAX_REASONING),
        target: {
          agentId: observation.nextAgent?._id,
          capability,
        },
        task: {
          key: "",
          title: "Address findings",
          description: "Address the reported findings and return the updated file content.",
          kind: "code_change",
          capability,
        },
        expectedOutcome: "fixed",
      };
    }
    case "REJECT":
      // A rejected proposal requests no new work; the plan continues.
      return {
        ...base,
        action: "complete",
        reasoning: clampReasoning(observation.reason).slice(0, MAX_REASONING),
        expectedOutcome: "proposal:rejected",
      };
    case "COMPLETE":
      return {
        ...base,
        action: "complete",
        reasoning: clampReasoning(observation.reason).slice(0, MAX_REASONING),
        expectedOutcome: "objective:met",
      };
    default:
      return "ambiguous";
  }
}

export interface DecideOptions {
  id?: string;
  llmMode?: "off" | "ambiguous" | "always";
  /** Injected LLM advisor (decisionLlm.decideWithLlm); absent in tests that use a fake. */
  advise?: (ctx: DecisionContext, observation: DecisionObservation) => Promise<unknown>;
}

export interface DecideResult {
  decision: OrchestratorDecision;
  /** Set when the advisor failed and the deterministic decision was used. */
  fallback?: string;
}

/**
 * One decision step: deterministic first, advisor only on "ambiguous"
 * (or "always"), validated, with fallback. Never throws.
 */
export async function decide(
  ctx: DecisionContext,
  observation: DecisionObservation,
  options: DecideOptions = {}
): Promise<DecideResult> {
  const id = options.id ?? `dec_${ctx.taskId}_${ctx.step}`;
  const mode = options.llmMode ?? ctx.policy.decisionLlmMode ?? "off";
  const maxSteps = ctx.policy.maxDecisionSteps ?? 20;

  if (ctx.step >= maxSteps) {
    return {
      decision: {
        id,
        action: "complete",
        reasoning: `decision step limit reached (${ctx.step}/${maxSteps})`,
        expectedOutcome: "decision:step_limit",
        decidedBy: "deterministic",
        planVersion: ctx.planVersion,
        createdAt: Date.now(),
      },
    };
  }

  const det = nextDeterministicDecision(ctx, observation);
  const detDecision = (): OrchestratorDecision =>
    det === "ambiguous"
      ? {
          id,
          action: "complete",
          reasoning: "observation is ambiguous; no work requested",
          expectedOutcome: "ambiguous:no-op",
          decidedBy: "deterministic",
          planVersion: ctx.planVersion,
          createdAt: Date.now(),
        }
      : { ...det, id };

  if (mode === "off") {
    return { decision: detDecision(), ...(det === "ambiguous" ? { fallback: "ambiguous, mode off" } : {}) };
  }

  const consultAdvisor = mode === "always" || det === "ambiguous";
  if (!consultAdvisor || !options.advise) {
    return {
      decision: detDecision(),
      ...(det === "ambiguous" ? { fallback: "advisor unavailable" } : {}),
    };
  }

  try {
    const raw = await options.advise(ctx, observation);
    const validation = validateDecision(raw, ctx, { id, decidedBy: "llm" });
    if (!validation.ok) {
      return { decision: detDecision(), fallback: `advisor validation failed: ${validation.reason}` };
    }
    return { decision: validation.decision };
  } catch (error) {
    return {
      decision: detDecision(),
      fallback: `advisor failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface AppliedDecision {
  nodes: PlanSubtask[];
  /** Phase 2: always false — complete/replan are recorded no-ops here. */
  halt: boolean;
  note: string;
}

/**
 * Pure applier: turn a validated decision into the dynamic nodes the
 * runner persists. Keys are filled here via the injected `uniqueKey`.
 * `replan` and `complete` are recorded no-ops until Phase 5.
 */
export function applyDecision(
  ctx: DecisionContext,
  decision: OrchestratorDecision,
  uniqueKey: (base: string) => string
): AppliedDecision {
  const order = ctx.plan.subtasks.length;
  const toNode = (task: DecisionTask, index: number): PlanSubtask => {
    const capability = task.capability ?? decision.target?.capability ?? CAPABILITY.GENERAL;
    const key = task.key && task.key.trim().length > 0 ? task.key : uniqueKey(`decision_${decision.action}`);
    return {
      key,
      title: task.title || `Decision ${decision.action}`,
      description: task.description || decision.reasoning,
      kind: task.kind,
      capability,
      dependencies: decision.dependencies ?? (index === 0 && ctx.completedKeys.size > 0 ? [lastCompleted(ctx)] : []),
      order: order + index,
    };
  };

  switch (decision.action) {
    case "execute":
    case "delegate": {
      const task = decision.task
        ? { ...decision.task, capability: decision.task.capability ?? decision.target?.capability }
        : decision.target?.capability
          ? {
              key: "",
              title: decision.action === "delegate" ? "Delegated work" : "Execute",
              description: decision.reasoning,
              kind: kindForCapabilityForApply(decision.target.capability),
              capability: decision.target.capability,
            }
          : undefined;
      if (!task) return { nodes: [], halt: false, note: `${decision.action} without task or target — no nodes` };
      return { nodes: [toNode(task, 0)], halt: false, note: decision.action };
    }
    case "parallel": {
      const tasks = decision.tasks ?? (decision.task ? [decision.task] : []);
      return { nodes: tasks.map((task, index) => toNode(task, index)), halt: false, note: "parallel" };
    }
    case "replan":
      return { nodes: [], halt: false, note: "replan recorded as no-op in Phase 2 (Phase 5 implements it)" };
    case "complete":
      return { nodes: [], halt: false, note: decision.expectedOutcome ?? "complete recorded as no-op in Phase 2" };
    case "ask_user":
      return { nodes: [], halt: false, note: decision.question ?? "ask_user recorded as no-op in Phase 2" };
    default:
      return { nodes: [], halt: false, note: "unknown action — no nodes" };
  }
}

function lastCompleted(ctx: DecisionContext): string {
  return [...ctx.completedKeys].at(-1) ?? "";
}

function kindForCapabilityForApply(capability: string): SubtaskKind {
  return kindForCapability(capability);
}

/**
 * Map a capability to the subtask kind that executes it. Shared by the
 * decision engine's node building and the runner's dynamic nodes.
 */
export function kindForCapability(capability: string): SubtaskKind {
  switch (normalizeCapability(capability)) {
    case CAPABILITY.BROWSER_TESTING:
      return "qa";
    case CAPABILITY.CODE_REVIEW:
      return "review";
    case CAPABILITY.FRONTEND:
    case CAPABILITY.BACKEND:
    case CAPABILITY.GITHUB:
      return "code_change";
    case CAPABILITY.SECURITY:
      return "audit";
    case CAPABILITY.RESEARCH:
      return "research";
    case CAPABILITY.SHELL_EXECUTION:
      return "shell";
    default:
      return "analysis";
  }
}


