import { wenvRaw } from "@fhara/config/worker";
import { withSnapshotScope } from "@/llm/snapshots";
import type {
  PlanSubtask,
} from "@/types";
import { runScheduler, type NodeOutcome, type SchedulerResult } from "@/scheduler/dagScheduler";
import { executeSubtask } from "@/execution/agentExecutor";
import type { SiblingSubtask } from "@/execution/agentContext";
import { nativeTimeoutMs, resolveOpencodeSelection } from "@/execution/nativeProvider";
import { subtaskTimeoutFor } from "@/orchestrator/policy";
import { capabilitiesOf, unroutedReason } from "@/orchestrator/capabilities";
import { decideRetry } from "@/orchestrator/decisionEngine/retry";
import { combineSignals } from "./abort";
import type { FallbackHandle } from "@/effects/llmCall";
import type { WorkerApi } from "@/workerApi";
import { handleNodeOutcome } from "./decision";
import { createInputDeliveryAck, pullTaskInputs, usageLedgerArgs } from "./session";
import { nextPendingSubtask, pullTaskBrief, recordBriefAfterNode } from "./brief";
import type { RunContext } from "./types";
import type { FileDiff } from "@/tools/gitDiff";
import { applyQaCheck, buildChangesCard, buildQaCard, postStageCard } from "./cards";
import { ACTIVITY_STARTING, ACTIVITY_THINKING, createActivityReporter, describeActivity } from "./activity";
import { LiveOutputCoalescer } from "./liveOutput";
import { waitForCommandApproval } from "./commandApproval";
import { commandReviewerFor } from "@/decisionTurn/autoReview";
import { runShowOptions } from "@/review/showOptions";
import { runWithObservationScope } from "@/effects/observationContext";
import { stallEventType, stallThresholdsFromEnv, type StallObservation } from "@/utils/stallDetector";
import { llmTimeoutMs } from "@/llm";
import { handlesFromResolution, type AgentResolution, type ExecutionRoute, type ModelRoutingInfo } from "@/llm/resolver";
import { ensureOpencodeDetection, opencodeGateFor } from "@/execution/opencodeDetect";
import type { PerformanceScore } from "@/api/convex/lib/agentPerformance";
import { isResearchSynthesis } from "@/prompts/research";
import { prepareContinuation } from "./continuation";
import { dispatchSystemLine, postSystemLine } from "./systemLines";

/**
 * The DAG nodes runner (plan 012 step 2): run a set of subtasks through
 * the scheduler with per-node execution resolution, timeout and abort
 * wiring. Extracted verbatim from `executePlan`'s `runNodes` closure —
 * state that used to be captured is threaded through `ctx`, so every
 * mutation (complete set, active map, file changes) flows through the
 * shared containers.
 */
