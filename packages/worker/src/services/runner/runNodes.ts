import type { PlanSubtask } from "@/types";
import { runScheduler, type SchedulerResult } from "@/scheduler/dagScheduler";
import { stallThresholdsFromEnv } from "@/utils/stallDetector";
import { llmTimeoutMs } from "@/llm";
import { createInputDeliveryAck } from "./session";
import type { RunContext } from "./types";
import { schedulerHooks, toSchedulerNodes } from "./nodes/nodeDispatcher";
import { createExecutionResolver, refreshRoutingSignals } from "./nodes/executionResolver";
import { createSiblingTracker, prerequisiteFailure, runNode, type NodeLifecycleEnv } from "./nodes/nodeLifecycle";
import { createStallReporter } from "./nodes/nodeObserver";

/**
 * The DAG nodes runner (plan 012 step 2): run a set of subtasks through
 * the scheduler with per-node execution resolution, timeout and abort
 * wiring. State is threaded through `ctx`, so every mutation (complete
 * set, active map, file changes) flows through the shared containers.
 *
 * Thin wiring over its implementation details in `nodes/`:
 *   nodeDispatcher    scheduler graph + hooks, per-agent concurrency
 *   executionResolver agent / model resolution, OpenCode routing
 *   executionGuard    deadline, cancellation and budget checks
 *   nodeLifecycle     start / execute / settle / persist one node
 *   nodeObserver      progress and event reporting (qaNode: live QA card)
 * Retry decisions stay in `orchestrator/decisionEngine/retry`.
 */
export async function runNodes(ctx: RunContext, nodes: PlanSubtask[]): Promise<SchedulerResult> {
  const subsetKeys = new Set(nodes.map((node) => node.key));
  const resolver = createExecutionResolver(ctx);
  await refreshRoutingSignals(ctx);
  const ackInputs = createInputDeliveryAck(ctx.deps);
  // Sibling context: which subtasks of this invocation are running now and
  // which have settled, so each node's prompt can list the others.
  const siblings = createSiblingTracker(subsetKeys);
  const unmet = prerequisiteFailure(ctx, nodes, subsetKeys);
  if (unmet) return unmet;
  const stallThresholds = ctx.stallThresholds ?? stallThresholdsFromEnv(undefined, llmTimeoutMs());
  const env: NodeLifecycleEnv = { ctx, resolver, siblings, ackInputs, reportStall: createStallReporter(ctx) };
  return runScheduler(
    toSchedulerNodes(nodes, subsetKeys),
    (node, signal, runInfo) => runNode(env, node, signal, runInfo),
    schedulerHooks(env, stallThresholds)
  );
}
