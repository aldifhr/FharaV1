/**
 * Round-robin rotation for provider selection.
 *
 * The resolver picks the connection a call starts on. "Round robin" means
 * that starting point rotates instead of being always the top-priority
 * connection. It changes only the *first* attempt: the failover chain
 * (effects/llmCall.ts) stays armed, so a rotated-to connection that fails
 * still lands on the next candidate.
 *
 * The cursor is process-local, like the provider-health registry
 * (llm/health.ts): it is a load-spreading hint, never correctness state.
 * Losing it on a worker restart changes the distribution, not the outcome of
 * a call.
 */

import { wenv } from "@fhara/config/worker";
import { StickyRotationCursor } from "@/api/convex/lib/llmRotation";

/** A rotation cursor: hands out the next index of a candidate list. */
export interface RotationCursor {
  /**
   * The index to use for the next selection among `size` candidates.
   * Implementations advance their state.
   */
  next(size: number): number;
}

/**
 * In-memory rotation cursor: one counter per scope, modulo the candidate
 * count. A single global scope is used on purpose — a per-agent cursor would
 * start every agent on the same connection and spread no load at all.
 */
export class InMemoryRotationCursor implements RotationCursor {
  private readonly counters = new Map<string, number>();

  constructor(private readonly scope: string = "global") {}

  next(size: number): number {
    if (size <= 0) return 0;
    const current = this.counters.get(this.scope) ?? 0;
    this.counters.set(this.scope, current + 1);
    return current % size;
  }

  /** The index the next call would use, without advancing the cursor. */
  peek(size: number): number {
    if (size <= 0) return 0;
    return (this.counters.get(this.scope) ?? 0) % size;
  }

  reset(): void {
    this.counters.clear();
  }
}

/**
 * The worker's process-wide rotation cursor: sticky round robin
 * (lib/llmRotation.ts, adapted from 9router). Each start is handed out
 * LLM_ROUND_ROBIN_STICKY_LIMIT times in a row (default 1 = rotate every
 * call); a higher limit keeps a provider's prompt cache warm longer.
 */
export const rotationCursor: RotationCursor = new StickyRotationCursor(
  wenv("LLM_ROUND_ROBIN_STICKY_LIMIT")
);

/**
 * A cursor that always returns the first candidate and never advances —
 * used where a deterministic answer is required (the Task Estimator must
 * not consume a rotation).
 */
export const fixedRotationCursor: RotationCursor = { next: () => 0 };
