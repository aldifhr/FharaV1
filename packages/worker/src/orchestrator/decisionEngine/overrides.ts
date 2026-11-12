import { CAPABILITY, type AgentDefinition, type ExecutionPlan, type PlanSubtask, type SubtaskKind } from "@/types";
import { normalizeCapability, routeCapability } from "../capabilities";
import type { AppliedDecision, OrchestratorDecision } from "../decision";
import { feedsResearchSynthesis } from "@/prompts/research";

/**
 * P1b phase 1 (Decision Engine seam): the runner's vetoes on an applied
 * decision, moved out of `services/runner/decision.ts` as pure functions.
 * Each one answers a single question from plain inputs; the runner only
 * performs the side effects (events, persistence, latches) they ask for.
 * Behaviour is unchanged: tests/decisionEngine.golden.test.ts pins the
 * event sequences recorded before the move.
 */

/** Live run facts the vetoes read. Plain values, so every veto stays pure. */
export interface OverrideState {
  plan: ExecutionPlan;
  /** The settled node. */
  nodeKey: string;
  /** The settled node's subtask kind, if it is in the plan. */
  nodeKind?: SubtaskKind;
  completedKeys: ReadonlySet<string>;
  dynamicKeys: ReadonlySet<string>;
  /** The node executed in THIS run (it has an execution id). */
  executed: boolean;
  inStageLoop: boolean;
  /** Planned QA nodes already queued for the post-apply QA stage. */
  plannedQaCount: number;
  qaMode: string | undefined;
  budgetEnforced: boolean;
  budgetHalted: boolean;
  /** A pause for input already applied this run (first pause wins). */
  waitingForInput: boolean;
}

/** QA-shaped work: a qa node or a browser-testing capability. */
export function isQaNode(node: Pick<PlanSubtask, "kind" | "capability">): boolean {
  return node.kind === "qa" || normalizeCapability(node.capability) === CAPABILITY.BROWSER_TESTING;
}

/** What to do with dynamic QA spawned by a decision (QA audit P0-3). */
export interface QaSpawnPlan {
  keys: string[];
  /** true → defer to the post-apply QA stage (`qa.deferred`); false → drop (`qa.suppressed`). */
  keep: boolean;
  reason: string;
  /** The nodes to queue for the QA stage (kind forced to qa); empty when dropped. */
  deferred: PlanSubtask[];
}

export type SpawnVerdict =
  /** Review-kind nodes are owned by the review loop: a REVISE never spawns an engine fix. */
  | { kind: "suppressed_review_fix" }
  | { kind: "spawn"; qa: QaSpawnPlan | null; nodes: PlanSubtask[]; origin: "fix" | "delegation" };

/**
 * The `nodes` outcome: which spawned nodes run now. Dynamic QA is
 * suppressed under qaMode=never, dropped when the plan already has QA nodes,
 * and otherwise deferred to the post-apply QA stage instead of running now
 * against the unapplied workspace.
 */
export function vetoSpawn(
  state: Pick<OverrideState, "nodeKind" | "plannedQaCount" | "qaMode">,
  action: OrchestratorDecision["action"],
  nodes: PlanSubtask[]
): SpawnVerdict {
  if (state.nodeKind === "review" && action === "execute") return { kind: "suppressed_review_fix" };
  const qaSpawned = nodes.filter(isQaNode);
  let qa: QaSpawnPlan | null = null;
  if (qaSpawned.length > 0) {
    const keep = state.qaMode !== "never" && state.plannedQaCount === 0;
    qa = {
      keys: qaSpawned.map((n) => n.key),
      keep,
      reason: keep
        ? "dynamic QA runs in the post-apply QA stage"
        : state.qaMode === "never"
          ? "qaMode=never"
          : "plan already has QA nodes",
      deferred: keep ? qaSpawned.map((n) => ({ ...n, kind: "qa" as const })) : [],
    };
  }
  return {
    kind: "spawn",
    qa,
    nodes: nodes.filter((n) => !isQaNode(n)),
    origin: action === "execute" ? "fix" : "delegation",
  };
}

/** The `halt` outcome: only enforce mode latches, once (warn mode is advisory). */
export function shouldLatchBudgetHalt(state: Pick<OverrideState, "budgetEnforced" | "budgetHalted">): boolean {
  return state.budgetEnforced && !state.budgetHalted;
}

/**
 * The `complete` outcome latches the terminal flag only for an objective
 * judged on work THIS run executed, when no planned node remains pending
 * and no stage loop owns the run (plan 011 step 4, plan 013 step 3).
 */
