/**
 * Deadlock & stall detection vocabulary (pure). Each condition is
 * classified on its own — never collapsed into a generic timeout — and
 * reported as a typed observation the runner logs as `stall.<kind>`.
 *
 *   dependency_deadlock   pending node whose deps failed / were cancelled /
 *                         form a cycle → the node fails with that reason
 *   no_runnable_nodes     nothing running and nothing can start → the DAG
 *                         is validated and the finding reported
 *   agent_stalled         running node with no progress within the
 *                         threshold → retried once, then escalated
 *   repeated_output       the same output hash N times in a fix loop →
 *                         the loop stops
 *   provider_unavailable  connection / 5xx / 429 → next provider in the
 *                         fallback chain, else a clear failure
 *   output_truncated      the model stopped at the output cap
 *                         (finish_reason "length") → reported as a warning
 *
 * This is the minimal internal interface; when the orch-trace
 * ExecutionObservation table lands, these map 1:1 onto its rows.
 */
import { wenv } from "@fhara/config/worker";
import { createHash } from "node:crypto";

export type StallKind =
  | "dependency_deadlock"
  | "no_runnable_nodes"
  | "agent_stalled"
  | "repeated_output"
  | "provider_unavailable"
  | "output_truncated";

export type StallAction = "fail" | "retry" | "escalate" | "stop_loop" | "fallback" | "report";

export interface StallObservation {
  kind: StallKind;
  action: StallAction;
  /** Subtask key the condition is about (absent for task/provider-level ones). */
  nodeKey?: string;
  reason: string;
  detail?: Record<string, unknown>;
}

export type StallSink = (observation: StallObservation) => void | Promise<void>;

/** Event type for one observation (`stall.agent_stalled`, ...). */
export function stallEventType(kind: StallKind): string {
  return `stall.${kind}`;
}

export interface StallThresholds {
  /** No-progress window for a running node; 0 disables the watchdog. */
  agentStallMs: number;
  /** Stall retries before escalation (spec: retry once). */
  agentStallRetries: number;
  /** Identical consecutive outputs in one fix loop that stop it. */
  repeatedOutputLimit: number;
}

/**
 * Defaults: the stall window is one full LLM call timeout plus a minute,
 * so a node waiting on a single in-flight model call (which has its own
 * timeout) is never called stalled; it catches hung tools / runtimes.
 */
export function stallThresholdsFromEnv(
  env?: Record<string, string | undefined>,
  llmTimeoutMs = 300_000
): StallThresholds {
  return {
    // 0 = off; bounds 10s..1h (schema). The default follows the caller's LLM timeout.
    agentStallMs: wenv("ORCHESTRATOR_STALL_TIMEOUT_MS", env, { fallback: llmTimeoutMs + 60_000 }),
    agentStallRetries: wenv("ORCHESTRATOR_STALL_RETRIES", env),
    repeatedOutputLimit: wenv("ORCHESTRATOR_REPEAT_OUTPUT_LIMIT", env),
  };
}

/** Stable hash of an output, insensitive to whitespace / case / volatile numbers like ports and timings. */
export function outputHash(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/\b\d+(\.\d+)?\s*(ms|s)\b/g, "#")
    .replace(/:\d{2,5}\b/g, ":#")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Counts identical CONSECUTIVE outputs per loop. `observe` returns the
 * run length of the current hash; at `limit` the loop is repeating itself.
 */
export class RepeatedOutputGuard {
  private readonly runs = new Map<string, { hash: string; count: number }>();
  constructor(readonly limit: number) {}

  observe(loop: string, text: string): { hash: string; count: number; repeated: boolean } {
    const hash = outputHash(text);
    const previous = this.runs.get(loop);
    const count = previous && previous.hash === hash ? previous.count + 1 : 1;
    this.runs.set(loop, { hash, count });
    return { hash, count, repeated: count >= this.limit };
  }

  reset(loop: string): void {
    this.runs.delete(loop);
  }
}

export type ProviderFailureClass = "connection" | "server_error" | "rate_limited";

const CONNECTION_ERROR =
  /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|fetch failed|network error|connection (error|refused|reset|closed))\b/i;

/**
 * Provider-unavailable class of an LLM error, or null when it is something
 * else (4xx, abort, parse, a context overflow, a reply cut short). A typed
 * wire error (llm/errors.ts) is classified by its kind: a dropped socket is
 * "connection" whatever undici called it.
 */
export function classifyProviderError(error: unknown): ProviderFailureClass | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { status?: unknown; statusCode?: unknown; message?: unknown; code?: unknown; name?: unknown; kind?: unknown };
  if (candidate.name === "AbortError") return null;
  if (candidate.kind === "connection") return "connection";
  if (candidate.kind === "context_overflow" || candidate.kind === "malformed" || candidate.kind === "incomplete") return null;
  const status =
    typeof candidate.status === "number"
      ? candidate.status
      : typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : undefined;
  const message = typeof candidate.message === "string" ? candidate.message : "";
  const embedded = status ?? (/\((\d{3})\)/.exec(message) ? Number(/\((\d{3})\)/.exec(message)![1]) : undefined);
  if (embedded !== undefined) {
    if (embedded === 429) return "rate_limited";
    if (embedded >= 500) return "server_error";
    return null;
  }
  if (typeof candidate.code === "string" && CONNECTION_ERROR.test(candidate.code)) return "connection";
  if (CONNECTION_ERROR.test(message)) return "connection";
  return null;
}

/** Message prefix of a stall-watchdog failure (the scheduler's own string). */
export const AGENT_STALLED_PREFIX = "Agent stalled";

export function isAgentStalledError(error: string): boolean {
  return error.startsWith(AGENT_STALLED_PREFIX);
}

/** Prefix the scheduler gives a node failed by a dependency deadlock. */
export const DEPENDENCY_DEADLOCK_PREFIX = "Dependency deadlock";

/** Missing deps and the first cycle among `nodes` (structural DAG validation). */
export function validateDag(
  nodes: Array<{ id: string; dependencies: string[] }>
): { cycle: string[] | null; missing: Array<{ node: string; dependency: string }> } {
  const ids = new Set(nodes.map((node) => node.id));
  const missing: Array<{ node: string; dependency: string }> = [];
  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      if (!ids.has(dependency)) missing.push({ node: node.id, dependency });
    }
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    const current = state.get(id);
    if (current === 2) return null;
    if (current === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (!byId.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const node of nodes) {
    const cycle = visit(node.id);
    if (cycle) return { cycle, missing };
  }
  return { cycle: null, missing };
}
