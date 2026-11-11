/**
 * Context-overflow recovery (DeepSeek Harness D2, pattern only, MIT,
 * Copyright (c) 2026 DeepSeek: compaction-basic's request-error path and
 * the compaction start/end lock events of docs/subsystems/compaction.md).
 *
 * When a call fails because the request is longer than the model's
 * context window (llm/errors.ts `isContextOverflowError`), the SAME call
 * is shrunk and retried, bounded:
 *   1. head/middle/tail-prune every long message outside the protected
 *      head (system + task statement) and tail (the newest message), with
 *      the vendored budgets (4096 head + marker + 1024 tail, at most 8192);
 *   2. re-check the pressure against the limit the provider named;
 *   3. only if still over, summarize the middle (when a summarizer is
 *      given) or else drop it with a note; then
 *   4. retry. A second overflow takes the step it skipped (3) and retries
 *      once more; a third fails with a clear reason. Never more than
 *      MAX_OVERFLOW_RETRIES retries, never a different model: an overflow
 *      is not a provider failure (lib/llmRotation.ts, kind context_overflow).
 * The work is wrapped in `compaction.start` / `compaction.end` events, so a
 * start without an end (a crash mid-way) is detectable.
 */
import type { LLMMessage } from "@/llm";
import { contextLimitOf, isContextOverflowError, LlmContextOverflowError } from "@/llm/errors";
import { codePointLength, PRUNE_MARKER, resolveConfig, type ToolResultPruneConfig } from "@/vendor/deepseek-harness/prunerConfig";
import { buildSummaryPrompt } from "@/prompts/compaction";
import { isSpillPreview, spillNoticeOf } from "@/context/toolOutputSpill";

export const MAX_OVERFLOW_RETRIES = 2;
/** Re-check headroom: after pruning, the request must fit in this share of the named limit. */
export const OVERFLOW_TARGET_RATIO = 0.85;

/** Head + marker + tail of `text` when it is over the threshold; else `text` unchanged. */
export function pruneHeadTail(text: string, config?: ToolResultPruneConfig): string {
  const { thresholdChars, headChars, tailChars } = resolveConfig(config);
  if (codePointLength(text) <= thresholdChars) return text;
  const points = Array.from(text);
  return points.slice(0, headChars).join("") + PRUNE_MARKER + (tailChars > 0 ? points.slice(-tailChars).join("") : "");
}

/** chars/4, the estimate the rest of the worker uses. */
export function estimateMessagesTokens(messages: readonly LLMMessage[]): number {
  return Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
}

export interface OverflowRecoveryOptions<T> {
  /** The call's messages; rewritten IN PLACE when the request is shrunk. */
  messages: LLMMessage[];
  call: (messages: LLMMessage[]) => Promise<T>;
  /** Non-system messages kept verbatim at the start (the task statement). Default 1. */
  protectFirst?: number;
  /** Messages kept verbatim at the end (the newest turn). Default 1. */
  protectLast?: number;
  /** Optional summary call for step 3; without it the middle is dropped with a note. */
  summarize?: (prompt: string) => Promise<string>;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
  prune?: ToolResultPruneConfig;
}

export interface OverflowRecoveryResult<T> {
  result: T;
  /** Retries made after an overflow (0 = the first call fit). */
  retries: number;
  /** Messages were removed or merged, so indexes into `messages` moved. */
  restructured: boolean;
}

function bounds(messages: readonly LLMMessage[], protectFirst: number, protectLast: number): { from: number; to: number } {
  let systems = 0;
  while (systems < messages.length && messages[systems].role === "system") systems++;
  const from = Math.min(messages.length, systems + protectFirst);
  const to = Math.max(from, messages.length - protectLast);
  return { from, to };
}

/** Step 1: head/middle/tail-prune the unprotected messages. Returns how many were cut. */
function pruneMiddle(messages: LLMMessage[], from: number, to: number, config?: ToolResultPruneConfig): number {
  let cut = 0;
  for (let index = from; index < to; index++) {
    // D3: a spill preview is already head + tail + locator; pruning it again would cut the locator.
    if (isSpillPreview(messages[index].content)) continue;
    const content = pruneHeadTail(messages[index].content, config);
    if (content !== messages[index].content) {
      messages[index] = { ...messages[index], content };
      cut++;
    }
  }
  return cut;
}

