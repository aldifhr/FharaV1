/**
 * Observed LLM call latency (worker-wide, in memory).
 *
 * A slow provider (nous: 5-8 min per planning call in live tests 3/4)
 * cannot finish a medium subtask inside a fixed 300 s timeout. Every
 * successful call records its wall time here; the subtask timeout is then
 * `base + k × observed latency` (see policy.subtaskTimeoutFor), so a slow
 * model gets room without raising the bound for fast ones.
 */

const WINDOW = 20;
const samples: number[] = [];

/** Record one successful LLM call's wall time (ms). Ignores junk values. */
export function recordLlmLatency(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  samples.push(Math.min(durationMs, 60 * 60_000));
  if (samples.length > WINDOW) samples.splice(0, samples.length - WINDOW);
}

/**
 * The per-call latency to budget for: the 90th percentile of the recent
 * window (one slow outlier counts, a single very old one ages out).
 * 0 when nothing has been observed yet.
 */
export function observedLlmLatencyMs(): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
}

/** Test seam. */
export function resetLlmLatency(): void {
  samples.length = 0;
}
