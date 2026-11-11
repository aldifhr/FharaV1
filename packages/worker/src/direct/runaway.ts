// Runaway detection for direct threads (Nuphos N6, idea #13).
//
// Pattern from Nuphos (https://github.com/nuphos/nuphos),
// apps/backend/src/lib/agent/stop-gate-runaway.ts @ a210a05. Copyright 2026
// Zeabur Inc. Licensed under the Apache License, Version 2.0
// (http://www.apache.org/licenses/LICENSE-2.0). See THIRD_PARTY_NOTICES.md.
//
// Modified by Fhara, 2026-11: the threshold, the canonical input key (the
// top-level `label` stripped, keys sorted deep) are kept; the model wrap-up
// text is not used; the backwards scan over AI-SDK step messages becomes a streaming
// detector fed by Fhara's own tool.call / tool.result events (ACP session)
// or by each model call (api-loop), and it fires once per streak.

/**
 * Consecutive same-signature failures of one call before the detector
 * fires. Retrying with CHANGED input is healthy exploration and never
 * counts; only literal repetition of a failing call does.
 */
export const RUNAWAY_FAILURE_THRESHOLD = 3;

export type RunawayDetection = { toolName: string; count: number };

/**
 * Canonical signature for a tool input: the top-level `label` field is
 * stripped (per-call presentation metadata, worded differently each time),
 * and object keys are sorted deep so key order can't split a streak.
 */
export function canonicalToolInputKey(input: unknown): string {
  try {
    return JSON.stringify(sortKeysDeep(stripTopLevelLabel(input))) ?? "";
  } catch {
    return String(input);
  }
}

function stripTopLevelLabel(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const { label: _label, ...rest } = input as Record<string, unknown>;
  return rest;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

type Signature = { toolName: string; inputKey: string };

/**
 * Streaming twin of the Nuphos scan: `call` records each call's signature,
 * `result` extends or breaks the trailing failure streak. A success, a
 * different call or a changed input resets it. Returns the detection once,
 * on the result that reaches the threshold.
 */
export class RunawayDetector {
  private readonly calls = new Map<string, Signature>();
  private streak: (Signature & { count: number }) | null = null;

  constructor(private readonly threshold = RUNAWAY_FAILURE_THRESHOLD) {}

  call(id: string, toolName: string, input: unknown): void {
    this.calls.set(id, { toolName: toolName || "unknown", inputKey: canonicalToolInputKey(input) });
    // Bounded: a long thread never holds more than the recent calls.
    if (this.calls.size > 500) this.calls.delete(this.calls.keys().next().value as string);
  }

  result(id: string, ok: boolean): RunawayDetection | null {
    const sig = this.calls.get(id);
    // An unknown call can't extend a streak; skip it rather than break one.
    if (!sig) return null;
    this.calls.delete(id);
    if (ok) {
      this.streak = null;
      return null;
    }
    if (this.streak && this.streak.toolName === sig.toolName && this.streak.inputKey === sig.inputKey) this.streak.count++;
    else this.streak = { ...sig, count: 1 };
    return this.streak.count === this.threshold ? { toolName: this.streak.toolName, count: this.streak.count } : null;
  }

  /** A real user message: failures before it are stale (the user may have fixed the cause). */
  reset(): void {
    this.streak = null;
    this.calls.clear();
  }
}

/** The system note shown in the thread; `stopped` when Fhara stops retrying it. */
export function runawayNoteText(d: RunawayDetection, stopped = false): string {
  const what = d.toolName === "model" ? "The same message" : `The same ${d.toolName} call`;
  const next = stopped
    ? "It won't be sent again unchanged: edit it, or change the model or settings, to try again."
    : "Consider stopping the turn and telling the agent what to change.";
  return `${what} failed ${d.count} times in a row with identical input. ${next}`;
}
