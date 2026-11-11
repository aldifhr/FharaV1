import { isTransientLlmError } from "@/effects/llmCall";
import { pathsOverlap } from "@/utils/ownershipPaths";
import {
  AGENT_STALLED_PREFIX,
  DEPENDENCY_DEADLOCK_PREFIX,
  isAgentStalledError,
  validateDag,
  type StallObservation,
} from "@/utils/stallDetector";

/** Default interval at which running nodes re-check for cancellation. */
const CANCEL_POLL_MS = 2_000;

export interface SchedulerNode {
  id: string;
  dependencies: string[];
  paths?: string[];
  /**
   * Whether the node edits files (code_change / shell). Two writing nodes
   * that both have no declared paths can touch anything, so they conflict.
   */
  writes?: boolean;
  /**
   * Runs on partial input: once every dependency has settled (succeeded,
   * failed or blocked) and at least one of them succeeded. Used by the
   * research synthesis node, which still answers from the angles that
   * produced a report when another angle failed. Default: every dependency
   * must succeed.
   */
  partialDependencies?: boolean;
}

const SETTLED_DEPENDENCY_STATES = new Set(["success", "failed", "blocked"]);

/**
 * Conflict guard for parallel runs: two nodes conflict (and are run one
 * after the other, never side by side) when their owned paths overlap —
 * an unscoped node overlaps any scoped one — or when both write files
 * with no declared scope at all.
 */
export function nodesConflict(a: SchedulerNode, b: SchedulerNode | undefined): boolean {
  if (!b) return false;
  if (pathsOverlap(a.paths, b.paths)) return true;
  const unscoped = (node: SchedulerNode) => !node.paths || node.paths.length === 0;
  return unscoped(a) && unscoped(b) && a.writes === true && b.writes === true;
}

export type NodeOutcome =
  | { status: "completed"; output?: string; meta?: unknown }
  | { status: "failed"; error: string; meta?: unknown }
  | { status: "waiting_approval"; output?: string; meta?: unknown };

/** Per-attempt facts the executor needs to budget its own work. */
export interface NodeRunInfo {
  /** Epoch ms at which this attempt's subtask timeout fires. */
  deadlineAt: number;
  attempt: number;
  /** Heartbeat for the stall watchdog: call on any observable progress. */
  progress: () => void;
  /**
   * Stop this attempt's subtask-timeout and stall clocks while the node
   * waits on a human (a run_command approval). Returns the release; the
   * timeout deadline moves out by the time spent held. Nested holds are
   * counted. A human wait is not agent work, so it must never time the
   * node out or trip the watchdog (it has its own approval timeout).
   */
  holdClock?: () => () => void;
}

