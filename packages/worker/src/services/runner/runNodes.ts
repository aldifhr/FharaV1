import type {
  PlanSubtask,
} from "@/orchestrator/types";
import { runScheduler, type NodeOutcome, type SchedulerResult } from "@/scheduler/dagScheduler";
import { executeSubtask } from "@/execution/agentExecutor";
import { capabilitiesOf } from "@/orchestrator/capabilities";
import { combineSignals } from "./setup";
import type { FallbackHandle } from "@/effects/llmCall";
import type { WorkerApi } from "@/workerApi";
import { handleNodeOutcome } from "./decision";
import type { RunContext } from "./types";

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
  // Subset runs (the review/QA loops re-run their own nodes) filter out
  // dependencies that live outside the subset, because the scheduler can
  // only order nodes it was given. Review/QA nodes are stage-managed by
  // the runner itself, so their ordering never has to be enforced here.
  // Any other unmet prerequisite (an implementation/analysis node that
  // never completed) fails the subset closed instead of letting the node
  // run on incomplete work.
  const stageManaged = new Set(
    plan.subtasks
      .filter((subtask) => subtask.kind === "review" || subtask.kind === "qa")
      .map((subtask) => subtask.key)
  );
  const unmet = nodes.filter((node) =>
    node.dependencies.some(
      (dependency) =>
        !subsetKeys.has(dependency) &&
        !stageManaged.has(dependency) &&
        !runCompleted.has(dependency)
    )
  );
  if (unmet.length > 0) {
    const outcomes = new Map<string, NodeOutcome>(
      unmet.map((node) => [
        node.key,
        {
          status: "failed" as const,
          error: `Prerequisite for "${node.key}" has not completed`,
        },
      ])
    );
    return {
      status: "failed",
      outcomes,
      failed: unmet.map((node) => node.key),
    };
  }
  return runScheduler(
    nodes.map((subtask) => ({
      id: subtask.key,
      dependencies: subtask.dependencies.filter((dependency) => subsetKeys.has(dependency)),
      paths: subtask.allowedPaths,
    })),
    async (node, signal): Promise<NodeOutcome> => {
      const subtask = plan.subtasks.find((candidate) => candidate.key === node.id)!;
      const agent = assign(node.id);
      if (!agent) {
        return {
          status: "failed",
          error: `No enabled agent can serve capability "${subtask.capability}"`,
        };
      }
      if (runCompleted.has(node.id)) {
        return { status: "completed", output: "Previously completed" };
      }
      const executionId = executionIds.get(node.id);
      // Resolve this agent's provider chain (assignment → fallback → pool).
      // A resolution failure (e.g. no provider can serve the agent, or a
      // provider cannot be constructed) fails the subtask explicitly.
      let llmHandles: FallbackHandle[] | undefined;
      try {
        llmHandles = input.llmResolver?.handlesFor(agent);
      } catch (error) {
        return {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      return await executeSubtask({
        workspacePath: input.workspacePath,
        command: task.command,
        plan,
        subtask,
        agent,
        browser,
        llmConfig: input.llmConfig,
        llmHandles,
        llmTaskGate: input.llmTaskGate,
        qaBaseUrl: input.qaBaseUrl,
        mcp: input.mcp,
        runtime: deps.policy.executionRuntime ?? "api",
        nativeProviderCommand: process.env.ORCHESTRATOR_NATIVE_PROVIDER_COMMAND,
        taskContext: input.sharedContext,
        priorOutputs: state.priorOutputs,
        fileChanges: Array.from(state.fileChanges.values()),
        // The executor observes BOTH abort sources: the scheduler's
        // per-node signal (subtask timeout / scheduler cancel) and the
        // per-task signal (task deadline / task-level cancel).
        signal: combineSignals(signal, input.taskAbort?.signal),
        // Pre-call budget gate (Phase 5): the executor checks it before
        // every LLM call this subtask makes.
        assertBudgetForCall: input.assertBudgetForCall,
        onEvent: async (type, payload, level) => {
          input.taskAbort?.bump?.();
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
          input.taskAbort?.bump?.();
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
        onChunk: async () => {
          // Chunks are buffered by the provider; the final message is stored once.
        },
        saveFileChange: async (change) => {
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
          // Phase 5 Step 5.1: attribute the staged file to the subtask that
          // produced it, so objective evaluation can check that every
          // completed code_change actually landed a change.
          const produced = state.appliedFilesBySubtask.get(node.id) ?? [];
          if (!produced.includes(change.filePath)) produced.push(change.filePath);
          state.appliedFilesBySubtask.set(node.id, produced);
          input.taskAbort?.bump?.();
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
          input.taskAbort?.bump?.();
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
            });
          }
        },
      });
    },
    {
      maxConcurrency: 1, // FIFO: one subtask at a time, in DAG order (dependencies + stable order)
      timeoutMs: deps.policy.subtaskTimeoutMs,
      retries: deps.policy.subtaskRetries,
      // Phase 3 dynamic work: onOutcome may add delegation/fix subtasks
      // to this same invocation, capped per invocation; a budget BLOCKED
      // decision latches the halt so no new nodes start afterwards.
      maxAddedNodes: deps.policy.maxSubtasks,
      shouldHaltNewNodes: () => ctx.budgetHalt || ctx.stepLimitHit || ctx.decisionTerminal,
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
        ctx.cancelled =
          !current ||
          current.task.status === "failed" ||
          current.task.status === "done" ||
          current.task.status === "rejected";
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
        const subtask = plan.subtasks.find((candidate) => candidate.key === node.id)!;
        const agent = assign(node.id);
        if (!agent) throw new Error(`No enabled agent for capability ${subtask.capability}`);
        activeByAgent.set(agent._id, (activeByAgent.get(agent._id) ?? 0) + 1);
        await deps.api.logEvent({
          taskId,
          projectId: project._id,
          type: "subtask.routed",
          payload: {
            subtaskKey: node.id,
            capability: subtask.capability,
            agent: agent.name,
            capabilities: capabilitiesOf(agent),
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
      },
      onOutcome: async (node, outcome, attempt) =>
        handleNodeOutcome(ctx, node, outcome, attempt),
      onBlocked: async (node, reason) => {
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
