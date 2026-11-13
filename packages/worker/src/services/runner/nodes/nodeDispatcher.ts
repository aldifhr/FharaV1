import type { PlanSubtask } from "@/types";
import type { SchedulerHooks, SchedulerNode } from "@/scheduler/dagScheduler";
import type { StallThresholds } from "@/utils/stallDetector";
import { isResearchSynthesis } from "@/prompts/research";
import type { RunContext } from "../types";
import { createCancelCheck, retryAllowed, shouldHaltNewNodes } from "./executionGuard";
import { nodeTimeoutFor } from "./executionResolver";
import { blockNode, settleNode, startNode, type NodeLifecycleEnv } from "./nodeLifecycle";

/**
 * Dispatch of ready subtasks for the DAG nodes runner: the scheduler
 * graph, its hooks (lifecycle callbacks, guards) and per-agent concurrency.
 * Part of `runNodes` (split out with no behaviour change).
 */

/** The scheduler graph: dependencies outside the subset are not ordered here. */
export function toSchedulerNodes(nodes: PlanSubtask[], subsetKeys: Set<string>): SchedulerNode[] {
  return nodes.map((subtask) => ({
    id: subtask.key,
    dependencies: subtask.dependencies.filter((dependency) => subsetKeys.has(dependency)),
    paths: subtask.allowedPaths,
    writes: subtask.kind === "code_change" || subtask.kind === "shell",
    // O7: the research synthesis answers from the angles that succeeded.
    ...(isResearchSynthesis(subtask) ? { partialDependencies: true } : {}),
  }));
}

/**
 * Per-agent concurrency (Phase 4): a node whose agent is already running
 * maxConcurrency subtasks is deferred by the scheduler until one of them
 * settles and frees a slot. The limit mirrors the delegation gate's
 * semantics (orchestrator/delegation.ts): an unset maxConcurrency means 1.
 */
export function agentHasSlot(ctx: Pick<RunContext, "assign" | "activeByAgent">, nodeKey: string): boolean {
  const agent = ctx.assign(nodeKey);
  if (!agent) return true;
  const limit = agent.maxConcurrency ?? 1;
  return (ctx.activeByAgent.get(agent._id) ?? 0) < limit;
}

/** The scheduler hooks of one runNodes invocation. */
export function schedulerHooks(env: NodeLifecycleEnv, stallThresholds: StallThresholds): SchedulerHooks {
  const { ctx } = env;
  const { deps } = ctx;
  return {
    // Sequential by default (policy.maxConcurrency defaults to 1: FIFO,
    // one subtask at a time in DAG order). A policy that raises it lets
    // independent nodes overlap; the per-agent gate below still applies.
    maxConcurrency: Math.max(1, Math.floor(deps.policy.maxConcurrency ?? 1)),
    timeoutMs: deps.policy.subtaskTimeoutMs,
    nodeTimeoutMs: (node) => nodeTimeoutFor(ctx, ctx.assign(node.id)),
    retries: deps.policy.subtaskRetries,
    // Phase 3 dynamic work: onOutcome may add delegation/fix subtasks
    // to this same invocation, capped per invocation; a budget BLOCKED
    // decision latches the halt so no new nodes start afterwards.
    maxAddedNodes: deps.policy.maxSubtasks,
    // Deadlock & stall detector: typed observations per condition, and
    // the no-progress watchdog (retry once, then escalate).
    stallMs: stallThresholds.agentStallMs,
    stallRetries: stallThresholds.agentStallRetries,
    onStall: env.reportStall,
    shouldHaltNewNodes: () => shouldHaltNewNodes(ctx),
    shouldCancel: createCancelCheck(ctx),
    canStartNode: (node) => agentHasSlot(ctx, node.id),
    shouldRetryNode: () => retryAllowed(ctx.input),
    onStart: (node, attempt) => startNode(env, node, attempt),
    onOutcome: (node, outcome, attempt) => settleNode(env, node, outcome, attempt),
    onBlocked: (node, reason) => blockNode(env, node, reason),
  };
}