export async function runNodes(ctx: RunContext, nodes: PlanSubtask[]): Promise<SchedulerResult> {
  // Reference-type containers are shared by reference; scalar latches go
  // through ctx so every stage observes one truth.
  const {
    plan, state, runCompleted, executionIds, assign, deps, input,
    task, project, taskId, browser, lastPostedMessage, activeByAgent,
  } = ctx;
  const subsetKeys = new Set(nodes.map((node) => node.key));
  // Plan 027: the executor resolution made at onStart, consumed by the node.
  const resolutionByKey = new Map<string, AgentResolution>();
  // Plan 038: the subtask route (native OpenCode or API) picked at onStart.
  const routeByKey = new Map<string, ExecutionRoute>();
  const opencodeGate = async () =>
    opencodeGateFor({
      detection: await ensureOpencodeDetection(),
      worktreeIsolation: deps.policy.worktreeIsolation,
    });
  // Skipped OpenCode entries go to the event log, once per node start.
  const logSkipped = async (nodeKey: string, skipped: ExecutionRoute["skipped"]) => {
    for (const entry of skipped) {
      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type: "opencode.skipped",
        payload: { subtaskKey: nodeKey, model: entry.model, reason: entry.reason },
        subtaskKey: nodeKey,
        level: "warn",
      });
    }
  };
  // Load-aware routing (opt-in): read running executions per agent across
  // every task once per invocation. A failed read routes as usual.
  if (ctx.loadAwareRouting || ctx.performanceRouting) await refreshLoadSnapshot(ctx);
  if (ctx.performanceRouting) await refreshPerformanceScores(ctx);
  const ackInputs = createInputDeliveryAck(deps);
  // Sibling context: which subtasks of this invocation are running now and
  // which have settled, so each node's prompt can list the others.
  const siblingTracker = createSiblingTracker(subsetKeys);
  // Subset runs (the review/QA loops re-run their own nodes) filter out
  // dependencies that live outside the subset, because the scheduler can
  // only order nodes it was given. Review/QA nodes are stage-managed by
  // the runner itself, so their ordering never has to be enforced here.
  // Any other unmet prerequisite (an implementation/analysis node that
  // never completed) is a `prerequisite_missing` observation: the engine
  // fails the subset closed instead of letting the node run on incomplete work.
  const stageManaged = new Set(
    plan.subtasks
      .filter((subtask) => subtask.kind === "review" || subtask.kind === "qa")
      .map((subtask) => subtask.key)
  );
  const unmet = nodes.flatMap((node) => {
    const missing = node.dependencies.filter(
      (dependency) => !subsetKeys.has(dependency) && !stageManaged.has(dependency) && !runCompleted.has(dependency)
    );
    const step = decideRetry({ kind: "prerequisite_missing", nodeKey: node.key, missing });
    return step.kind === "block" ? [{ key: node.key, error: step.error ?? step.reason }] : [];
  });
  if (unmet.length > 0) {
    for (const { error } of unmet) state.feedback.push(error);
    const outcomes = new Map<string, NodeOutcome>(unmet.map(({ key, error }) => [key, { status: "failed" as const, error }]));
    return { status: "failed", outcomes, failed: unmet.map(({ key }) => key) };
  }
  const stallThresholds = ctx.stallThresholds ?? stallThresholdsFromEnv(undefined, llmTimeoutMs());
  // One timeline event per deadlock / stall observation (`stall.<kind>`).
  const reportStall = async (observation: StallObservation): Promise<void> => {
    await deps.api
      .logEvent({
        taskId,
        projectId: project._id,
        type: stallEventType(observation.kind),
        payload: {
          kind: observation.kind,
          action: observation.action,
          reason: observation.reason,
          ...(observation.detail ? { detail: observation.detail } : {}),
        },
        ...(observation.nodeKey ? { subtaskKey: observation.nodeKey } : {}),
        level: observation.action === "fallback" || observation.action === "retry" || observation.action === "report" ? "warn" : "error",
      })
      .catch(() => undefined);
  };
  return runScheduler(
    nodes.map((subtask) => ({
      id: subtask.key,
      dependencies: subtask.dependencies.filter((dependency) => subsetKeys.has(dependency)),
      paths: subtask.allowedPaths,
      writes: subtask.kind === "code_change" || subtask.kind === "shell",
      // O7: the research synthesis answers from the angles that succeeded.
      ...(isResearchSynthesis(subtask) ? { partialDependencies: true } : {}),
    })),
    async (node, signal, runInfo): Promise<NodeOutcome> => {
      const subtask = plan.subtasks.find((candidate) => candidate.key === node.id)!;
      const agent = assign(node.id);
      if (!agent) {
        // Plan 040 (D8): an `unroutable` observation; the engine BLOCKS it with the reason.
        const reason = unroutedReason(subtask.capability, input.agents);
        const step = decideRetry({ kind: "unroutable", nodeKey: node.id, capability: subtask.capability, reason });
        await deps.api
          .logEvent({
            taskId,
            projectId: project._id,
            type: "subtask.routed",
            payload: { subtaskKey: node.id, capability: subtask.capability, agent: null, blocked: true, reason },
            level: "warn",
          })
          .catch(() => undefined);
        return { status: "failed", error: step.kind === "block" && step.error ? step.error : `Blocked: ${reason}` };
      }
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
      // Resolve this agent's provider chain (assignment → fallback → pool).
      // A resolution failure (e.g. no provider can serve the agent, or a
      // provider cannot be constructed) fails the subtask explicitly.
      let llmHandles: FallbackHandle[] | undefined;
      // Plan 038: with the OpenCode provider in the pool, the ordered chain
      // decides the runtime of this subtask (prepared at onStart).
      let route = routeByKey.get(node.id);
      routeByKey.delete(node.id);
      try {
        if (!route && input.llmResolver?.hasOpencode()) {
          route = input.llmResolver.executionRouteFor(agent, await opencodeGate(), { callRole: "executor" });
          await logSkipped(node.id, route.skipped);
        }
        const prepared = resolutionByKey.get(node.id);
        resolutionByKey.delete(node.id);
        const routed = route
          ? route.runtime === "api"
            ? route.resolution
            : route.apiResolution
          : undefined;
        llmHandles = routed
          ? handlesFromResolution(routed)
          : route
            ? undefined
            : prepared
              ? handlesFromResolution(prepared)
              : input.llmResolver?.handlesFor(agent, { callRole: "executor" });
      } catch (error) {
        return { status: "failed", error: error instanceof Error ? error.message : String(error) };
      }
      // Plan 019: files this node staged, for the "Changed N files" card.
      const stagedByNode: FileDiff[] = [];
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
      // Plan 035: the effective OpenCode runtime and model for this node.
      // Plan 038: a route from the ordered list wins; without the OpenCode
      // provider the plan 035 selection applies, behind the same guard.
      let opencodeSelection: { runtime: "api" | "native-provider"; model?: string } = route
        ? route.runtime === "native-provider"
          ? { runtime: "native-provider", model: route.model }
          : { runtime: "api" }
        : resolveOpencodeSelection({
            globalRuntime: input.opencodeRuntime,
            globalModel: input.opencodeModel,
            agentRuntime: agent.executionRuntime,
            agentModel: agent.opencodeModel,
            envDefault: deps.policy.executionRuntime,
          });
      if (!route && opencodeSelection.runtime === "native-provider") {
        const gate = await opencodeGate();
        if (!gate.available) {
          // A `runtime_unavailable` observation: the engine falls back to the API runtime, silently.
          const step = decideRetry({ kind: "runtime_unavailable", nodeKey: node.id, runtime: "native-provider", reason: gate.reason });
          if (step.kind === "fallback") {
            await logSkipped(node.id, [{ model: opencodeSelection.model ?? "(OpenCode default)", reason: step.reason }]);
            opencodeSelection = { runtime: step.runtime };
          }
        }
      }
      // Context Snapshot scope: every LLM call this node makes is attributed
      // to this task, execution attempt, subtask and agent. Inside it, the
      // observation scope feeds the stall watchdog and typed observations.
      const outcome = await withSnapshotScope(
        { taskId: String(taskId), projectId: String(project._id), executionId: executionId ? String(executionId) : undefined, subtaskKey: node.id, agentId: String(agent._id), agentRole: agent.role },
        () => runWithObservationScope(
        {
          nodeKey: node.id,
          progress: beat,
          emit: (observation) => void reportStall(observation),
        },
        () => executeSubtask({
        workspacePath: input.workspacePath,
        command: task.command,
        allowedEscalations: state.allowedEscalations,
        plan,
        subtask: cont.subtask,
        agent,
        browser,
        siblings: siblingTracker.siblingsOf(node.id, plan.subtasks, runCompleted, (key) => assign(key)?.role),
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
        onUserInputsRendered: ackInputs,
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
        onEvent: async (type, payload, level) => {
          beat();
          reportActivity(describeActivity(type, payload));
          if (type === "native.tool") {
            const tool = payload as { tool?: string; title?: string; target?: string } | undefined;
            const step = tool?.title || [tool?.tool, tool?.target].filter(Boolean).join(" ");
            if (step) live.line(`› ${step}`);
          }
          // Plan 019: live QA checklist — each browser check updates the card.
          if (subtask.kind === "qa" && type === "task.check" && ctx.qaCard) {
            const check = payload as { label?: string; status?: string; details?: string } | undefined;
            if (check?.label) {
              const live = ctx.qaCard;
              if (check.label === "application reachable" && check.status === "passed" && check.details) {
                live.url = check.details;
              }
              const before = JSON.stringify(live.rows);
              live.rows = applyQaCheck(live.rows, {
                label: check.label,
                status: check.status ?? "inconclusive",
                details: check.details,
              });
              if (JSON.stringify(live.rows) !== before || check.label === "application reachable") {
                await postStageCard(deps.api, {
                  taskId,
                  projectId: project._id,
                  agentId: live.agentId,
                  kind: "qa",
                  data: buildQaCard({
                    outcome: "running",
                    iteration: live.iteration,
                    checks: [],
                    rows: live.rows,
                    fallbackUrl: live.url,
                    idempotencyKey: live.key,
                  }),
                });
              }
            }
          }
          await deps.api.logEvent({
            taskId,
            projectId: project._id,
            type,
            payload,
            executionId,
            subtaskKey: node.id,
            level,
          });
        },
        onMessage: async (content) => {
          beat();
          // Suppress exact-duplicate consecutive postings per agent+subtask
          // (QA loops and fix loops re-execute identical summary text — the
          // conversation showed the same QA verdict 4x in a row).
          const dedupeKey = `${agent._id}|${node.id}`;
          const previous = lastPostedMessage.get(dedupeKey);
          if (previous === content) return;
          lastPostedMessage.set(dedupeKey, content);
          await deps.api.appendAgentMessage({
            projectId: project._id,
            taskId,
            agentId: agent._id,
            content,
            subtaskKey: node.id,
            executionId,
          });
        },
        onChunk: async (delta) => {
          beat();
          // Streamed text feeds the live tail only; the final message is
          // still stored once by onMessage.
          live.push(delta);
        },
        discardFileChange:
          typeof (deps.api as { discardFileChange?: unknown }).discardFileChange === "function"
            ? async (filePath: string) => {
                await deps.api.discardFileChange({ taskId, filePath });
                state.fileChanges.delete(filePath);
                const prior = stagedByNode.findIndex((staged) => staged.filePath === filePath);
                if (prior >= 0) stagedByNode.splice(prior, 1);
                // Withdrawing an edit is this node's change: attribute it so
                // objective evaluation does not read the node as a no-op.
                // Earlier writers keep their attribution (their edit ran).
                const produced = state.appliedFilesBySubtask.get(node.id) ?? [];
                if (!produced.includes(filePath)) produced.push(filePath);
                state.appliedFilesBySubtask.set(node.id, produced);
                beat();
                await deps.api.logEvent({
                  taskId,
                  projectId: project._id,
                  type: "fileChanges.discarded",
                  payload: { filePaths: [filePath] },
                  executionId,
                  subtaskKey: node.id,
                });
              }
            : undefined,
        saveFileChange: async (change) => {
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
            subtaskKey: node.id,
            executionId,
          });
          state.fileChanges.set(change.filePath, change);
          const prior = stagedByNode.findIndex((staged) => staged.filePath === change.filePath);
          if (prior >= 0) stagedByNode[prior] = change;
          else stagedByNode.push(change);
          // Phase 5 Step 5.1: attribute the staged file to the subtask that
          // produced it, so objective evaluation can check that every
          // completed code_change actually landed a change.
          const produced = state.appliedFilesBySubtask.get(node.id) ?? [];
          if (!produced.includes(change.filePath)) produced.push(change.filePath);
          state.appliedFilesBySubtask.set(node.id, produced);
          beat();
          await deps.api.logEvent({
            taskId,
            projectId: project._id,
            type: "fileChanges.updated",
            payload: { filePaths: [change.filePath] },
            executionId,
            subtaskKey: node.id,
          });
        },
        onTokenUsage: async (inputTokens, outputTokens, model, meta) => {
          beat();
          // Feed the shared budget tracker with every real LLM call.
          input.budget?.recordLLMCall({
            inputTokens,
            outputTokens,
            model,
            agentName: agent.name,
            agentId: agent._id,
          });
          if (inputTokens > 0 || outputTokens > 0) {
            await deps.api.recordTokenUsage({
              projectId: project._id,
              taskId,
              agentId: agent._id,
              agentName: agent.name,
              model,
              inputTokens,
              outputTokens,
              // Phase 5 attribution: serving connection + registry
              // model + estimated cost (absent when unknown).
              providerId: meta?.providerId as
                | Parameters<WorkerApi["recordTokenUsage"]>[0]["providerId"]
                | undefined,
              modelId: meta?.modelRowId as
                | Parameters<WorkerApi["recordTokenUsage"]>[0]["modelId"]
                | undefined,
              estimatedCost: meta?.estimatedCost,
              ...(meta?.estimated ? { estimated: true } : {}),
              ...usageLedgerArgs(meta),
              // Runs trace: link the call to this execution attempt.
              executionId,
              subtaskKey: node.id,
            });
          }
        },
        // Settled (or threw): drop the live tail once pending writes land.
        // Not awaited: a slow cosmetic write must not hold the outcome.
      }))).finally(() => void live.close());
      if (outcome.status === "completed" && subtask.kind === "code_change" && stagedByNode.length > 0) {
        await postStageCard(deps.api, {
          taskId,
          projectId: project._id,
          agentId: agent._id,
          kind: "changes",
          data: buildChangesCard(stagedByNode, {
            subtaskKey: node.id,
            idempotencyKey: `changes:${node.id}:${executionId ?? "x"}:${stagedByNode.length}`,
          }),
        });
      }
      return outcome;
    },
    {
      // Sequential by default (policy.maxConcurrency defaults to 1: FIFO,
      // one subtask at a time in DAG order). A policy that raises it lets
      // independent nodes overlap; the per-agent gate below still applies.
      maxConcurrency: Math.max(1, Math.floor(deps.policy.maxConcurrency ?? 1)),
      timeoutMs: deps.policy.subtaskTimeoutMs,
      // Latency-aware per-node timeout (live tests 3/4: medium native
      // subtasks died at the fixed 300s while one slow call takes minutes):
      // base + k × observed LLM latency, and never below the native CLI's
      // own limit for a node that may run on OpenCode.
      nodeTimeoutMs: (node) => {
        const agent = assign(node.id);
        const mayRunNative =
          Boolean(input.llmResolver?.hasOpencode()) ||
          (agent
            ? resolveOpencodeSelection({
                globalRuntime: input.opencodeRuntime,
                globalModel: input.opencodeModel,
                agentRuntime: agent.executionRuntime,
                agentModel: agent.opencodeModel,
                envDefault: deps.policy.executionRuntime,
              }).runtime === "native-provider"
            : false);
        return subtaskTimeoutFor(deps.policy, mayRunNative ? { nativeTimeoutMs: nativeTimeoutMs() } : {});
      },
      retries: deps.policy.subtaskRetries,
      // Phase 3 dynamic work: onOutcome may add delegation/fix subtasks
      // to this same invocation, capped per invocation; a budget BLOCKED
      // decision latches the halt so no new nodes start afterwards.
      maxAddedNodes: deps.policy.maxSubtasks,
      // Deadlock & stall detector: typed observations per condition, and
      // the no-progress watchdog (retry once, then escalate).
      stallMs: stallThresholds.agentStallMs,
      stallRetries: stallThresholds.agentStallRetries,
      onStall: reportStall,
      // Plan 022: a user pause stops new dispatch; running nodes finish.
      shouldHaltNewNodes: () => ctx.budgetHalt || ctx.stepLimitHit || ctx.decisionTerminal || ctx.paused,
      shouldCancel: async () => {
        // The task deadline fired the shared abort controller (or a
        // cancel already propagated): the task is cancelled NOW. This
        // check bypasses the status-poll throttle below so a deadline
        // is honored within one scheduler pass, not up to 1.5s later.
        if (input.taskAbort?.signal.aborted) {
          ctx.cancelled = true;
          return true;
        }
        const now = Date.now();
        if (now - ctx.lastStatusCheck < 1500) return ctx.cancelled;
        ctx.lastStatusCheck = now;
        const current = await deps.api.getContext({ taskId });
        // "cancelled" is the user's Stop (tasks.cancel); it was missing here, so a stop never aborted running nodes.
        ctx.cancelled = !current || ["failed", "done", "rejected", "cancelled"].includes(current.task.status);
        // Plan 022: paused is not cancelled — it only halts new dispatch.
        // A resume that lands while this run drains does not un-halt it;
        // the run ends at its boundary and the release re-queues it.
        if (current?.task.status === "paused") ctx.paused = true;
        if (ctx.cancelled) {
          // Propagate beyond this scheduler: in-flight LLM calls, QA
          // and verification observe the same per-task signal.
          input.taskAbort?.abort();
        }
        return ctx.cancelled;
      },
      // Per-agent concurrency (Phase 4): a node whose agent is already
      // running maxConcurrency subtasks is deferred by the scheduler
      // until one of them settles and frees a slot. The limit mirrors
      // the delegation gate's semantics (orchestrator/delegation.ts):
      // an unset maxConcurrency means 1.
      canStartNode: (node) => {
        const agent = assign(node.id);
        if (!agent) return true;
        const limit = agent.maxConcurrency ?? 1;
        return (activeByAgent.get(agent._id) ?? 0) < limit;
      },
      // Retries respect the task's bounds (Phase 4): no retry once the
      // deadline/cancel has fired, and no retry the LLM call budget
      // cannot pay for. (The Phase 1 permanent/transient classification
      // runs before this veto, unchanged.)
      shouldRetryNode: () => {
        if (input.taskAbort?.signal.aborted) return false;
        // A retry re-runs the node and spends another LLM call: veto it
        // whenever the budget gate would stop that call (Phase 5 — in
        // warn mode the gate does not throw, so the check is made on
        // the tracker's LLM exhaustion state directly).
        if (input.budget && input.budget.isLlmBudgetExhausted().exhausted) return false;
        return true;
      },
      onStart: async (node, attempt) => {
        if (runCompleted.has(node.id)) return;
        siblingTracker.started(node.id);
        const subtask = plan.subtasks.find((candidate) => candidate.key === node.id)!;
        const agent = assign(node.id);
        if (!agent) throw new Error(`No enabled agent for capability ${subtask.capability}`);
        activeByAgent.set(agent._id, (activeByAgent.get(agent._id) ?? 0) + 1);
        // Resolve the executor's model now, so subtask.routed records the
        // choice and the reason; the node reuses this resolution for its
        // handles.
        let modelRouting: ModelRoutingInfo | undefined;
        if (input.llmResolver) {
          try {
            if (input.llmResolver.hasOpencode()) {
              // Plan 038: the route (native OpenCode or API) is picked here
              // so subtask.routed names the runtime and model it runs on.
              const route = input.llmResolver.executionRouteFor(agent, await opencodeGate(), { callRole: "executor" });
              routeByKey.set(node.id, route);
              await logSkipped(node.id, route.skipped);
              modelRouting = route.runtime === "api" ? route.resolution.routing : route.routing;
              ctx.modelRoutingByKey.set(node.id, modelRouting);
            } else {
              const resolution = input.llmResolver.resolutionFor(agent, {
                callRole: "executor",
              });
              resolutionByKey.set(node.id, resolution);
              modelRouting = resolution.routing;
              ctx.modelRoutingByKey.set(node.id, resolution.routing);
            }
          } catch {
            // Resolution failures surface in the node itself (explicit error).
          }
        }
        await deps.api.logEvent({
          taskId,
          projectId: project._id,
          type: "subtask.routed",
          payload: {
            subtaskKey: node.id,
            capability: subtask.capability,
            agent: agent.name,
            capabilities: capabilitiesOf(agent),
            // Routing Inspector: role + whether the agent declares the capability or was the closest fallback.
            role: agent.role,
            match: capabilitiesOf(agent).includes(subtask.capability.trim().toLowerCase().replace(/\s+/g, "-"))
              ? "exact"
              : "fallback",
            // Workload Manager: the load-aware router changed the pick.
            ...(ctx.loadAwareByKey.has(node.id) ? { loadAware: ctx.loadAwareByKey.get(node.id) } : {}),
            // Plan 027: performance routing decision with its factor breakdown.
            ...(ctx.performanceByKey.has(node.id) ? { performance: ctx.performanceByKey.get(node.id) } : {}),
            // The executor model chosen for this subtask.
            ...(modelRouting
              ? {
                  model: {
                    model: modelRouting.model,
                    connection: modelRouting.connection,
                    reason: modelRouting.reason,
                  },
                }
              : {}),
          },
        });
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
        executionIds.set(node.id, executionId);
        if (attempt <= 1) await postSystemLine(deps, { taskId, projectId: project._id, content: dispatchSystemLine(agent, subtask.title) });
      },
      onOutcome: async (node, outcome, attempt) => {
        siblingTracker.settled(node.id);
        const added = await handleNodeOutcome(ctx, node, outcome, attempt);
        // Plan L3: deterministic brief update (no LLM), best-effort.
        {
          const next = nextPendingSubtask(plan.subtasks, runCompleted, node.id);
          await recordBriefAfterNode({
            deps,
            taskId,
            subtask: plan.subtasks.find((candidate) => candidate.key === node.id),
            nodeKey: node.id,
            role: assign(node.id)?.role,
            outcome,
            next,
            nextRole: next ? assign(next.key)?.role : undefined,
            sharedContext: input.sharedContext,
          });
        }
        if (Array.isArray(added)) siblingTracker.admitted(added.map((candidate) => candidate.id));
        return added;
      },
      onBlocked: async (node, reason) => {
        siblingTracker.settled(node.id);
        // Plan 022: nodes held back by a user pause stay pending — they
        // are the work Resume continues with, not a failure.
        if (ctx.paused && !ctx.cancelled) {
          await deps.api
            .logEvent({
              taskId,
              projectId: project._id,
              type: "subtask.held",
              payload: { subtaskKey: node.id, reason: "paused_by_user" },
              subtaskKey: node.id,
            })
            .catch(() => undefined);
          return;
        }
        // A node blocked while the budget halt is latched (Phase 5):
        // record the budget failure in the run feedback so the runner
        // ends the task as budget.exhausted — a halted node never
        // reaches the pre-call gate, so without this entry its stop
        // would surface only as a generic execution failure.
        if (ctx.budgetHalt && input.budget) {
          const llmBudget = input.budget.isLlmBudgetExhausted();
          if (llmBudget.exhausted) {
            state.feedback.push(
              `${node.id}: Budget exhausted: ${llmBudget.reason}`
            );
          }
        }
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
      },
    }
  );
}

