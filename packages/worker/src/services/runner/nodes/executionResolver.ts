import type { AgentDefinition, PlanSubtask } from "@/types";
import type { WorkerApi } from "@/workerApi";
import type { NodeOutcome } from "@/scheduler/dagScheduler";
import type { FallbackHandle } from "@/effects/llmCall";
import type { PerformanceScore } from "@/api/convex/lib/agentPerformance";
import { nativeTimeoutMs, resolveOpencodeSelection } from "@/execution/nativeProvider";
import { ensureOpencodeDetection, opencodeGateFor } from "@/execution/opencodeDetect";
import { handlesFromResolution, type AgentResolution, type ExecutionRoute, type ModelRoutingInfo } from "@/llm/resolver";
import { subtaskTimeoutFor } from "@/orchestrator/policy";
import { unroutedReason } from "@/orchestrator/capabilities";
import { decideRetry } from "@/orchestrator/decisionEngine/retry";
import type { RunContext } from "../types";
import { logSkippedRoutes, logUnroutable } from "./nodeObserver";

/**
 * Agent and model resolution of the DAG nodes runner, plus OpenCode
 * routing (plans 027, 035, 038). Part of `runNodes` (split out with no
 * behaviour change).
 */

export type OpencodeSelection = { runtime: "api" | "native-provider"; model?: string };

/** Plan 035: the agent's OpenCode selection without the plan 038 provider. */
function selectionOf(ctx: RunContext, agent: AgentDefinition): OpencodeSelection {
  return resolveOpencodeSelection({
    globalRuntime: ctx.input.opencodeRuntime,
    globalModel: ctx.input.opencodeModel,
    agentRuntime: agent.executionRuntime,
    agentModel: agent.opencodeModel,
    envDefault: ctx.deps.policy.executionRuntime,
  });
}

/**
 * Latency-aware per-node timeout (live tests 3/4: medium native subtasks
 * died at the fixed 300s while one slow call takes minutes): base + k ×
 * observed LLM latency, and never below the native CLI's own limit for a
 * node that may run on OpenCode.
 */
export function nodeTimeoutFor(ctx: RunContext, agent: AgentDefinition | null): number {
  const mayRunNative =
    Boolean(ctx.input.llmResolver?.hasOpencode()) ||
    (agent ? selectionOf(ctx, agent).runtime === "native-provider" : false);
  return subtaskTimeoutFor(ctx.deps.policy, mayRunNative ? { nativeTimeoutMs: nativeTimeoutMs() } : {});
}

/** Plan 040 (D8): an `unroutable` observation; the engine BLOCKS it with the reason. */
export async function unroutableOutcome(ctx: RunContext, nodeKey: string, subtask: PlanSubtask): Promise<NodeOutcome> {
  const reason = unroutedReason(subtask.capability, ctx.input.agents);
  const step = decideRetry({ kind: "unroutable", nodeKey, capability: subtask.capability, reason });
  await logUnroutable(ctx, nodeKey, subtask.capability, reason);
  return { status: "failed", error: step.kind === "block" && step.error ? step.error : `Blocked: ${reason}` };
}

/**
 * The executor resolution of one runNodes invocation: prepared at onStart
 * (so `subtask.routed` names the model and runtime), consumed by the node.
 */