export function shouldLatchComplete(
  state: Pick<OverrideState, "plan" | "nodeKey" | "completedKeys" | "executed" | "inStageLoop">,
  expectedOutcome: string | undefined
): boolean {
  const noPlannedPending = state.plan.subtasks.every(
    (candidate) => candidate.key === state.nodeKey || state.completedKeys.has(candidate.key)
  );
  return expectedOutcome === "objective:met" && state.executed && noPlannedPending && !state.inStageLoop;
}

/** Why a requested replan does not latch now; null when it latches. */
export type ReplanVeto = "recovery_pending" | "stage_loop" | "research_angle" | null;

/**
 * The `replan` outcome. Deferred while spawned recovery work is pending (a
 * replan would discard the fix meant to close the gap, plan 013 step 7),
 * while a stage loop owns recovery of its own nodes, and for a failed
 * /research angle (the synthesis runs on the angles that succeeded, O7).
 */
export function vetoReplan(state: Pick<OverrideState, "plan" | "nodeKey" | "completedKeys" | "dynamicKeys" | "inStageLoop">): ReplanVeto {
  const recoveryPending = state.plan.subtasks.some(
    (candidate) => state.dynamicKeys.has(candidate.key) && !state.completedKeys.has(candidate.key)
  );
  if (recoveryPending) return "recovery_pending";
  if (state.inStageLoop) return "stage_loop";
  if (feedsResearchSynthesis(state.plan.subtasks, state.nodeKey)) return "research_angle";
  return null;
}

/** First request wins: the earliest missing list is the feedback the bounded re-plan addresses. */
export function firstReplanFeedback(current: string | null, reason: string): string {
  return current === null ? reason : current;
}

/** The `ask_user` outcome: the first applied pause wins. */
export function canPauseForInput(state: Pick<OverrideState, "waitingForInput">): boolean {
  return !state.waitingForInput;
}

/**
 * The agent a `delegate` / `call_agent` decision addresses. A delegate
 * names an agent id first, then a capability; a call_agent only routes
 * its capability (the agent id is not consulted, as before).
 */
export function resolveTargetAgent<A extends AgentDefinition>(
  decision: Pick<OrchestratorDecision, "action" | "target">,
  agents: A[],
  options: { allowFallback?: boolean }
): A | undefined {
  const target = decision.target;
  if (decision.action === "delegate" && target?.agentId) {
    return agents.find((candidate) => candidate._id === target.agentId);
  }
  return target?.capability ? (routeCapability(target.capability, agents, { allowFallback: options.allowFallback }) as A | undefined) : undefined;
}

/** The engine's deterministic step bound fired (plan 005 step 5.4): terminal, never a silent done. */
export function isStepLimit(decision: Pick<OrchestratorDecision, "expectedOutcome">): boolean {
  return decision.expectedOutcome === "decision:step_limit";
}

/**
 * The runner's directive for one applied decision: the engine's applied
 * outcome after every veto above. The runner performs exactly this.
 */
export type RunnerDirective =
  | { kind: "none" }
  | ({ kind: "spawn" } & Extract<SpawnVerdict, { kind: "spawn" }>)
  | { kind: "halt_budget"; reason: string }
  | { kind: "complete"; expectedOutcome: string }
  | { kind: "replan"; feedback: string }
  | { kind: "ask_user"; question: string; options?: string[] }
  | { kind: "call_agent"; capability: string };

/** Fold an applied decision and the run state into one directive. */
export function directiveFor(
  applied: AppliedDecision,
  decision: Pick<OrchestratorDecision, "action">,
  state: OverrideState,
  replanFeedback: string | null
): RunnerDirective {
  switch (applied.kind) {
    case "nodes": {
      const verdict = vetoSpawn(state, decision.action, applied.nodes);
      return verdict.kind === "spawn" ? { ...verdict, kind: "spawn" } : { kind: "none" };
    }
    case "halt":
      return shouldLatchBudgetHalt(state) ? { kind: "halt_budget", reason: applied.reason } : { kind: "none" };
    case "complete":
      return shouldLatchComplete(state, applied.expectedOutcome)
        ? { kind: "complete", expectedOutcome: applied.expectedOutcome! }
        : { kind: "none" };
    case "replan":
      return vetoReplan(state) === null
        ? { kind: "replan", feedback: firstReplanFeedback(replanFeedback, applied.reason) }
        : { kind: "none" };
    case "ask_user":
      return canPauseForInput(state)
        ? { kind: "ask_user", question: applied.question, options: applied.options }
        : { kind: "none" };
    case "call_agent":
      return { kind: "call_agent", capability: applied.capability };
  }
}
