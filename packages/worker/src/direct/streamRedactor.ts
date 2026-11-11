/**
 * L2 for direct threads: nothing an agent streams or reports reaches Convex
 * (threadStreams hot rows, taskEvents) with a secret in it.
 *
 * - Deltas go through one chunk-safe `StreamRedactor` per item, so a key
 *   split across two or three chunks (`sk-pro` | `j-ABC…` | `…XYZ`) is held
 *   until it is whole and then masked; it never appears in a flushed row.
 *   Held text is released (masked) when the item's final event arrives or
 *   the turn ends, so plain text is never delayed past the turn.
 * - Persisted events (assistant.text, reasoning, tool.call, tool.result,
 *   edit.diff, system.note, turn.completed errors) are masked whole.
 *
 * The hold-back-across-chunks idea follows Nuphos
 * `apps/backend/src/lib/claude-code-preview/streamed-token-redaction.ts`
 * (pattern only, no code copied); the redaction itself is Fhara's L2
 * (`utils/redact.ts`, `utils/redactStream.ts`, `apps/api/convex/lib/secretPatterns.ts`).
 */
import { redactDeep, redactText } from "../utils/redact";
import { StreamRedactor } from "../utils/redactStream";

export class DirectStreamRedactor {
  private items = new Map<string, StreamRedactor>();

  /** A delta's text that is safe to show now (masked; a possible secret prefix is held). */
  push(itemId: string, text: string): string {
    let r = this.items.get(itemId);
    if (!r) {
      r = new StreamRedactor();
      this.items.set(itemId, r);
    }
    return r.push(text);
  }

  /** The item is final (its event arrived): forget what it held; the event carries the whole text. */
  drop(itemId: string): void {
    this.items.delete(itemId);
  }

  /** End of turn: release what every item held, masked. */
  endAll(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [itemId, r] of this.items) {
      const rest = r.end();
      if (rest) out.set(itemId, rest);
    }
    this.items.clear();
    return out;
  }

  /** Characters held back for an item (tests). */
  held(itemId: string): number {
    return this.items.get(itemId)?.held ?? 0;
  }
}

/** Mask every string of a persisted event's payload. */
export function redactPayload<T extends Record<string, unknown>>(payload: T): T {
  return redactDeep(payload);
}

/** Mask a turn's error text before it is stored. */
export function redactErrorText(text: string): string {
  return redactText(text);
}
