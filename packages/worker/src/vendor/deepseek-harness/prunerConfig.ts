// Adapted from DeepSeek Harness (https://github.com/deepseek-ai/deepseek-harness, MIT, Copyright (c) 2026 DeepSeek),
// commit e8f7b93a, packages/compaction/compaction-tool-result-pruner/src/config.ts.
// Modified by Fhara: `deepFreeze` from its util package inlined as Object.freeze (the config is flat); the
// `ToolResultPruneConfig` / `ResolvedConfig` types from ./types.ts inlined; the marker reads "middle pruned"
// for any message, not only a tool result; Prettier style. See THIRD_PARTY_NOTICES.md ("DeepSeek Harness").

/** Configuration resolution for deterministic head/middle/tail pruning. */

/** Raw pruning budgets (characters, counted as Unicode code points). */
export interface ToolResultPruneConfig {
  thresholdChars?: number;
  headChars?: number;
  tailChars?: number;
}

export interface ResolvedConfig {
  readonly thresholdChars: number;
  readonly headChars: number;
  readonly tailChars: number;
}

/** Fixed marker substituted for every removed middle span. */
export const PRUNE_MARKER = "\n\n[... middle pruned ...]\n\n";

/** Low-friction defaults for coding-agent tool output. */
export const DEFAULTS: ResolvedConfig = Object.freeze({
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
});

const CONFIG_KEYS: ReadonlySet<string> = new Set(["thresholdChars", "headChars", "tailChars"]);

/** Count Unicode code points without splitting surrogate pairs. */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** Resolve and validate pruning budgets; returns a detached frozen configuration. */
export function resolveConfig(config: ToolResultPruneConfig = {}): ResolvedConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`ToolResultPruneConfig: unknown key "${key}" (allowed: thresholdChars, headChars, tailChars)`);
    }
  }

  const resolved: ResolvedConfig = {
    thresholdChars: config.thresholdChars ?? DEFAULTS.thresholdChars,
    headChars: config.headChars ?? DEFAULTS.headChars,
    tailChars: config.tailChars ?? DEFAULTS.tailChars,
  };
  assertPositiveInteger("thresholdChars", resolved.thresholdChars);
  assertNonNegativeInteger("headChars", resolved.headChars);
  assertNonNegativeInteger("tailChars", resolved.tailChars);

  const emittedChars = resolved.headChars + codePointLength(PRUNE_MARKER) + resolved.tailChars;
  if (emittedChars > resolved.thresholdChars) {
    throw new Error(
      `ToolResultPruneConfig: headChars + marker + tailChars (${emittedChars}) must be at most thresholdChars (${resolved.thresholdChars})`
    );
  }
  return Object.freeze({ ...resolved });
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a positive integer`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a non-negative integer`);
  }
}