export function createExecutionResolver(ctx: RunContext) {
  const { input, deps } = ctx;
  // Plan 027: the executor resolution made at onStart, consumed by the node.
  const resolutionByKey = new Map<string, AgentResolution>();
  // Plan 038: the subtask route (native OpenCode or API) picked at onStart.
  const routeByKey = new Map<string, ExecutionRoute>();
  const opencodeGate = async () =>
    opencodeGateFor({
      detection: await ensureOpencodeDetection(),
      worktreeIsolation: deps.policy.worktreeIsolation,
    });
  return {
    /**
     * onStart: resolve the executor's model now, so subtask.routed records
     * the choice and the reason. Resolution failures surface in the node.
     */
    async prepare(nodeKey: string, agent: AgentDefinition): Promise<ModelRoutingInfo | undefined> {
      let modelRouting: ModelRoutingInfo | undefined;
      if (!input.llmResolver) return modelRouting;
      try {
        if (input.llmResolver.hasOpencode()) {
          // Plan 038: the route (native OpenCode or API) is picked here
          // so subtask.routed names the runtime and model it runs on.
          const route = input.llmResolver.executionRouteFor(agent, await opencodeGate(), { callRole: "executor" });
          routeByKey.set(nodeKey, route);
          await logSkippedRoutes(ctx, nodeKey, route.skipped);
          modelRouting = route.runtime === "api" ? route.resolution.routing : route.routing;
          ctx.modelRoutingByKey.set(nodeKey, modelRouting);
        } else {
          const resolution = input.llmResolver.resolutionFor(agent, {
            callRole: "executor",
          });
          resolutionByKey.set(nodeKey, resolution);
          modelRouting = resolution.routing;
          ctx.modelRoutingByKey.set(nodeKey, resolution.routing);
        }
      } catch {
        // Resolution failures surface in the node itself (explicit error).
      }
      return modelRouting;
    },

    /**
     * The node: this agent's provider chain (assignment → fallback → pool)
     * and, with the OpenCode provider in the pool, the route that decides
     * its runtime. Throws when no provider can serve the agent.
     */
    async handles(nodeKey: string, agent: AgentDefinition): Promise<{ route?: ExecutionRoute; llmHandles?: FallbackHandle[] }> {
      let route = routeByKey.get(nodeKey);
      routeByKey.delete(nodeKey);
      if (!route && input.llmResolver?.hasOpencode()) {
        route = input.llmResolver.executionRouteFor(agent, await opencodeGate(), { callRole: "executor" });
        await logSkippedRoutes(ctx, nodeKey, route.skipped);
      }
      const prepared = resolutionByKey.get(nodeKey);
      resolutionByKey.delete(nodeKey);
      const routed = route
        ? route.runtime === "api"
          ? route.resolution
          : route.apiResolution
        : undefined;
      const llmHandles = routed
        ? handlesFromResolution(routed)
        : route
          ? undefined
          : prepared
            ? handlesFromResolution(prepared)
            : input.llmResolver?.handlesFor(agent, { callRole: "executor" });
      return { route, llmHandles };
    },

    /**
     * Plan 035: the effective OpenCode runtime and model for this node.
     * Plan 038: a route from the ordered list wins; without the OpenCode
     * provider the plan 035 selection applies, behind the same guard.
     */
    async runtime(nodeKey: string, agent: AgentDefinition, route: ExecutionRoute | undefined): Promise<OpencodeSelection> {
      let selection: OpencodeSelection = route
        ? route.runtime === "native-provider"
          ? { runtime: "native-provider", model: route.model }
          : { runtime: "api" }
        : selectionOf(ctx, agent);
      if (!route && selection.runtime === "native-provider") {
        const gate = await opencodeGate();
        if (!gate.available) {
          // A `runtime_unavailable` observation: the engine falls back to the API runtime, silently.
          const step = decideRetry({ kind: "runtime_unavailable", nodeKey, runtime: "native-provider", reason: gate.reason });
          if (step.kind === "fallback") {
            await logSkippedRoutes(ctx, nodeKey, [{ model: selection.model ?? "(OpenCode default)", reason: step.reason }]);
            selection = { runtime: step.runtime };
          }
        }
      }
      return selection;
    },
  };
}

export type ExecutionResolver = ReturnType<typeof createExecutionResolver>;

/** Load-aware and performance routing signals, read once per invocation (opt-in). */
export async function refreshRoutingSignals(ctx: RunContext): Promise<void> {
  // Load-aware routing (opt-in): read running executions per agent across
  // every task once per invocation. A failed read routes as usual.
  if (ctx.loadAwareRouting || ctx.performanceRouting) await refreshLoadSnapshot(ctx);
  if (ctx.performanceRouting) await refreshPerformanceScores(ctx);
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
