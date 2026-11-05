export interface SchedulerNode {
  id: string;
  dependencies: string[];
}

export type NodeOutcome =
  | { status: "completed"; output?: string; meta?: unknown }
  | { status: "failed"; error: string }
  | { status: "waiting_approval"; output?: string; meta?: unknown };

export interface SchedulerHooks {
  maxConcurrency: number;
  timeoutMs: number;
  retries: number;
  retryDelayMs?: number;
  shouldCancel?: () => Promise<boolean>;
  onStart: (node: SchedulerNode, attempt: number) => Promise<void>;
  onOutcome: (
    node: SchedulerNode,
    outcome: NodeOutcome,
    attempt: number
  ) => Promise<void>;
  onBlocked?: (node: SchedulerNode, reason: string) => Promise<void>;
}

export interface SchedulerResult {
  status: "completed" | "failed" | "cancelled" | "halted";
  outcomes: Map<string, NodeOutcome>;
  failed: string[];
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
  execute: (node: SchedulerNode, signal: AbortSignal) => Promise<NodeOutcome>,
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
  let halted = false;
  let cancelled = false;
  const concurrency = Math.max(1, hooks.maxConcurrency);
  const retryDelayMs = hooks.retryDelayMs ?? 250;

  const settle = async (
    node: SchedulerNode,
    outcome: NodeOutcome,
    attempt: number
  ): Promise<void> => {
    await hooks.onOutcome(node, outcome, attempt);
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
    if (attempt <= hooks.retries && !cancelled) {
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
    const timeout = new Promise<NodeOutcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: "failed", error: `Subtask timed out after ${hooks.timeoutMs}ms` });
      }, hooks.timeoutMs);
    });
    const promise = (async () => {
      try {
        await hooks.onStart(node, attempt);
        const outcome = await Promise.race([
          execute(node, controller.signal),
          timeout,
        ]);
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

    if (!cancelled && !halted) {
      for (const node of nodes) {
        if (running.size >= concurrency) break;
        if (states.get(node.id) !== "pending") continue;
        const dependenciesSatisfied = node.dependencies.every(
          (dependency) => states.get(dependency) === "success"
        );
        if (dependenciesSatisfied) start(node);
      }
    }

    if (running.size === 0) {
      await markBlocked("Dependency failed");
      const pendingLeft = Array.from(states.values()).some((state) => state === "pending");
      if (halted || cancelled || !pendingLeft) break;
      // No runnable nodes: treat remaining pending as blocked to avoid a deadlock.
      await markBlocked("Dependency could not run");
      break;
    }

    const result = await Promise.race(running.values());
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
