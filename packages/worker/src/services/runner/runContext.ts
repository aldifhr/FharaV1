import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CAPABILITY, type AgentDefinition, type PlanSubtask } from "@/types";
import { routeCapability } from "@/orchestrator/capabilities";
import { loadAwareRoutingEnabled, pickLoadAware, type LoadAwareDecision } from "@/orchestrator/loadAwareRouting";
import { performanceRoutingEnabled, pickByPerformance, type PerformanceDecision } from "@/orchestrator/performanceRouting";
import type { PerformanceScore } from "@/api/convex/lib/agentPerformance";
import type { ModelRoutingInfo } from "@/llm/resolver";
import type { WebClient } from "@/tools/webClient";
import { applyFileChange, hashContent, type FileDiff } from "@/tools/gitDiff";
import { applyUnderLedger, ledgerOf } from "./applyLedger";
import type { WorkerExecutionId } from "@/workerApi";
import type { DynamicSubtaskOrigin } from "@/types/subtask";
import type { ApplyStagedResult, ExecutePlanInput, RunContext } from "./types";
import { runNodes } from "./runNodes";
import { RepeatedOutputGuard, stallThresholdsFromEnv } from "@/utils/stallDetector";
import { llmTimeoutMs } from "@/llm";

/**
 * Build the RunContext for one `executePlan` invocation (plan 012 step 3).
 * Every extracted stage (runNodes, handleNodeOutcome, the review / QA /
 * verification loops) and the stage driver itself read and write the run's
 * state through this one object, so latch values are always shared.
 */
