import { wenvRaw } from "@fhara/config/worker";
import { withSnapshotScope } from "@/llm/snapshots";
import type { PlanSubtask } from "@/types";
import type { WorkerExecutionId } from "@/workerApi";
import type { NodeOutcome, NodeRunInfo, SchedulerNode, SchedulerResult } from "@/scheduler/dagScheduler";
import { executeSubtask, type SubtaskExecutionInput } from "@/execution/agentExecutor";
import type { SiblingSubtask } from "@/execution/agentContext";
import { decideRetry } from "@/orchestrator/decisionEngine/retry";
import { commandReviewerFor } from "@/decisionTurn/autoReview";
import { runShowOptions } from "@/review/showOptions";
import { runWithObservationScope } from "@/effects/observationContext";
import type { StallObservation } from "@/utils/stallDetector";
import type { FileDiff } from "@/tools/gitDiff";
import { combineSignals } from "../abort";
import { handleNodeOutcome } from "../decision";
import { pullTaskInputs } from "../session";
import { nextPendingSubtask, pullTaskBrief, recordBriefAfterNode } from "../brief";
import { buildChangesCard, postStageCard } from "../cards";
import { ACTIVITY_STARTING, ACTIVITY_THINKING, createActivityReporter, describeActivity } from "../activity";
import { LiveOutputCoalescer } from "../liveOutput";
import { waitForCommandApproval } from "../commandApproval";
import { prepareContinuation } from "../continuation";
import { dispatchSystemLine, postSystemLine } from "../systemLines";
import type { RunContext } from "../types";
import { budgetHaltFeedback } from "./executionGuard";
import { unroutableOutcome, type ExecutionResolver } from "./executionResolver";
import { createNodeObserver, logHeld, logRouted } from "./nodeObserver";

/**
 * Node lifecycle of the DAG nodes runner: start, execute, settle and
 * persist one node, with task input delivery and sibling context. Part of
 * `runNodes` (split out with no behaviour change).
 */

export type SiblingTracker = ReturnType<typeof createSiblingTracker>;

/** What every node of one runNodes invocation shares. */
export interface NodeLifecycleEnv {
  ctx: RunContext;
  resolver: ExecutionResolver;
  siblings: SiblingTracker;
  ackInputs: (inputIds: string[]) => void;
  reportStall: (observation: StallObservation) => Promise<void>;
}

const subtaskOf = (ctx: RunContext, key: string) => ctx.plan.subtasks.find((candidate) => candidate.key === key);

/**
 * Subset runs (the review/QA loops re-run their own nodes) filter out
 * dependencies that live outside the subset, because the scheduler can only
 * order nodes it was given. Review/QA nodes are stage-managed by the runner
 * itself, so their ordering never has to be enforced here. Any other unmet
 * prerequisite (an implementation/analysis node that never completed) is a
 * `prerequisite_missing` observation: the engine fails the subset closed
 * instead of letting the node run on incomplete work. Undefined: all met.
 */
export function prerequisiteFailure(
  ctx: Pick<RunContext, "plan" | "runCompleted" | "state">,
  nodes: PlanSubtask[],
  subsetKeys: Set<string>
): SchedulerResult | undefined {
  const stageManaged = new Set(
    ctx.plan.subtasks
      .filter((subtask) => subtask.kind === "review" || subtask.kind === "qa")
      .map((subtask) => subtask.key)
  );
  const unmet = nodes.flatMap((node) => {
    const missing = node.dependencies.filter(
      (dependency) => !subsetKeys.has(dependency) && !stageManaged.has(dependency) && !ctx.runCompleted.has(dependency)
    );
    const step = decideRetry({ kind: "prerequisite_missing", nodeKey: node.key, missing });
    return step.kind === "block" ? [{ key: node.key, error: step.error ?? step.reason }] : [];
  });
  if (unmet.length === 0) return undefined;
  for (const { error } of unmet) ctx.state.feedback.push(error);
  const outcomes = new Map<string, NodeOutcome>(unmet.map(({ key, error }) => [key, { status: "failed" as const, error }]));
  return { status: "failed", outcomes, failed: unmet.map(({ key }) => key) };
}

