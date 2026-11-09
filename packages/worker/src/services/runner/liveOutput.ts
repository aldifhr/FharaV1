import { stripToolCallMarkup } from "@/utils/toolCallMarkup";

/**
 * Live output tail for a running subtask.
 *
 * Streamed model text (API runtime deltas, OpenCode text parts) is
 * appended here and flushed to the backend in coalesced writes: at most
 * one write per `flushMs`, or sooner once `flushChars` of new text piled
 * up. Only the last `tailChars` are kept, so a long answer never grows the
 * stored row (the idea of t3code's ThreadLiveEventCoalescer + the tail cap
 * of its LiveStreamBudget, MIT, Copyright (c) 2026 T3 Tools Inc. — no code
 * copied). Writes are serialized on one promise chain and never throw:
 * live output is cosmetic and must not fail the run. `close()` cancels any
 * pending flush and clears the stored tail after every earlier write
 * landed, so the UI never shows a stale tail for a finished subtask.
 */

export interface LiveOutputSink {
  /** Store the current tail (already stripped and capped). */
  write(text: string): Promise<unknown>;
  /** Remove the stored tail (subtask settled). */
  clear(): Promise<unknown>;
}

export interface LiveOutputOptions {
  flushMs?: number;
  flushChars?: number;
  tailChars?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const LIVE_OUTPUT_FLUSH_MS = 400;
export const LIVE_OUTPUT_FLUSH_CHARS = 2048;
export const LIVE_OUTPUT_TAIL_CHARS = 8192;

const TOOL_CLOSE = /<\/[A-Za-z0-9_-]*tool_call>/gi;
const PARTIAL_TAG_AT_END = /<\/?[A-Za-z0-9_-]*$/;

/**
 * Display text for a raw tail: tool-call markup removed, including a
 * block whose opening tag was cut off by the tail cap and a tag still
 * being streamed at the very end.
 */
export function liveDisplayText(raw: string): string {
  let text = raw;
  // A closing tag with no opening before it: the block started before
  // the tail window, so everything up to the close is markup.
  const closes = [...text.matchAll(TOOL_CLOSE)];
  if (closes.length > 0) {
    const firstClose = closes[0];
    const before = text.slice(0, firstClose.index);
    if (!/<[A-Za-z0-9_-]*tool_call\b/i.test(before)) {
      text = text.slice((firstClose.index ?? 0) + firstClose[0].length);
    }
  }
  text = stripToolCallMarkup(text);
  text = text.replace(PARTIAL_TAG_AT_END, "");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export class LiveOutputCoalescer {
  private raw = "";
  private pendingChars = 0;
  private dirty = false;
  private closed = false;
  private lastWritten = "";
  private timer: unknown = undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly flushMs: number;
  private readonly flushChars: number;
  private readonly tailChars: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly sink: LiveOutputSink, options: LiveOutputOptions = {}) {
    this.flushMs = options.flushMs ?? LIVE_OUTPUT_FLUSH_MS;
    this.flushChars = options.flushChars ?? LIVE_OUTPUT_FLUSH_CHARS;
    this.tailChars = options.tailChars ?? LIVE_OUTPUT_TAIL_CHARS;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Append streamed text. Never blocks the caller. */
  push(delta: string): void {
    if (this.closed || !delta) return;
    this.raw += delta;
    // Keep a little slack over the tail so markup cut at the window edge
    // can still be recognized; the stored text is capped again below.
    const keep = this.tailChars * 2;
    if (this.raw.length > keep) this.raw = this.raw.slice(this.raw.length - keep);
    this.pendingChars += delta.length;
    this.dirty = true;
    if (this.pendingChars >= this.flushChars) {
      void this.flush();
      return;
    }
    if (this.timer === undefined) {
      this.timer = this.setTimer(() => {
        this.timer = undefined;
        void this.flush();
      }, this.flushMs);
    }
  }

  /** Append one whole line (e.g. a tool step), separated from prior text. */
  line(text: string): void {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    const sep = this.raw === "" || this.raw.endsWith("\n") ? "" : "\n";
    this.push(`${sep}${clean}\n`);
  }

  /** Current display tail (stripped, capped). */
  snapshot(): string {
    const text = liveDisplayText(this.raw);
    return text.length > this.tailChars ? text.slice(text.length - this.tailChars) : text;
  }

  /** Write the current tail now (queued behind earlier writes). */
  flush(): Promise<unknown> {
    this.cancelTimer();
    if (this.closed || !this.dirty) return this.chain;
    this.dirty = false;
    this.pendingChars = 0;
    const text = this.snapshot();
    if (!text || text === this.lastWritten) return this.chain;
    this.lastWritten = text;
    this.chain = this.chain.then(() => this.sink.write(text)).catch(() => undefined);
    return this.chain;
  }

  /** Stop accepting text and clear the stored tail after pending writes. */
  close(): Promise<unknown> {
    if (this.closed) return this.chain;
    this.closed = true;
    this.cancelTimer();
    const hadOutput = this.lastWritten !== "";
    this.raw = "";
    if (hadOutput) {
      this.chain = this.chain.then(() => this.sink.clear()).catch(() => undefined);
    }
    return this.chain;
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }
}
