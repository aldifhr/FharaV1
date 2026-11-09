import { isTransientLlmError } from "@/effects/llmCall";
import { pathsOverlap } from "@/utils/ownershipPaths";

/** Default interval at which running nodes re-check for cancellation. */
const CANCEL_POLL_MS = 2_000;

export interface SchedulerNode {
  id: string;
  dependencies: string[];
  paths?: string[];
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
}

export interface SchedulerHooks {
  maxConcurrency: number;
  timeoutMs: number;
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
    Promise<{ node: SchedulerNode; outcome: NodeOutcome; attempt: number }>
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
    attempt: number
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
    const deadlineAt = Date.now() + hooks.timeoutMs;
    const timeout = new Promise<NodeOutcome>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve({ status: "failed", error: `Subtask timed out after ${hooks.timeoutMs}ms` });
      }, hooks.timeoutMs);
    });
    const promise = (async () => {
      try {
        await hooks.onStart(node, attempt);
        const outcome = await Promise.race([
          execute(node, controller.signal, { deadlineAt, attempt }),
          timeout,
        ]);
        if (timedOut) {
          return {
            node,
            outcome: { status: "failed" as const, error: `Subtask timed out after ${hooks.timeoutMs}ms` },
            attempt,
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
        controllers.delete(node.id);
      }
    })();
    running.set(node.id, promise);
  };

  const markBlocked = async (reason: string) => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, state] of states.entries()) {
        if (state !== "pending") continue;
        const node = byId.get(id);
        if (!node) continue;
        const blocking = node.dependencies.some((dependency) => {
          const dependencyState = states.get(dependency);
          return (
            dependencyState === "failed" ||
            dependencyState === "blocked" ||
            dependencyState === "waiting"
          );
        });
        const missing = node.dependencies.some((dependency) => !byId.has(dependency));
        if (blocking || missing) {
          states.set(id, "blocked");
          outcomes.set(id, {
            status: "failed",
            error: missing ? "Dependency does not exist" : reason,
          });
          failed.push(id);
          await hooks.onBlocked?.(node, missing ? "Dependency does not exist" : reason);
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
        const dependenciesSatisfied = node.dependencies.every(
          (dependency) => states.get(dependency) === "success"
        );
        if (!dependenciesSatisfied) continue;
        // Per-agent concurrency gate: a node whose agent is at its
        // limit is deferred to a later pass — not started, not failed.
        // It becomes runnable again as soon as a same-agent node
        // settles and frees a slot.
        if (hooks.canStartNode && !hooks.canStartNode(node)) continue;
        const ownedOverlap = Array.from(running.keys()).some((runningId) =>
          pathsOverlap(node.paths, byId.get(runningId)?.paths)
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
      await blockAllPending(
        stalledDeferred
          ? "Start gate never freed a slot for this subtask (agent concurrency limit)"
          : "Dependency could not run"
      );
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
    await settle(result.node, result.outcome, result.attempt);
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