/** onStart: count the agent's slot, record the route, open the execution attempt. */
export async function startNode(env: NodeLifecycleEnv, node: SchedulerNode, attempt: number): Promise<void> {
  const { ctx } = env;
  const { deps, taskId, project } = ctx;
  if (ctx.runCompleted.has(node.id)) return;
  env.siblings.started(node.id);
  const subtask = subtaskOf(ctx, node.id)!;
  const agent = ctx.assign(node.id);
  if (!agent) throw new Error(`No enabled agent for capability ${subtask.capability}`);
  ctx.activeByAgent.set(agent._id, (ctx.activeByAgent.get(agent._id) ?? 0) + 1);
  const modelRouting = await env.resolver.prepare(node.id, agent);
  await logRouted(ctx, node.id, subtask, agent, modelRouting);
  const executionId = await deps.api.startExecution({
    taskId,
    projectId: project._id,
    subtaskKey: node.id,
    agentId: agent._id,
    agentName: agent.name,
    capability: subtask.capability,
    workerId: deps.workerId,
    attempt,
    leaseMs: 60_000,
  });
  ctx.executionIds.set(node.id, executionId);
  if (attempt <= 1) await postSystemLine(deps, { taskId, projectId: project._id, content: dispatchSystemLine(agent, subtask.title) });
}

/** onOutcome: the engine's decision, then the deterministic brief update (plan L3). */
export async function settleNode(
  env: NodeLifecycleEnv,
  node: SchedulerNode,
  outcome: NodeOutcome,
  attempt: number
): Promise<SchedulerNode[] | void> {
  const { ctx } = env;
  env.siblings.settled(node.id);
  const added = await handleNodeOutcome(ctx, node, outcome, attempt);
  // Plan L3: deterministic brief update (no LLM), best-effort.
  const next = nextPendingSubtask(ctx.plan.subtasks, ctx.runCompleted, node.id);
  await recordBriefAfterNode({
    deps: ctx.deps,
    taskId: ctx.taskId,
    subtask: subtaskOf(ctx, node.id),
    nodeKey: node.id,
    role: ctx.assign(node.id)?.role,
    outcome,
    next,
    nextRole: next ? ctx.assign(next.key)?.role : undefined,
    sharedContext: ctx.input.sharedContext,
  });
  if (Array.isArray(added)) env.siblings.admitted(added.map((candidate) => candidate.id));
  return added;
}

/** onBlocked: a pause holds the node; any other block is recorded as feedback. */
export async function blockNode(env: NodeLifecycleEnv, node: SchedulerNode, reason: string): Promise<void> {
  const { ctx } = env;
  const { deps, taskId, project, state } = ctx;
  env.siblings.settled(node.id);
  // Plan 022: nodes held back by a user pause stay pending — they
  // are the work Resume continues with, not a failure.
  if (ctx.paused && !ctx.cancelled) {
    await logHeld(ctx, node.id);
    return;
  }
  const budgetLine = budgetHaltFeedback(ctx, node.id);
  if (budgetLine) state.feedback.push(budgetLine);
  // Any block is actionable feedback, not just the budget case —
  // without this the task failed with the generic "Execution failed
  // without a detailed error" message.
  state.feedback.push(`${node.id}: ${reason}`);
  // Dynamic subtasks (Phase 3 delegation/fix) have no persisted
  // subtask row; a failed status write for them must not take the
  // scheduler down — the event below still records the block.
  await deps.api
    .updateSubtask({
      taskId,
      key: node.id,
      status: "blocked",
      error: reason,
    })
    .catch(() => undefined);
  await deps.api.logEvent({
    taskId,
    projectId: project._id,
    type: "subtask.blocked",
    payload: { subtaskKey: node.id, reason },
    subtaskKey: node.id,
    level: "warn",
  });
}

/** Records `filePath` as produced by `nodeKey` (earlier writers keep theirs). */
function attribute(ctx: RunContext, nodeKey: string, filePath: string): void {
  const produced = ctx.state.appliedFilesBySubtask.get(nodeKey) ?? [];
  if (!produced.includes(filePath)) produced.push(filePath);
  ctx.state.appliedFilesBySubtask.set(nodeKey, produced);
}

