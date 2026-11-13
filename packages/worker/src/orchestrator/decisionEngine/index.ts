import type { AgentDefinition, PlanSubtask } from "@/types";
import {
  applyDecision,
  decide,
  type DecideOptions,
  type DecisionContext,
  type DecisionObservation,
  type OrchestratorDecision,
} from "../decision";
import { directiveFor, isStepLimit, resolveTargetAgent, type OverrideState, type RunnerDirective } from "./overrides";
import type { ReplanObservation } from "./replan";
import type { FixNeededObservation } from "./fixOwner";
import type { RetryObservation } from "./retry";

/**
 * P1b phase 1: the Decision Engine seam.
 *
 * The single place the runner asks "given this observation, what next?".
 * A settled node goes through three calls, in this order:
 *
 *   1. `judgeObjective`  — is the objective judgeable now, and is it met?
 *                          (the runner logs `orchestrator.objective_unmet`
 *                          from `judgment.unmet` before deciding)
 *   2. `decideNext`      — deterministic decision, optional LLM advisor,
 *                          validation, fallback; flags the step bound.
 *   3. `directNext`      — apply the decision and every runner veto, and
 *                          return the one `RunnerDirective` to perform.
 *
 * The runner (`services/runner/decision.ts`) keeps only side effects:
 * events, persistence, latches, messages. Everything here is pure except
 * the advisor call `decide()` already owned.
 *
 * Later phases extend this seam rather than adding decision points
 * elsewhere (see `EngineObservation` / `NextStep` below):
 *   - L6 (one replan owner, done): `decisionEngine/replan.ts` exports
 *     `decideReplan(observation)`, re-exported here. taskRunner has one
 *     call site; executePlan's acceptance / coverage gates ask it too.
 *   - L7 (stage-loop owners, done): `decisionEngine/fixOwner.ts` exports
 *     `decideFixOwner(observation)`, re-exported here. The QA / verify /
 *     review loops report `fix_needed` and switch on spawn_fix / block.
 *   - L8 (scheduler purification, done): `decisionEngine/retry.ts` exports
 *     `decideRetry(observation)` and `classifyFailure(error)`, re-exported
 *     here. The scheduler reports `failed` / `stalled`, runNodes reports
 *     `prerequisite_missing` / `unroutable` / `runtime_unavailable`, and
 *     each performs the `RetryDecision` it gets back.
 */

export { evaluateObjective, isRecoveryNode, requiresScaffold, judgeObjective, reviewQaInFlight } from "./objective";
export type { ObjectiveEvaluation, ObjectiveEvidence, ObjectiveJudgment, ObjectiveJudgeInput, ObjectiveState } from "./objective";
export {
  canPauseForInput,
  directiveFor,
  firstReplanFeedback,
  isQaNode,
  isStepLimit,
  resolveTargetAgent,
  shouldLatchBudgetHalt,
  shouldLatchComplete,
  vetoReplan,
  vetoSpawn,
} from "./overrides";
export type { OverrideState, QaSpawnPlan, ReplanVeto, RunnerDirective, SpawnVerdict } from "./overrides";
export { decideReplan } from "./replan";
export type { ReplanDecision, ReplanFacts, ReplanObservation, ReplanTrigger } from "./replan";
export { attributeFinding, decideFixOwner, fixRoundsExhausted, pickQaFixOwner, QA_UI_CAPABILITIES, verifyFixKey } from "./fixOwner";
export type { FixNeededFacts, FixNeededObservation, FixOwnerDecision, FixStage } from "./fixOwner";
export { FAILURE_KINDS, failureKindForEnding, failureKindForExit, isFailureKind } from "./failureKind";
export type { FailureKind } from "./failureKind";
export { decideApprovalGate, decideStageOrder, reviewFixRoundsSpent } from "./stageOrder";
export type { ApprovalGateDecision, ApprovalGateFacts, SnapshotReviewVerdict, StageOrder, StageOrderDecision } from "./stageOrder";
export { classifyFailure, decideRetry, isPermanentSubtaskError, isRetryableClass, shouldRetrySubtask } from "./retry";
export type {
  FailedObservation,
  FailureClass,
  PrerequisiteMissingObservation,
  RetryDecision,
  RetryObservation,
  RuntimeUnavailableObservation,
  StalledObservation,
  UnroutableObservation,
} from "./retry";

export interface DecideNextResult {
  decision: OrchestratorDecision;
  /** Set when the advisor failed and the deterministic decision was used. */
  fallback?: string;
  /** The step bound fired: terminal, the runner latches the halt and stops here. */
  stepLimit: boolean;
}

/** Step 2: one decision for an observation that already carries its objective state. */
export async function decideNext(
  context: DecisionContext,
  observation: DecisionObservation,
  options: DecideOptions
): Promise<DecideNextResult> {
  const { decision, fallback } = await decide(context, observation, options);
  return { decision, fallback, stepLimit: isStepLimit(decision) };
}

/** Step 3: the applied decision after every runner veto. */
export function directNext(
  context: DecisionContext,
  decision: OrchestratorDecision,
  state: OverrideState,
  replanFeedback: string | null,
  uniqueKey: (base: string) => string
): RunnerDirective {
  return directiveFor(applyDecision(context, decision, uniqueKey), decision, state, replanFeedback);
}

/** The agent a delegate / call_agent decision addresses (one routing rule for both). */
export function targetAgent<A extends AgentDefinition>(
  decision: OrchestratorDecision,
  agents: A[],
  allowFallback: boolean | undefined
): A | undefined {
  return resolveTargetAgent(decision, agents, { allowFallback });
}

// ---------------------------------------------------------------------------
// The target vocabulary (P1b "Target"). Phase 1 only emits RunnerDirective;
// these types are the contract L6-L8 implement against, so every later
// decision point speaks the same language.
// ---------------------------------------------------------------------------

/** A typed observation a mechanical layer reports to the engine. */
export type EngineObservation =
  | { kind: "settled"; nodeKey: string; status: "completed" | "failed" }
  | RetryObservation
  | ReplanObservation
  | FixNeededObservation;

/** What the engine tells a caller to do next. */
export type NextStep =
  | { kind: "execute"; nodeKey: string }
  | { kind: "retry"; nodeKey: string; afterMs: number }
  | { kind: "delegate"; capability: string; agentId?: string }
  | { kind: "spawn_fix"; ownerAgentId: string; nodes: PlanSubtask[] }
  | { kind: "replan"; reason: string }
  | { kind: "ask_user"; question: string; options?: string[] }
  | { kind: "ask_cto"; reason: string }
  | { kind: "block"; reason: string }
  | { kind: "complete" }
  | { kind: "halt"; reason: string };
