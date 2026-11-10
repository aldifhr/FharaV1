/**
 * Global LLM selection mode.
 *
 * One choice for the whole app: how a call picks the provider it starts on.
 *
 *  - "fallback": use one provider at a time (the pool's own order: priority,
 *    then weight among equals) and, when it fails, fail over to the next
 *    candidate. The provider is picked once per call, not rotated.
 *  - "round_robin": rotate the starting provider per resolution. The
 *    failover chain stays armed, so a rotated-to provider that fails still
 *    lands on the next candidate.
 *
 * Both modes keep the failover chain; the mode only decides whether the
 * starting provider rotates.
 *
 * Pure module (no Convex import): the backend, the worker and the web app
 * share it. The Convex validator lives in lib/contractValidators.ts.
 */

/** The two modes the user can pick. */
export const LLM_SELECTION_MODES = ["fallback", "round_robin"] as const;
export type LlmSelectionMode = (typeof LLM_SELECTION_MODES)[number];

/** What a mode means when nothing else is configured. */
export const DEFAULT_LLM_SELECTION_MODE: LlmSelectionMode = "fallback";

/**
 * The resolver's per-agent policy that implements a global mode.
 *
 * "round_robin" maps to the rotating policy. "fallback" maps to no explicit
 * policy at all — the resolver's own pick (priority, then weight among
 * equals) with the failover chain, which is what it has always done.
 */
export function policyForMode(
  mode: LlmSelectionMode | undefined | null
): "round_robin" | undefined {
  return mode === "round_robin" ? "round_robin" : undefined;
}

/** Narrow an untrusted value to a mode (defaults to the default mode). */
export function normalizeSelectionMode(value: unknown): LlmSelectionMode {
  return value === "round_robin" ? "round_robin" : DEFAULT_LLM_SELECTION_MODE;
}
