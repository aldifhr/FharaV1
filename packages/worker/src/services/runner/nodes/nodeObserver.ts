import type { AgentDefinition, PlanSubtask } from "@/types";
import type { WorkerApi, WorkerExecutionId } from "@/workerApi";
import type { ExecutionRoute, ModelRoutingInfo } from "@/llm/resolver";
import type { SubtaskExecutionInput } from "@/execution/agentExecutor";
import { capabilitiesOf } from "@/orchestrator/capabilities";
import { stallEventType, type StallObservation } from "@/utils/stallDetector";
import { usageLedgerArgs } from "../session";
import { describeActivity } from "../activity";
import type { LiveOutputCoalescer } from "../liveOutput";
import type { RunContext } from "../types";
import { foldQaCheck } from "./qaNode";

/**
 * Progress and event reporting for the DAG nodes runner: the timeline
 * events, agent messages, live output and token usage a node produces.
 * Part of `runNodes` (split out with no behaviour change).
 */

type Ctx = Pick<RunContext, "deps" | "taskId" | "project">;

/** One timeline event per deadlock / stall observation (`stall.<kind>`). */
export function createStallReporter(ctx: Ctx): (observation: StallObservation) => Promise<void> {
  const { deps, taskId, project } = ctx;
  return async (observation) => {
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
}

/** Skipped OpenCode entries go to the event log, once per node start. */
export async function logSkippedRoutes(ctx: Ctx, nodeKey: string, skipped: ExecutionRoute["skipped"]): Promise<void> {
  for (const entry of skipped) {
    await ctx.deps.api.logEvent({
      taskId: ctx.taskId,
      projectId: ctx.project._id,
      type: "opencode.skipped",
      payload: { subtaskKey: nodeKey, model: entry.model, reason: entry.reason },
      subtaskKey: nodeKey,
      level: "warn",
    });
  }
}

/** Plan 040 (D8): the `subtask.routed` event of a node no agent can serve. */
export async function logUnroutable(ctx: Ctx, nodeKey: string, capability: string, reason: string): Promise<void> {
  await ctx.deps.api
    .logEvent({
      taskId: ctx.taskId,
      projectId: ctx.project._id,
      type: "subtask.routed",
      payload: { subtaskKey: nodeKey, capability, agent: null, blocked: true, reason },
      level: "warn",
    })
    .catch(() => undefined);
}

/** The `subtask.routed` event of a node that starts on `agent`. */
export async function logRouted(
  ctx: Ctx & Pick<RunContext, "loadAwareByKey" | "performanceByKey">,
  nodeKey: string,
  subtask: PlanSubtask,
  agent: AgentDefinition,
  modelRouting: ModelRoutingInfo | undefined
): Promise<void> {
  await ctx.deps.api.logEvent({
    taskId: ctx.taskId,
    projectId: ctx.project._id,
    type: "subtask.routed",
    payload: {
      subtaskKey: nodeKey,
      capability: subtask.capability,
      agent: agent.name,
      capabilities: capabilitiesOf(agent),
      // Routing Inspector: role + whether the agent declares the capability or was the closest fallback.
      role: agent.role,
      match: capabilitiesOf(agent).includes(subtask.capability.trim().toLowerCase().replace(/\s+/g, "-"))
        ? "exact"
        : "fallback",
      // Workload Manager: the load-aware router changed the pick.
      ...(ctx.loadAwareByKey.has(nodeKey) ? { loadAware: ctx.loadAwareByKey.get(nodeKey) } : {}),
      // Plan 027: performance routing decision with its factor breakdown.
      ...(ctx.performanceByKey.has(nodeKey) ? { performance: ctx.performanceByKey.get(nodeKey) } : {}),
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
}

/** Plan 022: a node held back by a user pause stays pending (not a failure). */
export async function logHeld(ctx: Ctx, nodeKey: string): Promise<void> {
  await ctx.deps.api
    .logEvent({
      taskId: ctx.taskId,
      projectId: ctx.project._id,
      type: "subtask.held",
      payload: { subtaskKey: nodeKey, reason: "paused_by_user" },
      subtaskKey: nodeKey,
    })
    .catch(() => undefined);
}

export interface NodeObserverInput {
  ctx: RunContext;
  nodeKey: string;
  subtask: PlanSubtask;
  agent: AgentDefinition;
  executionId: WorkerExecutionId | undefined;
  beat: () => void;
  reportActivity: (activity: string | null) => void;
  live: LiveOutputCoalescer;
}

type Handlers = Pick<SubtaskExecutionInput, "onEvent" | "onMessage" | "onChunk" | "onTokenUsage">;

/** The executor's event, message, stream and token-usage callbacks for one node. */
export function createNodeObserver(input: NodeObserverInput): Required<Handlers> {
  const { ctx, nodeKey, subtask, agent, executionId, beat, reportActivity, live } = input;
  const { deps, taskId, project, lastPostedMessage } = ctx;
  return {
    onEvent: async (type, payload, level) => {
      beat();
      reportActivity(describeActivity(type, payload));
      if (type === "native.tool") {
        const tool = payload as { tool?: string; title?: string; target?: string } | undefined;
        const step = tool?.title || [tool?.tool, tool?.target].filter(Boolean).join(" ");
        if (step) live.line(`› ${step}`);
      }
      // Plan 019: live QA checklist — each browser check updates the card.
      if (subtask.kind === "qa" && type === "task.check" && ctx.qaCard) await foldQaCheck(ctx, payload);
      await deps.api.logEvent({
        taskId,
        projectId: project._id,
        type,
        payload,
        executionId,
        subtaskKey: nodeKey,
        level,
      });
    },
    onMessage: async (content) => {
      beat();
      // Suppress exact-duplicate consecutive postings per agent+subtask
      // (QA loops and fix loops re-execute identical summary text — the
      // conversation showed the same QA verdict 4x in a row).
      const dedupeKey = `${agent._id}|${nodeKey}`;
      const previous = lastPostedMessage.get(dedupeKey);
      if (previous === content) return;
      lastPostedMessage.set(dedupeKey, content);
      await deps.api.appendAgentMessage({
        projectId: project._id,
        taskId,
        agentId: agent._id,
        content,
        subtaskKey: nodeKey,
        executionId,
      });
    },
    onChunk: async (delta) => {
      beat();
      // Streamed text feeds the live tail only; the final message is
      // still stored once by onMessage.
      live.push(delta);
    },
    onTokenUsage: async (inputTokens, outputTokens, model, meta) => {
      beat();
      // Feed the shared budget tracker with every real LLM call.
      ctx.input.budget?.recordLLMCall({
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
          subtaskKey: nodeKey,
        });
      }
    },
  };
}