/** Persist the node's staged file changes (plan 019: kept for the "Changed N files" card). */
function createFileStaging(
  ctx: RunContext,
  nodeKey: string,
  executionId: WorkerExecutionId | undefined,
  beat: () => void,
  reportActivity: (activity: string | null) => void
) {
  const { deps, taskId, project, state } = ctx;
  const staged: FileDiff[] = [];
  const discardFileChange: SubtaskExecutionInput["discardFileChange"] =
    typeof (deps.api as { discardFileChange?: unknown }).discardFileChange === "function"
      ? async (filePath: string) => {
          await deps.api.discardFileChange({ taskId, filePath });
          state.fileChanges.delete(filePath);
          const prior = staged.findIndex((entry) => entry.filePath === filePath);
          if (prior >= 0) staged.splice(prior, 1);
          // Withdrawing an edit is this node's change: attribute it so
          // objective evaluation does not read the node as a no-op.
          attribute(ctx, nodeKey, filePath);
          beat();
          await deps.api.logEvent({
            taskId,
            projectId: project._id,
            type: "fileChanges.discarded",
            payload: { filePaths: [filePath] },
            executionId,
            subtaskKey: nodeKey,
          });
        }
      : undefined;
  const saveFileChange: SubtaskExecutionInput["saveFileChange"] = async (change) => {
    reportActivity(describeActivity("file.staged", { filePath: change.filePath }));
    await deps.api.saveFileChange({
      taskId,
      projectId: project._id,
      filePath: change.filePath,
      changeType: change.changeType,
      oldContent: change.oldContent,
      newContent: change.newContent,
      oldContentHash: change.oldContentHash,
      newContentHash: change.newContentHash,
      diff: change.diff,
      subtaskKey: nodeKey,
      executionId,
    });
    state.fileChanges.set(change.filePath, change);
    const prior = staged.findIndex((entry) => entry.filePath === change.filePath);
    if (prior >= 0) staged[prior] = change;
    else staged.push(change);
    // Phase 5 Step 5.1: attribute the staged file to the subtask that
    // produced it, so objective evaluation can check that every
    // completed code_change actually landed a change.
    attribute(ctx, nodeKey, change.filePath);
    beat();
    await deps.api.logEvent({
      taskId,
      projectId: project._id,
      type: "fileChanges.updated",
      payload: { filePaths: [change.filePath] },
      executionId,
      subtaskKey: nodeKey,
    });
  };
  return { staged, discardFileChange, saveFileChange };
}

