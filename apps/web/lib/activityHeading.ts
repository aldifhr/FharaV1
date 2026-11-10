/**
 * Activity timeline heading (pure; unit-tested in tests/unit/activityHeading.test.mjs).
 *
 * A finished reply with only reasoning (no tool steps, no Checked/unverified
 * lines) is titled "Reasoning"; its reasoning row then must not repeat the
 * "Reasoning" label (it rendered twice).
 */
export type ActivityPhase = "thinking" | "working" | "composing" | "done";
export type ActivityTitleKind = "thinking" | "working" | "tools" | "handoff" | "worked" | "reasoning";

/** A CTO handoff ("Asking Frontend for help") is recorded as a step but is not a tool call. */
export function isHandoffStep(step: { tool: string }): boolean {
  return step.tool === "handoff";
}

/**
 * `stepCount` counts tool calls only (handoff steps excluded); `handoffCount`
 * the handoff steps. A finished reply whose only steps are handoffs is titled
 * by the handoff itself, with no "N tools used" and no "Writing the answer".
 */
export function activityTitleKind(phase: ActivityPhase, stepCount: number, extrasCount: number, handoffCount = 0): ActivityTitleKind {
  if (phase === "thinking") return "thinking";
  if (phase === "working" || phase === "composing") return "working";
  if (stepCount > 0) return "tools";
  if (handoffCount > 0) return "handoff";
  if (extrasCount > 0) return "worked";
  return "reasoning";
}

/** The reasoning row gets its own "Reasoning" toggle only when the heading is not already "Reasoning". */
export function reasoningRowHasLabel(title: ActivityTitleKind): boolean {
  return title !== "reasoning";
}