/** Step 3: replace the unprotected middle with a summary (or a drop note). */
async function compactMiddle(
  messages: LLMMessage[],
  from: number,
  to: number,
  summarize?: (prompt: string) => Promise<string>
): Promise<{ summarized: boolean; dropped: number }> {
  const middle = messages.slice(from, to);
  if (middle.length === 0) return { summarized: false, dropped: 0 };
  let note = `[${middle.length} earlier message${middle.length === 1 ? "" : "s"} removed to fit the model's context window]`;
  let summarized = false;
  if (summarize) {
    const prompt = buildSummaryPrompt(middle.map((m) => ({ authorType: m.role === "assistant" ? "agent" : "user", content: pruneHeadTail(m.content, { thresholdChars: 2048, headChars: 1024, tailChars: 512 }) })));
    const summary = (await summarize(prompt)).trim();
    if (summary) {
      note = `Summary of ${middle.length} earlier message${middle.length === 1 ? "" : "s"} (compacted to fit the model's context window):\n${summary}`;
      summarized = true;
    }
  }
  // D3: spilled outputs stay readable after compaction; keep their locators.
  const saved = middle.map((m) => spillNoticeOf(m.content)).filter((n): n is string => Boolean(n));
  if (saved.length) note += `\nSaved tool outputs still readable:\n${saved.join("\n")}`;
  messages.splice(from, middle.length, { role: "user", content: note });
  return { summarized, dropped: middle.length };
}

/**
 * Run `call`; on a context overflow, shrink `messages` and retry, bounded
 * (see the module comment). Any other error is rethrown untouched.
 */
export async function callWithOverflowRecovery<T>(options: OverflowRecoveryOptions<T>): Promise<OverflowRecoveryResult<T>> {
  const { messages } = options;
  const protectFirst = options.protectFirst ?? 1;
  const protectLast = options.protectLast ?? 1;
  let retries = 0;
  let pruned = 0;
  let compacted = false;
  let restructured = false;
  let lastError: unknown;
  for (;;) {
    try {
      return { result: await options.call(messages), retries, restructured };
    } catch (error) {
      if (!isContextOverflowError(error)) throw error;
      lastError = error;
    }
    const limit = contextLimitOf(lastError);
    if (retries >= MAX_OVERFLOW_RETRIES || compacted) break;
    const tokensBefore = estimateMessagesTokens(messages);
    options.onEvent?.("compaction.start", { reason: "context_overflow", attempt: retries + 1, tokens: tokensBefore, ...(limit ? { limit } : {}) });
    let step: "pruned" | "summarized" | "dropped" = "pruned";
    let cut = 0;
    let dropped = 0;
    try {
      const { from, to } = bounds(messages, protectFirst, protectLast);
      cut = retries === 0 ? pruneMiddle(messages, from, to, options.prune) : 0;
      pruned += cut;
      // Re-check: still over the named limit (or nothing could be pruned,
      // so the same request would fail the same way) → compact the middle.
      const stillOver = cut === 0 || (limit !== undefined && estimateMessagesTokens(messages) > limit * OVERFLOW_TARGET_RATIO);
      if (stillOver || retries > 0) {
        const outcome = await compactMiddle(messages, from, to, options.summarize);
        compacted = true;
        dropped = outcome.dropped;
        restructured ||= outcome.dropped > 0;
        step = outcome.summarized ? "summarized" : "dropped";
        if (outcome.dropped === 0 && cut === 0) {
          options.onEvent?.("compaction.end", { step: "none", tokens: estimateMessagesTokens(messages) });
          break; // nothing left to shrink: retrying would fail identically
        }
      }
    } catch (error) {
      options.onEvent?.("compaction.end", { step: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    options.onEvent?.("compaction.end", { step, pruned: cut, dropped, tokens: estimateMessagesTokens(messages) });
    retries++;
  }
  const original = lastError instanceof Error ? lastError.message : String(lastError);
  if (retries === 0) {
    throw new LlmContextOverflowError(
      `The request is longer than the model's context window and has no older history or tool output left to shrink: ${original}`,
      { cause: lastError, status: 400, contextLimit: contextLimitOf(lastError) }
    );
  }
  throw new LlmContextOverflowError(
    `The request is still longer than the model's context window after ${retries} recovery retr${retries === 1 ? "y" : "ies"} (${pruned} message${pruned === 1 ? "" : "s"} pruned${compacted ? ", history compacted" : ""}): ${original}`,
    { cause: lastError, status: 400, contextLimit: contextLimitOf(lastError) }
  );
}