/** The scheduler's executor: run one node through `executeSubtask`. */
export async function runNode(
  env: NodeLifecycleEnv,
  node: SchedulerNode,
  signal: AbortSignal,
  runInfo: NodeRunInfo | undefined
): Promise<NodeOutcome> {
  const { ctx, resolver } = env;
  const { plan, state, runCompleted, executionIds, assign, deps, input, task, project, taskId, browser } = ctx;
  const subtask = subtaskOf(ctx, node.id)!;
  const agent = assign(node.id);
  if (!agent) return unroutableOutcome(ctx, node.id, subtask);
  if (runCompleted.has(node.id)) return { status: "completed", output: "Previously completed" };
  const executionId = executionIds.get(node.id);
  // G4: a subtask a dead worker cut off continues from its recorded steps (continuation.ts).
  const cont = await prepareContinuation(deps, { taskId, projectId: project._id, executionId, nodeId: node.id, state, subtask });
  if (cont.refused) return { status: "failed", error: cont.refused };
  // Progress: keeps both the task idle watchdog and this node's stall
  // watchdog (scheduler) alive.
  const beat = () => {
    input.taskAbort?.bump?.();
    runInfo?.progress?.();
  };
  // A resolution failure (e.g. no provider can serve the agent, or a
  // provider cannot be constructed) fails the subtask explicitly.
  let resolved: Awaited<ReturnType<ExecutionResolver["handles"]>>;
  try {
    resolved = await resolver.handles(node.id, agent);
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  const { route, llmHandles } = resolved;
  // Live activity line under the running subtask in the task panel.
  const reportActivity = createActivityReporter((activity) =>
    deps.api.setSubtaskActivity({ taskId, key: node.id, activity })
  );
  reportActivity(ACTIVITY_STARTING);
  // Live output tail under the running row: streamed text, coalesced.
  const live = new LiveOutputCoalescer({
    write: (text) => deps.api.setSubtaskLiveOutput({ taskId, key: node.id, text }),
    clear: () => deps.api.setSubtaskLiveOutput({ taskId, key: node.id, text: "" }),
  });
  // A steer sent mid-run reaches this subtask's prompt (single input
  // guard): fold undelivered inputs now; the prompt acks what it renders.
  if (input.sharedContext) await pullTaskInputs(deps, taskId, input.sharedContext);
  // Plan L3: the latest brief (a user edit since the last node shows now).
  if (input.sharedContext) await pullTaskBrief(deps, taskId, input.sharedContext);
  const opencodeSelection = await resolver.runtime(node.id, agent, route);
  const files = createFileStaging(ctx, node.id, executionId, beat, reportActivity);
  const observer = createNodeObserver({ ctx, nodeKey: node.id, subtask, agent, executionId, beat, reportActivity, live });
  const siblings: SiblingSubtask[] = env.siblings.siblingsOf(node.id, plan.subtasks, runCompleted, (key) => assign(key)?.role);
  // Context Snapshot scope: every LLM call this node makes is attributed
  // to this task, execution attempt, subtask and agent. Inside it, the
  // observation scope feeds the stall watchdog and typed observations.
  const outcome = await withSnapshotScope(
    { taskId: String(taskId), projectId: String(project._id), executionId: executionId ? String(executionId) : undefined, subtaskKey: node.id, agentId: String(agent._id), agentRole: agent.role },
    () => runWithObservationScope(
    {
      nodeKey: node.id,
      progress: beat,
      emit: (observation) => void env.reportStall(observation),
    },
    () => executeSubtask({
    workspacePath: input.workspacePath,
    command: task.command,
    allowedEscalations: state.allowedEscalations,
    plan,
    subtask: cont.subtask,
    agent,
    browser,
    siblings,
    llmConfig: input.llmConfig,
    llmHandles,
    llmTaskGate: input.llmTaskGate,
    qaBaseUrl: input.qaBaseUrl,
    mcp: input.mcp,
    webReach: input.webReach, // Plan 036: the Agent Reach web tool for read-only agents.
    loadLibrarySkill: (ref) => deps.api.loadLibrarySkill({ agentId: String(agent._id), name: ref.name, ...(ref.version !== undefined ? { version: ref.version } : {}) }),
    // Plan 035: the app-wide OpenCode runtime and model win; the
    // per-agent values are legacy and only apply when the setting was
    // never written; the env default is the last resort.
    runtime: opencodeSelection.runtime,
    nativeModel: opencodeSelection.model,
    qaMode: deps.policy.qaMode,
    // Agent commands wait for approval in-process: lease and heartbeat stay, the node shows
    // "waiting for approval", stop or the approval timeout end the wait as a denial, and a
    // pause does not end it (the node finishes on the decision, then drains).
    requestCommandApproval: (cmd) => cont.gate(cmd, () =>
      waitForCommandApproval(
        deps.api,
        {
          taskId: String(taskId),
          projectId: String(project._id),
          subtaskKey: node.id,
          ...(executionId ? { executionId: String(executionId) } : {}),
          requestedByAgentId: String(agent._id),
          ...cmd, // command, args, and kind "run_unconfined" for a sandbox rerun (D6)
          workspaceRoot: input.workspacePath,
        },
        {
          signal: combineSignals(signal, input.taskAbort?.signal),
          review: commandReviewerFor(ctx), // D7: Full access asks the Reviewer first
          onPending: () => reportActivity(describeActivity("command.waiting_approval", cmd)),
          onWaiting: beat,
          holdClock: runInfo?.holdClock, // a human wait: the subtask timeout and stall clocks stop
        }
      )),
    // Options review: the subtask waits in-process for the user's pick
    // (lease kept, clocks held), like a command approval.
    showOptions: (args) =>
      runShowOptions(args, {
        api: deps.api,
        taskId: String(taskId),
        projectId: String(project._id),
        subtaskKey: node.id,
        ...(executionId ? { executionId: String(executionId) } : {}),
        agentId: String(agent._id),
        role: agent.role,
        workspaceRoot: input.workspacePath,
        ...(input.qaBaseUrl ? { qaBaseUrl: input.qaBaseUrl } : {}),
        signal: combineSignals(signal, input.taskAbort?.signal),
        onPending: () => reportActivity(describeActivity("options.waiting", { title: typeof args.title === "string" ? args.title : undefined })),
        onWaiting: beat,
        holdClock: runInfo?.holdClock,
      }),
    nativeProviderCommand: wenvRaw("ORCHESTRATOR_NATIVE_PROVIDER_COMMAND"),
    taskContext: input.sharedContext,
    onUserInputsRendered: env.ackInputs,
    priorOutputs: state.priorOutputs,
    fileChanges: Array.from(state.fileChanges.values()),
    getStagedChange: (filePath) => state.fileChanges.get(filePath),
    // The executor observes BOTH abort sources: the scheduler's
    // per-node signal (subtask timeout / scheduler cancel) and the
    // per-task signal (task deadline / task-level cancel).
    signal: combineSignals(signal, input.taskAbort?.signal),
    // The subtask's own timeout: LLM calls and retries are budgeted
    // against it instead of each assuming the full LLM timeout.
    deadlineAt: runInfo?.deadlineAt,
    // Pre-call budget gate (Phase 5): the executor checks it before
    // every LLM call this subtask makes.
    assertBudgetForCall: () => {
      reportActivity(ACTIVITY_THINKING);
      input.assertBudgetForCall?.();
    },
    onEvent: observer.onEvent,
    onMessage: observer.onMessage,
    onChunk: observer.onChunk,
    discardFileChange: files.discardFileChange,
    saveFileChange: files.saveFileChange,
    onTokenUsage: observer.onTokenUsage,
    // Settled (or threw): drop the live tail once pending writes land.
    // Not awaited: a slow cosmetic write must not hold the outcome.
  }))).finally(() => void live.close());
  if (outcome.status === "completed" && subtask.kind === "code_change" && files.staged.length > 0) {
    await postStageCard(deps.api, {
      taskId,
      projectId: project._id,
      agentId: agent._id,
      kind: "changes",
      data: buildChangesCard(files.staged, {
        subtaskKey: node.id,
        idempotencyKey: `changes:${node.id}:${executionId ?? "x"}:${files.staged.length}`,
      }),
    });
  }
  return outcome;
}

/**
 * Tracks the live status of the nodes in one runNodes invocation for the
 * "Running alongside you" prompt section: started → running, any outcome
 * or block → settled (a retry re-enters through `started`). Everything
 * else in the run that has not completed is queued.
 */
export function createSiblingTracker(initialKeys: Iterable<string>) {
  const inRun = new Set(initialKeys);
  const running = new Set<string>();
  const settledKeys = new Set<string>();
  return {
    started(key: string) {
      inRun.add(key);
      running.add(key);
      settledKeys.delete(key);
    },
    settled(key: string) {
      running.delete(key);
      settledKeys.add(key);
    },
    admitted(keys: string[]) {
      for (const key of keys) inRun.add(key);
    },
    siblingsOf(
      self: string,
      subtasks: PlanSubtask[],
      completed: { has(key: string): boolean },
      roleOf: (key: string) => string | undefined
    ): SiblingSubtask[] {
      const out: SiblingSubtask[] = [];
      for (const subtask of subtasks) {
        if (subtask.key === self || !inRun.has(subtask.key)) continue;
        if (completed.has(subtask.key) || settledKeys.has(subtask.key)) continue;
        out.push({
          key: subtask.key,
          role: roleOf(subtask.key) ?? subtask.capability,
          title: subtask.title,
          allowedPaths: subtask.allowedPaths,
          status: running.has(subtask.key) ? "running" : "queued",
        });
      }
      return out;
    },
  };
}
