import { wenv } from "@fhara/config/worker";
import { Effect, Schedule } from "effect";
import { effectiveLlmTimeoutMs, type GlobalLLMConfig, type LLMMessage, type LLMProvider, type LLMResult } from "@/llm";
import type { ProviderHealthRegistry } from "@/llm/health";
import type { TokenUsageMeta } from "@/types/llm";
import { currentSnapshotScope, recordLlmSnapshot } from "@/llm/snapshots";
import type { CallRole } from "@/api/convex/lib/contextSnapshot";
import { classifyProviderError } from "@/utils/stallDetector";
import { isEmptyCompletion } from "@/api/convex/lib/llmRotation";
import { emitObservation, markProgress } from "./observationContext";

export type { TokenUsageMeta } from "@/types/llm";

/**
 * Whether an LLM call failure is worth retrying.
 * Transient: network errors, timeouts, HTTP 429 and 5xx.
 * Permanent: other HTTP 4xx (bad request, auth, not found) — retrying the
 * same payload cannot succeed. Errors carrying no HTTP status at all are
 * treated as transient (network failures and provider hiccups usually have
 * none), preserving the historical retry-everything behavior for them.
 */
export function isTransientLlmError(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const candidate = error as { status?: unknown; statusCode?: unknown; message?: unknown };
  const status =
    typeof candidate.status === "number"
      ? candidate.status
      : typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : undefined;
  if (status !== undefined) {
    return status === 429 || status >= 500;
  }
  // Some providers throw plain Errors with the status embedded in the
  // message, e.g. "LLM request failed (404): ...".
  if (typeof candidate.message === "string") {
    const embedded = candidate.message.match(/\((\d{3})\)/);
    if (embedded) {
      const code = Number(embedded[1]);
      return code === 429 || code >= 500;
    }
  }
  return true;
}

interface GateWaiter {
  grant: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * FIFO semaphore bounding how many LLM calls run at once. A call holds
 * its slot for its whole local retry sequence (including backoff),
 * which also damps retry stampedes. Waiters are queued FIFO; a waiter
 * whose signal aborts leaves the queue and rejects immediately instead
 * of starting a call nobody is waiting for anymore.
 *
 * Phase 4 hardening: TWO gates guard every LLM request, always acquired
 * in the same order (see runWithLlmGates):
 *  1. a PER-TASK gate, created fresh by the runner for each task run
 *     and sized by that task's policy.maxConcurrentLLMCalls — one task's
 *     limit can never widen or narrow another task's; and
 *  2. a WORKER-WIDE gate, sized once from the worker's own
 *     configuration at process start — it is NEVER resized per task.
 * Phase 4's single shared gate failed the first property: the runner
 * re-pointed it at each new task's policy, so the last task to start
 * silently rewrote the bound for every task already running.
 */
export class LlmConcurrencyGate {
  private active = 0;
  private readonly waiters: GateWaiter[] = [];
  private limit: number;

  constructor(limit: number) {
    this.limit = LlmConcurrencyGate.clampLimit(limit);
  }

  private static clampLimit(limit: number): number {
    if (!Number.isFinite(limit)) return 1;
    return Math.min(8, Math.max(1, Math.floor(limit)));
  }

  getLimit(): number {
    return this.limit;
  }

  getActiveCount(): number {
    return this.active;
  }

  getQueuedCount(): number {
    return this.waiters.length;
  }