const PERFORMANCE_SCORES_TTL_MS = 10 * 60_000;

/**
 * Plan 027: refresh `ctx.performanceScores` (computed on read by the
 * backend with caps; kept for 10 minutes per run). A failed read keeps the
 * previous scores — with none, every agent scores the neutral prior and
 * the order is unchanged apart from capacity.
 */
async function refreshPerformanceScores(ctx: RunContext): Promise<void> {
  if (Date.now() - ctx.performanceScoresAt < PERFORMANCE_SCORES_TTL_MS) return;
  const read = (ctx.deps.api as { getPerformanceScores?: WorkerApi["getPerformanceScores"] }).getPerformanceScores;
  if (typeof read !== "function") return;
  try {
    const result = await read.call(ctx.deps.api, { projectId: ctx.project._id });
    ctx.performanceScores.clear();
    for (const score of (result?.scores ?? []) as PerformanceScore[]) {
      ctx.performanceScores.set(`${score.agentId}::${score.capability}`, score);
    }
    ctx.performanceScoresAt = Date.now();
  } catch {
    // Keep the previous scores.
  }
}

/** Refresh `ctx.loadSnapshot` (running executions per agent, all tasks). */
async function refreshLoadSnapshot(ctx: RunContext): Promise<void> {
  const read = (ctx.deps.api as { getAgentLoad?: WorkerApi["getAgentLoad"] }).getAgentLoad;
  if (typeof read !== "function") return;
  try {
    const load = await read.call(ctx.deps.api, {});
    ctx.loadSnapshot.clear();
    for (const [agentId, running] of Object.entries(load ?? {})) {
      if (typeof running === "number") ctx.loadSnapshot.set(agentId, running);
    }
  } catch {
    // Keep the previous snapshot; this run's own counts still apply.
  }
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
