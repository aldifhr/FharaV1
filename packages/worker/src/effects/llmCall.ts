import { Effect, Schedule } from "effect";
import type { GlobalLLMConfig, LLMMessage, LLMProvider, LLMResult } from "@/llm";
import type { ProviderHealthRegistry } from "@/llm/health";

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
 * Process-wide semaphore bounding how many LLM calls run at once
 * (Phase 4, spec §6): sized by policy.maxConcurrentLLMCalls and applied
 * around runLlmCall, so planner, executor and reviewer calls share one
 * bound instead of each path pressuring the provider independently. A
 * call holds its slot for its whole local retry sequence (including
 * backoff), which also damps retry stampedes. Waiters are queued FIFO;
 * a waiter whose signal aborts leaves the queue and rejects immediately
 * instead of starting a call nobody is waiting for anymore.
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

  /** Resize the gate (the limit is process-level policy; the runner sets it per task). */
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

/** Shared process gate; the default size matches the policy default (2). */
const sharedLlmGate = new LlmConcurrencyGate(2);

/** Point the shared gate at the loaded policy's limit (the runner calls this per task). */
export function setLlmConcurrencyLimit(limit: number): void {
  sharedLlmGate.setLimit(limit);
}

export function getSharedLlmGate(): LlmConcurrencyGate {
  return sharedLlmGate;
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
  const timeoutMs = options.timeoutMs ?? 300_000;

  const callPromise = () =>
    provider.complete(messages, model, { signal: options.signal }).then((res) => res as LLMResult);

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
 * provider.complete). Every call passes through the LLM concurrency
 * gate (policy.maxConcurrentLLMCalls; a per-call gate can be injected
 * via options.gate, which is also how tests isolate themselves).
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
  }
): Promise<LLMResult> {
  const gate = options?.gate ?? sharedLlmGate;
  return gate.run(
    () => Effect.runPromise(llmCallEffect(provider, messages, model, options)),
    options?.signal
  );
}

/** One stop in an agent's provider chain (structurally = resolver's ResolvedProviderHandle). */
export interface FallbackHandle {
  connectionId: string;
  connectionName: string;
  config: GlobalLLMConfig;
  provider: LLMProvider;
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
  } = {}
): Promise<{ result: LLMResult; servedBy: FallbackHandle }> {
  if (handles.length === 0) {
    throw new Error("No LLM provider handles available for this call");
  }
  let lastError: unknown;
  for (const handle of handles) {
    try {
      const result = await runLlmCall(handle.provider, messages, handle.config.model, {
        retries: options.retries,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
      options.health?.recordSuccess(handle.connectionId);
      return { result, servedBy: handle };
    } catch (error) {
      lastError = error;
      // A caller abort (task cancel / deadline) is not a provider
      // failure: never fall back to the next handle and never count it
      // against the provider's health (Phase 4).
      if (options.signal?.aborted) throw error;
      if (!isTransientLlmError(error)) throw error;
      options.health?.recordFailure(handle.connectionId, { transient: true });
      // Transient and retries exhausted on this handle: fall through to
      // the next candidate in the chain (same task, same call).
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`All ${handles.length} LLM providers in the fallback chain failed`);
}