  /**
   * Resize the gate. Reserved for the worker bootstrap configuring the
   * WORKER-WIDE gate once at process start — per-task gates are created
   * with their final limit and never resized.
   */
  setLimit(limit: number): void {
    this.limit = LlmConcurrencyGate.clampLimit(limit);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      this.active += 1;
      waiter.grant();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new Error("LLM request aborted by caller"));
    }
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: GateWaiter = { grant: resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("LLM request aborted by caller"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.pump();
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * The WORKER-WIDE gate: one per worker process, bounding the total LLM
 * pressure across ALL tasks this worker runs concurrently. Its limit
 * comes from the worker's own configuration — the
 * WORKER_LLM_MAX_CONCURRENCY env var, falling back to the policy env —
 * and from the single bootstrap call in the worker entrypoint. It is
 * deliberately NOT derived from any one task's policy at task start:
 * tasks come and go, the worker bound stays.
 */
function workerGateLimitFromEnv(): number {
  // Falls back to ORCHESTRATOR_MAX_CONCURRENT_LLM_CALLS, then 1 (schema).
  return wenv("WORKER_LLM_MAX_CONCURRENCY");
}

const workerLlmGate = new LlmConcurrencyGate(workerGateLimitFromEnv());

/**
 * Bootstrap-only: size the worker-wide gate from the worker's loaded
 * policy. Called ONCE by the worker entrypoint (index.ts) at process
 * start. The task runner must never call this — a task's own limit
 * lives on its per-task gate instead.
 */
export function setWorkerLlmConcurrencyLimit(limit: number): void {
  workerLlmGate.setLimit(limit);
}

export interface LlmGateOptions {
  signal?: AbortSignal;
  /**
   * Per-task gate (Phase 4 hardening): owned by one task run, sized by
   * that task's policy.maxConcurrentLLMCalls. When present, a request
   * must hold a slot on it AND on the worker-wide gate.
   */
  taskGate?: LlmConcurrencyGate;
  /** Worker-wide gate override (tests inject their own); defaults to the shared worker gate. */
  gate?: LlmConcurrencyGate;
}

/**
 * Run `fn` while holding an LLM slot on the per-task gate (when given)
 * AND on the worker-wide gate. Acquisition order is fixed — per-task
 * first, worker-wide second — for every caller, so two tasks can never
 * each hold one gate and wait on the other (no circular wait, hence no
 * deadlock). An abort while queued on either gate drops the waiter from
 * that queue and releases any slot already held (each gate's `run`
 * releases in a finally); an abort never leaves a slot behind.
 */
export async function runWithLlmGates<T>(
  fn: () => Promise<T>,
  options: LlmGateOptions = {}
): Promise<T> {
  const workerGate = options.gate ?? workerLlmGate;
  const taskGate = options.taskGate;
  if (taskGate && taskGate !== workerGate) {
    return await taskGate.run(
      () => workerGate.run(fn, options.signal),
      options.signal
    );
  }
  return await workerGate.run(fn, options.signal);
}

/**
 * Effect-based LLM call with retry + timeout.
 * Retry up to `retries` times with exponential backoff (500ms → 1s → 2s),
 * but only for transient failures (see isTransientLlmError); permanent 4xx
 * errors fail immediately. Total timeout 300s per attempt.
 */
export function llmCallEffect(
  provider: LLMProvider,
  messages: LLMMessage[],
  model?: string,
  options: { retries?: number; timeoutMs?: number; signal?: AbortSignal } = {}
) {
  const retries = options.retries ?? 2;
  // Bounded by the configured ceiling (ORCHESTRATOR_LLM_TIMEOUT_MS) and,
  // when the caller passes one, by the subtask's remaining time.
  const timeoutMs = effectiveLlmTimeoutMs(options.timeoutMs);

  // The provider gets the same bound so the HTTP request itself is
  // aborted (not just abandoned by Effect.timeout).
  const callPromise = () =>
    provider.complete(messages, model, { signal: options.signal, timeoutMs }).then((res) => res as LLMResult);

  return Effect.tryPromise({
    try: callPromise,
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  }).pipe(
    Effect.timeout(`${timeoutMs} millis`),
    Effect.retry({
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.upTo({ times: retries })
      ),
      // An aborted call is never retried: the abort error carries no
      // HTTP status, so the transient classifier alone would happily
      // replay a call the task has already cancelled (Phase 4).
      while: (error) => !options.signal?.aborted && isTransientLlmError(error),
    })
  );
}

/**
 * Run the Effect and return a Promise (drop-in replacement for
 * provider.complete). Every call passes through BOTH LLM gates (Phase 4
 * hardening): the per-task gate (options.taskGate, sized by the owning
 * task's policy) and the worker-wide gate (options.gate overrides it,
 * which is also how tests isolate themselves).
 */
export function runLlmCall(
  provider: LLMProvider,
  messages: LLMMessage[],
  model?: string,
  options?: {
    retries?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    gate?: LlmConcurrencyGate;
    taskGate?: LlmConcurrencyGate;
  }
): Promise<LLMResult> {
  return runWithLlmGates(
    () => Effect.runPromise(llmCallEffect(provider, messages, model, options)),
    { signal: options?.signal, gate: options?.gate, taskGate: options?.taskGate }
  );
}

/** One stop in an agent's provider chain (structurally = resolver's ResolvedProviderHandle). */
export interface FallbackHandle {
  connectionId: string;
  connectionName: string;
  config: GlobalLLMConfig;
  provider: LLMProvider;
  /** llmModels registry row id of the model this handle serves (Phase 5 usage attribution). */
  modelRowId?: string;
  /** Registry pricing for the served model, when the operator filled it in. */
  inputPricePer1k?: number;
  outputPricePer1k?: number;
}

/**
 * Estimated cost of one call from registry pricing. Returns undefined
 * unless BOTH sides are priced: a half-known price would understate the
 * cost, and an invented number is worse than an absent one (PLAN Phase 5).
 */
export function estimateUsageCost(
  handle: Pick<FallbackHandle, "inputPricePer1k" | "outputPricePer1k">,
  inputTokens: number,
  outputTokens: number
): number | undefined {
  if (handle.inputPricePer1k === undefined || handle.outputPricePer1k === undefined) {
    return undefined;
  }
  return (
    (Math.max(0, inputTokens) / 1000) * handle.inputPricePer1k +
    (Math.max(0, outputTokens) / 1000) * handle.outputPricePer1k
  );
}

/** Wire kind of a handle's connection for the usage ledger (plan 040 P3). */
export function providerKindOf(provider: string | undefined): string | undefined {
  if (!provider) return undefined;
  return provider === "anthropic" ? "anthropic" : provider === "openai" ? "openai-compatible" : provider;
}

/**
 * The TokenUsageMeta for a call served by `handle`. Pass the LLMResult to
 * carry the plan 040 P3 ledger fields (cache / reasoning breakdown,
 * duration, provider kind); the call role comes from the snapshot scope
 * the runner set around the call. The (input, output, estimated) form is
 * kept for callers without a result.
 */
export function usageMetaFor(handle: FallbackHandle, result: LLMResult, callRole?: CallRole): TokenUsageMeta;
export function usageMetaFor(
  handle: FallbackHandle,
  inputTokens: number,
  outputTokens: number,
  estimated?: boolean
): TokenUsageMeta;
export function usageMetaFor(
  handle: FallbackHandle,
  resultOrInput: LLMResult | number,
  outputTokensOrRole?: number | CallRole,
  estimatedArg?: boolean
): TokenUsageMeta {
  const outputTokensArg = typeof outputTokensOrRole === "number" ? outputTokensOrRole : undefined;
  // An explicit role wins: planner / decision calls build their meta AFTER
  // the withSnapshotScope callback returned, where the scope is gone and
  // the ledger row lost its callRole (live test 4).
  const explicitRole = typeof outputTokensOrRole === "string" ? outputTokensOrRole : undefined;
  const result: LLMResult | undefined = typeof resultOrInput === "number" ? undefined : resultOrInput;
  const inputTokens = typeof resultOrInput === "number" ? resultOrInput : resultOrInput.inputTokens ?? 0;
  const outputTokens = typeof resultOrInput === "number" ? outputTokensArg ?? 0 : resultOrInput.outputTokens ?? 0;
  const estimated = typeof resultOrInput === "number" ? estimatedArg : resultOrInput.usageEstimated;
  const callRole = explicitRole ?? currentSnapshotScope().callRole;
  const providerKind = providerKindOf(handle.config?.provider);
  return {
    providerId: handle.connectionId ? handle.connectionId : undefined,
    modelRowId: handle.modelRowId,
    estimatedCost: estimateUsageCost(handle, inputTokens, outputTokens),
    ...(estimated ? { estimated: true } : {}),
    ...(result?.cachedInputTokens !== undefined ? { cachedInputTokens: result.cachedInputTokens } : {}),
    ...(result?.cacheWriteTokens !== undefined ? { cacheWriteTokens: result.cacheWriteTokens } : {}),
    ...(result?.reasoningTokens !== undefined ? { reasoningTokens: result.reasoningTokens } : {}),
    ...(result?.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    ...(providerKind ? { providerKind } : {}),
    ...(callRole ? { callRole } : {}),
  };
}

/**
 * Ledger meta for an OpenCode (native provider) run (plan 040 P3). The
 * cost is OpenCode's own per-step `cost` sum (USD); a zero is left out
 * because OpenCode also reports zero when its catalog has no price for
 * the model, so it cannot be told apart from "free".
 */
export function nativeUsageMeta(run: {
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  durationMs?: number;
}): TokenUsageMeta {
  const callRole = currentSnapshotScope().callRole;
  return {
    providerKind: "opencode",
    ...(run.costUsd !== undefined && run.costUsd > 0 ? { estimatedCost: run.costUsd } : {}),
    ...(run.cachedInputTokens !== undefined ? { cachedInputTokens: run.cachedInputTokens } : {}),
    ...(run.cacheWriteTokens !== undefined ? { cacheWriteTokens: run.cacheWriteTokens } : {}),
    ...(run.reasoningTokens !== undefined ? { reasoningTokens: run.reasoningTokens } : {}),
    ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
    ...(callRole ? { callRole } : {}),
  };
}

/** Rough token estimate (chars/4) for providers that report no usage. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Fill in missing usage. OpenAI-compatible servers (and some streaming
 * paths) may omit `usage`; every such call used to record NO tokenUsage
 * row at all (cost "—"). Missing counts become a chars/4 estimate of the
 * prompt and completion, flagged `usageEstimated`. Reported counts are
 * kept as-is. Exported for tests.
 */
export function withUsageEstimate(messages: LLMMessage[], result: LLMResult): LLMResult {
  const missingIn = typeof result.inputTokens !== "number";
  const missingOut = typeof result.outputTokens !== "number";
  if (!missingIn && !missingOut) return result;
  return {
    ...result,
    inputTokens: missingIn
      ? estimateTokens(messages.map((message) => message.content).join("\n"))
      : result.inputTokens,
    outputTokens: missingOut ? (result.content ? estimateTokens(result.content) : 0) : result.outputTokens,
    usageEstimated: true,
  };
}

/**
 * Call an LLM through an ordered provider chain with in-task fallback
 * (spec §4D): each handle gets the normal local retry policy first; when a
 * handle fails TRANSIENTLY and its local retries are exhausted, the next
 * handle in the chain serves the SAME call within the same task. Permanent
 * errors (4xx) never trigger fallback — retrying the same payload against
 * another provider would fail the same way and hide the real problem.
 *
 * Every outcome is recorded into the health registry: successes close the
 * circuit, transient failures count toward opening it.
 */
export async function runLlmCallWithFallback(
  handles: FallbackHandle[],
  messages: LLMMessage[],
  options: {
    health?: ProviderHealthRegistry;
    retries?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Per-task LLM gate (Phase 4 hardening), forwarded to every attempt. */
    taskGate?: LlmConcurrencyGate;
    /** Worker-wide gate override (tests); defaults to the shared worker gate. */
    gate?: LlmConcurrencyGate;
  } = {}
): Promise<{ result: LLMResult; servedBy: FallbackHandle }> {
  if (handles.length === 0) {
    throw new Error("No LLM provider handles available for this call");
  }
  let lastError: unknown;
  const startedAt = Date.now();
  // Context Snapshot: one record per call (success or final failure).
  const fail = (error: unknown, handle: FallbackHandle) =>
    recordLlmSnapshot({
      messages,
      error,
      model: handle.config.model,
      provider: handle.config.provider,
      durationMs: Date.now() - startedAt,
    });
  for (const [index, handle] of handles.entries()) {
    // Per-handle wall time for the usage ledger (plan 040 P3): the
    // serving model's latency, not the failed handles before it.
    const attemptStartedAt = Date.now();
    try {
      markProgress();
      const result = await runLlmCall(handle.provider, messages, handle.config.model, {
        retries: options.retries,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        taskGate: options.taskGate,
        gate: options.gate,
      });
      options.health?.recordSuccess(handle.connectionId);
      // A 2xx answer with nothing in it (no text, no tool call) moves on to
      // the next model in the chain, like an error (lib/llmRotation.ts).
      // The connection stays healthy: it answered, just emptily.
      if (isEmptyCompletion(result) && index < handles.length - 1) {
        lastError = new Error(`${handle.connectionName} returned an empty response (model "${handle.config.model}")`);
        continue;
      }
      const estimated = { ...withUsageEstimate(messages, result), durationMs: Date.now() - attemptStartedAt };
      recordLlmSnapshot({
        messages,
        result: estimated,
        model: handle.config.model,
        provider: handle.config.provider,
        durationMs: Date.now() - startedAt,
      });
      markProgress();
      return { result: estimated, servedBy: handle };
    } catch (error) {
      lastError = error;
      // A caller abort (task cancel / deadline) is not a provider
      // failure: never fall back to the next handle and never count it
      // against the provider's health (Phase 4).
      if (options.signal?.aborted) {
        fail(error, handle);
        throw error;
      }
      if (!isTransientLlmError(error)) {
        fail(error, handle);
        throw error;
      }
      if (handle === handles[handles.length - 1]) fail(error, handle);
      options.health?.recordFailure(handle.connectionId, { transient: true, error });
      // Provider unavailable (connection / 5xx / 429): switch to the next
      // provider in the chain when one is configured, else fail clearly.
      const failureClass = classifyProviderError(error);
      const next = handles[index + 1];
      if (failureClass) {
        emitObservation({
          kind: "provider_unavailable",
          action: next ? "fallback" : "fail",
          reason: next
            ? `Provider ${handle.connectionName} unavailable (${failureClass}); switching to ${next.connectionName}`
            : `Provider ${handle.connectionName} unavailable (${failureClass}); ${
                handles.length > 1 ? "every provider in the fallback chain failed" : "no fallback provider configured"
              }`,
          detail: {
            class: failureClass,
            provider: handle.connectionName,
            model: handle.config.model,
            ...(next ? { fallbackTo: next.connectionName } : {}),
          },
        });
      }
      if (!next && failureClass && error instanceof Error) {
        // Keep the original message (its "(NNN)" status keeps the retry
        // classification) and say why no other provider took over.
        error.message = `${error.message} — provider unavailable (${failureClass}): ${
          handles.length > 1
            ? `all ${handles.length} providers in the fallback chain failed`
            : "no fallback provider configured"
        }`;
      }
      // Transient and retries exhausted on this handle: fall through to
      // the next candidate in the chain (same task, same call).
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`All ${handles.length} LLM providers in the fallback chain failed`);
}