export interface SchedulerHooks {
  maxConcurrency: number;
  timeoutMs: number;
  /**
   * Per-node timeout, read when the node starts (each attempt). Defaults
   * to `timeoutMs`. Lets the runner give a native (OpenCode) node or a
   * slow model more room without raising every node's bound.
   */
  nodeTimeoutMs?: (node: SchedulerNode) => number;
  retries: number;
  retryDelayMs?: number;
  shouldCancel?: () => Promise<boolean>;
  /** How often a running scheduler re-checks shouldCancel (default 2s). */
  cancelPollMs?: number;
  /**
   * Per-node start gate (Phase 4 per-agent concurrency): consulted on
   * every scan pass for every pending node whose dependencies are met.
   * When it returns false the node is DEFERRED — left pending, not
   * started and not failed — and reconsidered on later passes as other
   * nodes settle. The runner uses it to hold a subtask back while its
   * agent is already at AgentDefinition.maxConcurrency.
   */
  canStartNode?: (node: SchedulerNode) => boolean;
  /**
   * Final veto on retrying a failed node (Phase 4): consulted after the
   * static permanent/transient classification says a retry is allowed.
   * The runner uses it to stop retries once the task deadline has fired
   * or the LLM call budget can no longer pay for another attempt.
   */
  shouldRetryNode?: (
    node: SchedulerNode,
    outcome: NodeOutcome,
    attempt: number
  ) => boolean | Promise<boolean>;
  onStart: (node: SchedulerNode, attempt: number) => Promise<void>;
  /**
   * Called as each node settles. May return ADDITIONAL nodes to schedule
   * within this same invocation (Phase 3 dynamic work: delegation and
   * fix subtasks decided from this outcome). Returned nodes are
   * validated before admission — duplicate ids are dropped, dependencies
   * must reference nodes that already exist (or nodes accepted earlier
   * in the same batch), and `maxAddedNodes` caps the total admitted.
   */
  onOutcome: (
    node: SchedulerNode,
    outcome: NodeOutcome,
    attempt: number
  ) => Promise<SchedulerNode[] | void>;
  onBlocked?: (node: SchedulerNode, reason: string) => Promise<void>;
  /** Cap on dynamically added nodes across the whole run. Default: no cap. */
  maxAddedNodes?: number;
  /**
   * When this returns true, no further nodes are started (Phase 3:
   * budget BLOCKED). Nodes already running finish; nodes still pending
   * are then blocked with a halt reason instead of being executed.
   */
  shouldHaltNewNodes?: () => boolean;
  /**
   * Stall watchdog: a running node with no `info.progress()` heartbeat for
   * this long is aborted as "Agent stalled", retried `stallRetries` times
   * (default 1) and then escalated. 0 / unset disables it.
   */
  stallMs?: number;
  stallRetries?: number;
  /** Typed deadlock / stall observations (each condition classified on its own). */
  onStall?: (observation: StallObservation) => void | Promise<void>;
  /**
   * How long to wait for an aborted attempt's executor to settle before a
   * retry may start. Default 5000. When it does not settle in time the node
   * is failed as execution-uncertain and never retried automatically.
   */
  abortGraceMs?: number;
}

export interface SchedulerResult {
  status: "completed" | "failed" | "cancelled" | "halted";
  outcomes: Map<string, NodeOutcome>;
  failed: string[];
}

/**
 * Subtask failure patterns that can never succeed on a blind retry: the
 * inputs are deterministic (plan shape, path policy, capability routing,
 * the model's final unparseable answer), so replaying the same subtask
 * would fail identically while burning time and tokens. Patterns mirror
 * the actual error strings produced by planValidator, the governance path
 * guard, capability routing, and the executor's final-JSON parsing.
 */
