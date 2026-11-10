/**
 * Activity timeline heading (pure; unit-tested in tests/unit/activityHeading.test.mjs).
 *
 * A finished reply with only reasoning (no tool steps, no Checked/unverified
 * lines) is titled "Reasoning"; its reasoning row then must not repeat the
 * "Reasoning" label (it rendered twice).
 */
export type ActivityPhase = "thinking" | "working" | "composing" | "done";
export type ActivityTitleKind = "thinking" | "working" | "tools" | "worked" | "reasoning";

export function activityTitleKind(phase: ActivityPhase, stepCount: number, extrasCount: number): ActivityTitleKind {
  if (phase === "thinking") return "thinking";
  if (phase === "working" || phase === "composing") return "working";
  if (stepCount > 0) return "tools";
  if (extrasCount > 0) return "worked";
  return "reasoning";
}

/** The reasoning row gets its own "Reasoning" toggle only when the heading is not already "Reasoning". */
export function reasoningRowHasLabel(title: ActivityTitleKind): boolean {
  return title !== "reasoning";
}