export function createRunContext(input: ExecutePlanInput, browser: WebClient): RunContext {
  const { deps, task, project, plan, state } = input;
  const taskId = task._id;
  const implementationNodes = plan.subtasks.filter(
    (subtask) => subtask.kind !== "qa" && subtask.kind !== "review"
  );
  const reviewNodes = plan.subtasks.filter((subtask) => subtask.kind === "review");
  const qaNodes = plan.subtasks.filter((subtask) => subtask.kind === "qa");
  // Capabilities the STORED plan already schedules (computed before any
  // dynamic node is added). Delegation heuristics consult this so they never
  // spawn a duplicate of work the plan will run anyway.
  const plannedCapabilities = plan.subtasks.map((subtask) => subtask.capability);

  const agentByKey = new Map<string, AgentDefinition>();
  const loadAwareRouting = loadAwareRoutingEnabled(
    project as { loadAwareRouting?: unknown },
    deps.policy.loadAwareRouting
  );
  const performanceRouting = performanceRoutingEnabled(
    project as { performanceRouting?: unknown },
    deps.policy.performanceRouting
  );
  const loadSnapshot = new Map<string, number>();
  const loadAwareByKey = new Map<string, LoadAwareDecision>();
  const performanceScores = new Map<string, PerformanceScore>();
  const performanceByKey = new Map<string, PerformanceDecision>();
  const modelRoutingByKey = new Map<string, ModelRoutingInfo>();

  const activeByAgent = new Map<string, number>();
  // Per-branch capability chain per subtask key (root first, ending with
  // the subtask's own capability). Delegation depth and circularity are
  // derived from this chain — never from a task-global counter.
  const chainByKey = new Map<string, string[]>();
  // How many orchestrator fix rounds a subtask already sits in (0 = plan
  // or delegation subtask, 1 = fix subtask). Fix subtasks do not spawn
  // further fixes from evaluations; the review loop owns its iterations.
  const fixDepthByKey = new Map<string, number>();
  for (const subtask of plan.subtasks) {
    chainByKey.set(subtask.key, [subtask.capability]);
    fixDepthByKey.set(subtask.key, 0);
  }

  /**
   * Durable dynamic DAG (Phase 4 hardening): persist a freshly spawned
   * subtask (and the plan payload containing it) at the moment it is
   * added, so recovery after a worker restart sees the whole DAG.
   * Fail-closed: if persistence fails we log then re-throw, so the
   * scheduler never runs a node that isn't in the durable DAG.
   */
  const persistDynamic = async (
    added: PlanSubtask[],
    origin: DynamicSubtaskOrigin
  ): Promise<void> => {
    if (!input.onDynamicSubtasks || added.length === 0) return;
    try {
      await input.onDynamicSubtasks({
        added,
        origin,
        plan,
        version: input.planVersion ?? plan.version,
      });
    } catch (error) {
      await deps.api
        .logEvent({
          taskId,
          projectId: project._id,
          type: "plan.dynamic_persist_failed",
          payload: {
            keys: added.map((subtask) => subtask.key),
            origin,
            message: error instanceof Error ? error.message : String(error),
          },
          level: "error",
        })
        .catch(() => undefined);
      throw error;
    }
  };

  const assign = (key: string): AgentDefinition | null => {
    const existing = agentByKey.get(key);
    if (existing) return existing;
    const subtask = plan.subtasks.find((candidate) => candidate.key === key);
    if (!subtask) return null;
    // Plan 040 (D8): capability routing only. No fallback owner (the old
    // last resort was the highest-priority agent, i.e. the CTO, and the CTO
    // also covered a review with no Reviewer). An unrouted node is BLOCKED
    // with its reason by runNodes. ORCHESTRATOR_ALLOW_FALLBACK=true keeps
    // the old last resort (never the CTO) for implementation nodes.
    let agent = routeCapability(subtask.capability, input.agents, {
      allowFallback:
        deps.policy.allowFallback === true &&
        subtask.kind !== "qa" &&
        subtask.kind !== "review" &&
        subtask.capability !== CAPABILITY.BROWSER_TESTING,
    });
    // Plan 027 (opt-in): performance routing ranks exact-capability
    // agents by availability → score → budget → order. It includes the
    // capacity rule, so it supersedes load-aware when on.
    const loadOf = (candidate: AgentDefinition) =>
      Math.max(activeByAgent.get(candidate._id) ?? 0, loadSnapshot.get(candidate._id) ?? 0);
    if (agent && performanceRouting) {
      const snapshot = input.budget?.snapshot();
      const pick = pickByPerformance(agent, subtask.capability, input.agents, {
        loadOf,
        scoreOf: (candidate, capability) => performanceScores.get(`${candidate._id}::${capability}`),
        remainingTokens: snapshot ? Math.max(0, snapshot.maxTokenBudget - snapshot.totalTokens) : null,
      });
      if (pick.agent) agent = pick.agent;
      if (pick.performance) performanceByKey.set(key, pick.performance);
    } else if (agent && loadAwareRouting) {
    // Workload Manager (opt-in): among agents declaring the capability
    // exactly, prefer spare capacity. Live load = max(this run's own
    // count, the cross-task snapshot read at the start of runNodes).
      const pick = pickLoadAware(agent, subtask.capability, input.agents, (candidate) =>
        Math.max(activeByAgent.get(candidate._id) ?? 0, loadSnapshot.get(candidate._id) ?? 0)
      );
      if (pick.agent && pick.loadAware) {
        agent = pick.agent;
        loadAwareByKey.set(key, pick.loadAware);
      }
    }
    if (agent) agentByKey.set(key, agent);
    return agent;
  };

  /**
   * Plan 005 Step 5.2: the ONE place staged file changes reach the
   * workspace. Shared by the main apply phase and the QA-fix loop so a QA
   * correction actually lands before QA re-runs against the running app.
   * A stop result maps to the caller's terminal outcome — a cancellation
   * or an apply failure is never retried or replanned here.
   */
  const applyStaged = async (
    changes: FileDiff[],
    actor: "user" | "orchestrator"
  ): Promise<ApplyStagedResult> => {
    if (changes.length === 0) return { applied: [] };
    const wp = input.workspacePath;
    const appliedPaths: string[] = [];
    // L6: the writes run under the no-replay ledger when the API has it.
    const ledger = ledgerOf(deps.api);
    if (ledger) {
      const outcome = await applyUnderLedger<ApplyStagedResult>({
        api: ledger,
        workerId: deps.workerId,
        taskId,
        projectId: project._id,
        workspaceRoot: wp,
        changes,
        writeAll: () => writeAll(changes, appliedPaths),
        isStop: (result) => "stop" in result,
      });
      if (outcome.kind === "ambiguous") {
        state.feedback.push(`Apply not confirmed: ${outcome.reason}`);
        await deps.api
          .logEvent({ taskId, projectId: project._id, type: "fileChanges.apply_ambiguous", payload: { reason: outcome.reason }, level: "error" })
          .catch(() => undefined);
        return { stop: "failed" };
      }
      if (outcome.kind === "result" && "stop" in outcome.result) return outcome.result;
      if (outcome.kind === "already_applied") {
        appliedPaths.splice(0, appliedPaths.length, ...changes.map((change) => change.filePath));
      }
    } else {
      const result = await writeAll(changes, appliedPaths);
      if ("stop" in result) return result;
    }
    return await recordApplied(appliedPaths, actor);
  };

  /** The file writes of one apply (hash-guarded, verified after each write). */
  const writeAll = async (changes: FileDiff[], appliedPaths: string[]): Promise<ApplyStagedResult> => {
    const wp = input.workspacePath;
    for (const change of changes) {
      // A cancel/deadline that landed while the scheduler was running
      // stops the apply phase too: no further files are written.
      if (input.taskAbort?.signal.aborted) {
        state.feedback.push("Apply aborted: the task was cancelled or timed out");
        return { stop: "cancelled" };
      }
      try {
        await applyFileChange(wp, change);
        const verified = await fs.readFile(path.join(wp, change.filePath), "utf-8");
        if (hashContent(verified) !== hashContent(change.newContent ?? "")) {
          throw new Error(`${change.filePath}: content mismatch after apply`);
        }
        appliedPaths.push(change.filePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await deps.api.logEvent({
          taskId,
          projectId: project._id,
          type: "fileChanges.apply_failed",
          payload: { message },
          level: "error",
        });
        state.feedback.push(`Apply failed: ${message}`);
        return { stop: "failed" };
      }
    }
    return { applied: appliedPaths };
  };

  const recordApplied = async (appliedPaths: string[], actor: "user" | "orchestrator"): Promise<ApplyStagedResult> => {
    if (appliedPaths.length > 0) {
      await deps.api.markFilesApplied({
        taskId,
        filePaths: appliedPaths,
        workerId: deps.workerId,
      });
      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "fileChanges.applied",
        payload: { filePaths: appliedPaths },
      });
      await deps.api.recordAudit({
        taskId,
        projectId: project._id,
        workerId: deps.workerId,
        actor,
        tool: "apply_changes",
        action: "apply",
        decision: "allowed",
        target: appliedPaths.join(","),
        details: { filePaths: appliedPaths, planVersion: plan.version },
      });
    }
    return { applied: appliedPaths };
  };

  const stallThresholds = stallThresholdsFromEnv(undefined, llmTimeoutMs());
  const ctx: RunContext = {
    input,
    stallThresholds,
    repeatGuard: new RepeatedOutputGuard(stallThresholds.repeatedOutputLimit),
    deps,
    task,
    project,
    plan,
    state,
    agents: input.agents,
    browser,
    taskId,
    implementationNodes,
    reviewNodes,
    qaNodes,
    reviewNodeKeys: reviewNodes.map((node) => node.key),
    plannedCapabilities,
    // Latched when an evaluation returns BLOCKED (budget), unless the
    // policy is in warn mode: the scheduler stops starting new nodes and
    // blocks the pending ones gracefully. Warn mode (the Phase 5
    // default from loadPolicy) is the explicit opt-out for this release
    // cycle: a BLOCKED evaluation is advisory only — it never halts
    // scheduling; the budget.warning event from the pre-call gate is the
    // visible signal and the run continues to completion. Policies that
    // predate budgetMode (field unset) keep the historical halt.
    budgetEnforced: deps.policy.budgetMode !== "warn",
    // Authoritative mode is active only when the policy flag is on AND the
    // orchestrator wiring (budget/context/classification) is present.
    // Since Phase 4 both processTask and resumeTask pass the wiring (the
    // resume path builds its state from the DB via buildStateFromDb), so
    // authoritative evaluation applies on resumed runs too.
    authoritative:
      deps.policy.orchestratorAuthoritative === true &&
      Boolean(input.budget && input.sharedContext && input.classification),
    // (Plan 006 Phase 2: the decision engine is the only orchestrator
    // path — the advisory legacy branch and its flag were deleted in
    // plan 013 step 7.)
    decisionEngine: true,
    decisionStep: 0,
    stepLimitHit: false,
    budgetHalt: false,
    cancelled: false,
    decisionTerminal: false,
    replanFeedback: null,
    waitingForInput: null,
    escalated: false,
    paused: false,
    pendingApproval: false,
    delegationSeq: 0,
    fixSeq: 0,
    lastStatusCheck: 0,
    inStageLoop: false,
    // Completion state for THIS run. The persisted set only describes what a
    // previous process finished; a node that completes mid-run must land here
    // immediately or objective evaluation keeps reporting it as pending and
    // the decision engine spawns recovery work for finished nodes.
    runCompleted: new Set<string>(input.completedKeys),
    // Nodes added after planning (delegation / fix / recovery). They are
    // execution details, never objective requirements.
    dynamicKeys: new Set<string>(),
    chainByKey,
    fixDepthByKey,
    // Live per-agent execution counts, fed to the delegation gate and the
    // scheduler's per-agent start gate (Phase 4).
    activeByAgent,
    executionIds: new Map<string, WorkerExecutionId>(),
    // Last posted chat text per agent+subtask (for duplicate suppression).
    lastPostedMessage: new Map<string, string>(),
    agentByKey,
    loadAwareRouting,
    loadSnapshot,
    loadAwareByKey,
    performanceRouting,
    performanceScores,
    performanceScoresAt: 0,
    performanceByKey,
    modelRoutingByKey,
    assign,
    nextOrder: (): number =>
      plan.subtasks.reduce((max, candidate) => Math.max(max, candidate.order), 0) + 1,
    uniqueSubtaskKey: (base: string): string => {
      let key = base;
      let suffix = 2;
      while (plan.subtasks.some((candidate) => candidate.key === key)) {
        key = `${base}_${suffix}`;
        suffix += 1;
      }
      return key;
    },
    persistDynamic,
    /** True once this run is cancelled — by the status poll or by the deadline signal. */
    taskCancelled: (): boolean => ctx.cancelled || input.taskAbort?.signal.aborted === true,
    applyStaged,
    runNodes: (nodes: PlanSubtask[]) => runNodes(ctx, nodes),
  };
  return ctx;
}