const PERMANENT_SUBTASK_ERROR_PATTERNS: readonly RegExp[] = [
  // Forbidden / protected paths (governance validateFilePath, executor guards)
  /refusing to modify protected path/i,
  /outside declared ownership/i,
  /file[- ]path[- ]forbidden/i,
  /forbidden path/i,
  // No agent can serve the requested capability (routing is deterministic)
  /no enabled agent (can serve|for) capability/i,
  /no agent (available|found) for capability/i,
  // The model's final answer could not be parsed as the required JSON
  /did not return valid [^.]*json/i,
  /unparseable/i,
  /invalid json/i,
  /failed to parse [^.]*json/i,
  // A failed QA verdict on unchanged code: the QA loop owns the fix round;
  // a blind retry only re-ran the same browser check (two identical
  // "QA verdict: failed" messages on different ports).
  // Every deterministic QA check failure (structural/viewport checks,
  // console errors, overlay, empty body, 4xx) re-runs identically, so it
  // goes straight to qa.failed / the fix round. Environment-flaky signals
  // stay retryable: a QA harness exception ("qa-run: ..."), a 5xx while
  // the dev server is still compiling, navigation timeouts, net::ERR_*.
  /^QA failed: (?!qa-run:)(?![\s\S]*(?:Page returned HTTP 5\d\d|Timeout \d+ms exceeded|timed out|net::ERR_))/,
  // Plan 022: an executor escalation waits for a CTO / user decision;
  // replaying the same subtask would only escalate again.
  /^Escalated \(/,
  /role is read-only/i,
  // Plan 040: a role permission refusal is final for that agent.
  /^Refused: the .* role /,
  // Plan validation failures (planValidator messages)
  /^plan\.(goal|subtasks) /i,
  /plan has \d+ subtasks; limit is/i,
  /duplicate subtask key/i,
  /depends on unknown subtask/i,
  /depends on itself/i,
  /dependency cycle detected/i,
  /subtask .*: (kind must be one of|capability is required)/i,
  /subtask\[\d+\] (must be an object|key is invalid)/i,
];

export function isPermanentSubtaskError(error: string): boolean {
  return PERMANENT_SUBTASK_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

/**
 * Whether a failed subtask outcome is worth retrying. Permanent failures
 * fail immediately; failures that came out of the LLM layer keep the LLM
 * transient/permanent classification from effects/llmCall (429/5xx/network
 * retry, other 4xx do not); everything else keeps the historical
 * retry-while-attempts-remain behavior.
 */
export function shouldRetrySubtask(error: string): boolean {
  if (isPermanentSubtaskError(error)) return false;
  if (/LLM request failed/i.test(error)) {
    return isTransientLlmError(new Error(error));
  }
  return true;
}

type State =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "blocked"
  | "waiting";

export async function runScheduler(
  nodes: SchedulerNode[],
  execute: (node: SchedulerNode, signal: AbortSignal, info: NodeRunInfo) => Promise<NodeOutcome>,
  hooks: SchedulerHooks
): Promise<SchedulerResult> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const states = new Map<string, State>(nodes.map((node) => [node.id, "pending"]));
  const outcomes = new Map<string, NodeOutcome>();
  const attempts = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  const controllers = new Map<string, AbortController>();
  const running = new Map<
    string,
    Promise<{
      node: SchedulerNode;
      outcome: NodeOutcome;
      attempt: number;
      /** The aborted attempt did not settle within `abortGraceMs`. */
      executionUncertain?: boolean;
    }>
  >();
  const failed: string[] = [];
  // Live node list: the initial plan plus everything admitted dynamically.
  const allNodes: SchedulerNode[] = [...nodes];
  let addedCount = 0;
  let halted = false;
  let cancelled = false;
  let haltLatched = false;
  const concurrency = Math.max(1, hooks.maxConcurrency);
  const retryDelayMs = hooks.retryDelayMs ?? 250;
  const maxAddedNodes = hooks.maxAddedNodes ?? Number.POSITIVE_INFINITY;
  const stallCounts = new Map<string, number>();
  const stallRetries = Math.max(0, hooks.stallRetries ?? 1);
  const abortGraceMs = Math.max(0, hooks.abortGraceMs ?? 5_000);
  const observe = async (observation: StallObservation): Promise<void> => {
    try {
      await hooks.onStall?.(observation);
    } catch {
      // Observability never changes the scheduling outcome.
    }
  };

  /**
   * Admit dynamically returned nodes. A node is admitted only when its id
   * is new (anti-duplicate: a key that already ran or is queued is never
   * scheduled twice) and every dependency already exists — either in the
   * graph or accepted earlier in this same batch, so intra-batch chains
   * work while references to unknown/future nodes are dropped, not
   * deadlocked. Admission stops at the maxAddedNodes cap.
   */
  const addNodes = (candidates: SchedulerNode[]): void => {
    const acceptedIds = new Set<string>();
    for (const candidate of candidates) {
      if (addedCount >= maxAddedNodes) break;
      if (byId.has(candidate.id) || acceptedIds.has(candidate.id)) continue;
      const dependenciesKnown = candidate.dependencies.every(
        (dependency) => byId.has(dependency) || acceptedIds.has(dependency)
      );
      if (!dependenciesKnown) continue;
      acceptedIds.add(candidate.id);
      byId.set(candidate.id, candidate);
      states.set(candidate.id, "pending");
      attempts.set(candidate.id, 0);
      allNodes.push(candidate);
      addedCount += 1;
    }
  };

  const settle = async (
    node: SchedulerNode,
    outcome: NodeOutcome,
    attempt: number,
    executionUncertain?: boolean
  ): Promise<void> => {
    const added = await hooks.onOutcome(node, outcome, attempt);
    if (added && added.length > 0) addNodes(added);
    if (outcome.status === "completed") {
      states.set(node.id, "success");
      outcomes.set(node.id, outcome);
      return;
    }
    if (outcome.status === "waiting_approval") {
      states.set(node.id, "waiting");
      outcomes.set(node.id, outcome);
      halted = true;
      return;
    }
    // The aborted attempt never actually stopped: retrying would run a second
    // attempt beside a live one, so the node fails without an automatic retry.
    if (executionUncertain) {
      states.set(node.id, "failed");
      outcomes.set(node.id, {
        status: "failed",
        error: `Execution uncertain: the aborted attempt did not stop within ${abortGraceMs}ms; not retried automatically`,
        meta: outcome.meta,
      });
      failed.push(node.id);
      return;
    }
    // Agent stalled (watchdog): retried `stallRetries` times regardless of
    // the generic retry budget, then escalated — never a generic timeout.
    if (isAgentStalledError(outcome.error)) {
      const stalls = (stallCounts.get(node.id) ?? 0) + 1;
      stallCounts.set(node.id, stalls);
      const canRetry =
        stalls <= stallRetries &&
        !cancelled &&
        !haltLatched &&
        !hooks.shouldHaltNewNodes?.() &&
        (!hooks.shouldRetryNode || (await hooks.shouldRetryNode(node, outcome, attempt)));
      await observe({
        kind: "agent_stalled",
        action: canRetry ? "retry" : "escalate",
        nodeKey: node.id,
        reason: outcome.error,
        detail: { stalls, attempt, stallMs: hooks.stallMs },
      });
      if (canRetry) {
        states.set(node.id, "pending");
        return;
      }
      const escalated: NodeOutcome = {
        status: "failed",
        error: `Escalated (agent_stalled): ${outcome.error} on ${stalls} attempt(s); not retried again`,
        meta: outcome.meta,
      };
      states.set(node.id, "failed");
      outcomes.set(node.id, escalated);
      failed.push(node.id);
      return;
    }
    // Permanent failures (invalid plan, forbidden path, no agent for the
    // capability, unparseable final JSON, permanent LLM 4xx) settle as
    // failed immediately — replaying the same subtask cannot change them.
    if (!shouldRetrySubtask(outcome.error)) {
      states.set(node.id, "failed");
      outcomes.set(node.id, outcome);
      failed.push(node.id);
      return;
    }
    // A halt latched by this very outcome (e.g. the decision hook chose
    // replan, or the budget/step limit hit) means the retry would never
    // start: re-queueing it as pending only gets it swept by
    // blockAllPending, which overwrote the real error ("Subtask timed out
    // after …") with "Scheduling halted …" — in the subtask row and in the
    // replan feedback (e2e ULTRA). Settle it as failed with its own error.
    if (haltLatched || hooks.shouldHaltNewNodes?.()) {
      states.set(node.id, "failed");
      outcomes.set(node.id, outcome);
      failed.push(node.id);
      return;
    }
    if (attempt <= hooks.retries && !cancelled) {
      // Even a classifiable retry is vetoed when the surrounding task
      // can no longer pay for it (deadline fired / LLM budget spent).
      if (
        hooks.shouldRetryNode &&
        !(await hooks.shouldRetryNode(node, outcome, attempt))
      ) {
        states.set(node.id, "failed");
        outcomes.set(node.id, outcome);
        failed.push(node.id);
        return;
      }
      states.set(node.id, "pending");
      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
      return;
    }
    states.set(node.id, "failed");
    outcomes.set(node.id, outcome);
    failed.push(node.id);
  };

  const start = (node: SchedulerNode) => {
    const attempt = (attempts.get(node.id) ?? 0) + 1;
    attempts.set(node.id, attempt);
    states.set(node.id, "running");
    const controller = new AbortController();
    controllers.set(node.id, controller);
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let stalled = false;
    const nodeTimeout = Math.max(1, hooks.nodeTimeoutMs?.(node) ?? hooks.timeoutMs);
    const deadlineAt = Date.now() + nodeTimeout;
    // Clock holds (human waits): while held, neither the timeout nor the
    // stall watchdog may fire; on release the timeout deadline is pushed
    // out by the held duration and the stall clock restarts.
    let holds = 0;
    let heldSince = 0;
    let heldTotal = 0;
    let lastProgress = Date.now();
    const progress = () => {
      lastProgress = Date.now();
    };
    const timeout = new Promise<NodeOutcome>((resolve) => {
      const arm = (ms: number) => {
        timer = setTimeout(() => {
          if (holds > 0) return arm(Math.max(50, Math.min(nodeTimeout, 1_000)));
          const remaining = deadlineAt + heldTotal - Date.now();
          if (remaining > 0) return arm(remaining);
          timedOut = true;
          controller.abort();
          resolve({ status: "failed", error: `Subtask timed out after ${nodeTimeout}ms` });
        }, ms);
      };
      arm(nodeTimeout);
    });
    const holdClock = () => {
      if (holds === 0) heldSince = Date.now();
      holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        if (holds === 0) {
          heldTotal += Date.now() - heldSince;
          progress();
        }
      };
    };
    let stallTimer: ReturnType<typeof setInterval> | undefined;
    const stallMs = hooks.stallMs ?? 0;
    const stallError = `${AGENT_STALLED_PREFIX}: no output or heartbeat progress for ${stallMs}ms`;
    const stall =
      stallMs > 0
        ? new Promise<NodeOutcome>((resolve) => {
            stallTimer = setInterval(() => {
              if (holds > 0) return;
              if (Date.now() - lastProgress <= stallMs) return;
              if (stallTimer) clearInterval(stallTimer);
              stalled = true;
              controller.abort();
              resolve({ status: "failed", error: stallError });
            }, Math.min(5_000, Math.max(50, Math.floor(stallMs / 4))));
            (stallTimer as { unref?: () => void }).unref?.();
          })
        : undefined;
    const promise = (async () => {
      try {
        await hooks.onStart(node, attempt);
        progress();
        const execution = execute(node, controller.signal, { deadlineAt, attempt, progress, holdClock });
        const outcome = await Promise.race([execution, timeout, ...(stall ? [stall] : [])]);
        if (timedOut || stalled) {
          // The attempt was aborted. Wait for the executor to actually settle
          // — bounded by the grace period — before the scheduler may retry,
          // so two attempts never run at once. If it does not settle, the
          // outcome is execution-uncertain and is never retried.
          let graceTimer: NodeJS.Timeout | undefined;
          const settled = await Promise.race([
            execution.then(
              () => true,
              () => true
            ),
            new Promise<boolean>((resolve) => {
              graceTimer = setTimeout(() => resolve(false), abortGraceMs);
              (graceTimer as { unref?: () => void }).unref?.();
            }),
          ]);
          if (graceTimer) clearTimeout(graceTimer);
          return {
            node,
            outcome: {
              status: "failed" as const,
              error: timedOut
                ? `Subtask timed out after ${nodeTimeout}ms`
                : stallError,
            },
            attempt,
            executionUncertain: !settled,
          };
        }
        return { node, outcome, attempt };
      } catch (error) {
        return {
          node,
          outcome: {
            status: "failed" as const,
            error: error instanceof Error ? error.message : String(error),
          },
          attempt,
        };
      } finally {
        if (timer) clearTimeout(timer);
        if (stallTimer) clearInterval(stallTimer);
        controllers.delete(node.id);
      }
    })();
    running.set(node.id, promise);
  };

  /** Every dependency succeeded; or, for a partialDependencies node, all settled and one succeeded. */
  const dependenciesReady = (node: SchedulerNode): boolean => {
    if (!node.partialDependencies) {
      return node.dependencies.every((dependency) => states.get(dependency) === "success");
    }
    if (node.dependencies.some((dependency) => !byId.has(dependency))) return false;
    return (
      node.dependencies.every((dependency) => SETTLED_DEPENDENCY_STATES.has(states.get(dependency) ?? "")) &&
      node.dependencies.some((dependency) => states.get(dependency) === "success")
    );
  };

  const markBlocked = async (reason: string) => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, state] of states.entries()) {
        if (state !== "pending") continue;
        const node = byId.get(id);
        if (!node) continue;
        const missingDependency = node.dependencies.find((dependency) => !byId.has(dependency));
        // A partialDependencies node is blocked only once no dependency can
        // succeed any more (one success is enough for it to run).
        const anySuccess = node.partialDependencies
          ? node.dependencies.some((dependency) => states.get(dependency) === "success")
          : false;
        const blockingDependency = anySuccess ? undefined : node.dependencies.find((dependency) => {
          const dependencyState = states.get(dependency);
          return (
            dependencyState === "failed" ||
            dependencyState === "blocked" ||
            dependencyState === "waiting"
          );
        });
        if (blockingDependency !== undefined || missingDependency !== undefined) {
          // Dependency deadlock: this node can never run. Name the
          // dependency and why (failed / cancelled-or-blocked / missing).
          const dependencyState = blockingDependency ? states.get(blockingDependency) : undefined;
          const why =
            missingDependency !== undefined
              ? `depends on "${missingDependency}", which does not exist`
              : `waits on "${blockingDependency}" (${
                  dependencyState === "failed"
                    ? "failed"
                    : dependencyState === "waiting"
                      ? "awaiting approval"
                      : "cancelled/blocked"
                })`;
          const error = `${DEPENDENCY_DEADLOCK_PREFIX}: ${why}`;
          states.set(id, "blocked");
          outcomes.set(id, { status: "failed", error });
          failed.push(id);
          await hooks.onBlocked?.(node, error);
          await observe({
            kind: "dependency_deadlock",
            action: "fail",
            nodeKey: id,
            reason: error,
            detail: {
              dependency: missingDependency ?? blockingDependency,
              dependencyState: missingDependency !== undefined ? "missing" : dependencyState === "blocked" ? "cancelled" : dependencyState,
              ...(reason !== "Dependency failed" ? { context: reason } : {}),
            },
          });
          changed = true;
        }
      }
    }
  };

  /** Block every still-pending node (used when scheduling is halted). */
  const blockAllPending = async (reason: string) => {
    for (const [id, state] of states.entries()) {
      if (state !== "pending") continue;
      const node = byId.get(id);
      if (!node) continue;
      states.set(id, "blocked");
      outcomes.set(id, { status: "failed", error: reason });
      failed.push(id);
      await hooks.onBlocked?.(node, reason);
    }
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!cancelled && hooks.shouldCancel) {
      cancelled = await hooks.shouldCancel();
      if (cancelled) {
        for (const controller of controllers.values()) controller.abort();
      }
    }
    if (cancelled) {
      for (const [id, state] of states.entries()) {
        if (state === "pending") states.set(id, "blocked");
      }
      if (running.size === 0) break;
    }

    if (!haltLatched && hooks.shouldHaltNewNodes?.()) {
      haltLatched = true;
    }

    if (!cancelled && !halted && !haltLatched) {
      for (const node of allNodes) {
        if (running.size >= concurrency) break;
        if (states.get(node.id) !== "pending") continue;
        if (!dependenciesReady(node)) continue;
        // Per-agent concurrency gate: a node whose agent is at its
        // limit is deferred to a later pass — not started, not failed.
        // It becomes runnable again as soon as a same-agent node
        // settles and frees a slot.
        if (hooks.canStartNode && !hooks.canStartNode(node)) continue;
        // Conflict guard: a ready node whose files overlap a running
        // node's (including one started earlier in this same pass) is
        // deferred until that node settles — serialized, not failed.
        const ownedOverlap = Array.from(running.keys()).some((runningId) =>
          nodesConflict(node, byId.get(runningId))
        );
        if (ownedOverlap) continue;
        start(node);
      }
    }

    if (running.size === 0) {
      // A node in "waiting" means approval is pending — that's a halt, not a
      // failure. Everything else that cannot run is a failure.
      const hasWaiting = Array.from(states.values()).some((state) => state === "waiting");
      if (hasWaiting) {
        return { status: "halted", outcomes, failed };
      }
      if (haltLatched) {
        // Graceful stop: running work has drained; pending work is
        // blocked with the halt reason instead of being executed. When
        // the halt only landed after every node had already settled
        // (e.g. a "complete" decision latching decisionTerminal after
        // the final node), nothing was blocked — this is a success.
        await blockAllPending("Scheduling halted before this subtask could run");
        if (failed.length === 0) {
          return { status: "completed", outcomes, failed };
        }
        return { status: "halted", outcomes, failed };
      }
      await markBlocked("Dependency failed");
      // Blocking may have settled the last open dependency of a
      // partialDependencies node: give it a start pass instead of ending.
      if (
        !cancelled &&
        !halted &&
        allNodes.some(
          (node) =>
            node.partialDependencies &&
            states.get(node.id) === "pending" &&
            dependenciesReady(node) &&
            (!hooks.canStartNode || hooks.canStartNode(node))
        )
      ) {
        continue;
      }
      const pendingLeft = Array.from(states.values()).some((state) => state === "pending");
      // A dependency that never ran (missing dep, cycle) blocks dependents
      // via markBlocked above; anything still pending after that is stalled
      // on the start gate. Either way the DAG cannot proceed.
      if (failed.length > 0 || !pendingLeft) {
        return { status: failed.length ? "failed" : "completed", outcomes, failed };
      }
      // Nothing is running and nothing can start, yet nodes remain
      // pending: their dependencies can never be satisfied (a cycle the
      // validator missed) or every runnable node is deferred by the
      // start gate with no running work left to free a slot. Block them
      // explicitly so the run ends with a clear status instead of
      // spinning forever or reporting a false success.
      const stalledDeferred = allNodes.some(
        (node) =>
          states.get(node.id) === "pending" &&
          node.dependencies.every(
            (dependency) => states.get(dependency) === "success"
          ) &&
          hooks.canStartNode !== undefined &&
          !hooks.canStartNode(node)
      );
      // No runnable nodes while nothing is running: validate the
      // remaining DAG and report what actually holds it (a cycle, the
      // start gate) instead of a generic "could not run".
      const pendingNodes = allNodes.filter((node) => states.get(node.id) === "pending");
      const validation = validateDag(pendingNodes);
      const cycleMembers = new Set(validation.cycle ?? []);
      await observe({
        kind: "no_runnable_nodes",
        action: "report",
        reason: validation.cycle
          ? `No runnable nodes: dependency cycle ${validation.cycle.join(" -> ")}`
          : stalledDeferred
            ? "No runnable nodes: the agent concurrency gate never freed a slot"
            : "No runnable nodes: pending dependencies can never be satisfied",
        detail: {
          pending: pendingNodes.map((node) => node.id),
          cycle: validation.cycle,
          deferredByStartGate: stalledDeferred,
        },
      });
      if (stalledDeferred && !validation.cycle) {
        await blockAllPending("Start gate never freed a slot for this subtask (agent concurrency limit)");
        return { status: "failed", outcomes, failed };
      }
      for (const node of pendingNodes) {
        const error = cycleMembers.has(node.id)
          ? `${DEPENDENCY_DEADLOCK_PREFIX}: dependency cycle ${validation.cycle!.join(" -> ")}`
          : `${DEPENDENCY_DEADLOCK_PREFIX}: waits on "${
              node.dependencies.find((dependency) => states.get(dependency) !== "success") ?? "?"
            }" (${validation.cycle ? "cyclic" : "never runnable"})`;
        states.set(node.id, "blocked");
        outcomes.set(node.id, { status: "failed", error });
        failed.push(node.id);
        await hooks.onBlocked?.(node, error);
        await observe({ kind: "dependency_deadlock", action: "fail", nodeKey: node.id, reason: error, detail: { cycle: validation.cycle } });
      }
      return { status: "failed", outcomes, failed };
    }

    // Wake up periodically while nodes run so a cancel (task cancelled
    // by the user, deadline) is noticed and aborts the running nodes
    // instead of waiting for a long LLM call to finish on its own.
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const pollWake = hooks.shouldCancel && !cancelled
      ? new Promise<null>((resolve) => {
          pollTimer = setTimeout(() => resolve(null), hooks.cancelPollMs ?? CANCEL_POLL_MS);
          (pollTimer as { unref?: () => void }).unref?.();
        })
      : undefined;
    const result = await Promise.race(pollWake ? [...running.values(), pollWake] : running.values());
    if (pollTimer) clearTimeout(pollTimer);
    if (result === null) continue;
    running.delete(result.node.id);
    if (cancelled) {
      states.set(result.node.id, "blocked");
      continue;
    }
    await settle(result.node, result.outcome, result.attempt, result.executionUncertain);
  }

  const status: SchedulerResult["status"] = cancelled
    ? "cancelled"
    : halted
      ? "halted"
      : failed.length > 0
        ? "failed"
        : "completed";

  return { status, outcomes, failed };
}
