/**
 * One prompt layout for every builder (D5): the stable prefix first, then
 * the conversation, then the volatile tail. Provider prompt caches match on
 * a byte-identical prefix, so anything that changes per call (the time line,
 * a turn's own notes) goes last and never ahead of the history.
 *
 * Pattern from DeepSeek Harness (MIT, Copyright (c) 2026 DeepSeek); no code
 * copied. Pure: shared by the worker (planner, executor) and chat.
 */

export interface PromptMessageLike {
  role: string;
  content: string;
}

export interface PromptParts<T extends PromptMessageLike = PromptMessageLike> {
  /** Instructions that stay byte-identical across calls of one task/conversation. */
  stable?: string | readonly string[];
  /** The conversation (or the call's own task turn), oldest first. */
  history?: readonly T[];
  /** Per-call context (the time line, …), appended after everything else. */
  volatile?: string | readonly string[];
  /**
   * Where the stable prefix lives. "system" (default) is its own leading
   * system message; "user" prefixes the first user turn (single-turn calls
   * that carry no system message, such as the neutral planner).
   */
  stableAs?: "system" | "user";
}

function joinBlocks(value: string | readonly string[] | undefined, sep: string): string {
  if (value === undefined) return "";
  const list = typeof value === "string" ? [value] : value;
  return list.filter((block) => block !== "").join(sep);
}

/** The stable prefix text exactly as assemblePrompt places it. */
export function stablePrefixText(parts: Pick<PromptParts, "stable">): string {
  return joinBlocks(parts.stable, "\n");
}

/**
 * Append the volatile tail to the last user turn. A conversation that ends on
 * an assistant turn (a prefill being continued) is returned unchanged, so the
 * prefill is never split and nothing follows it (D4 rule).
 */
export function appendVolatile<T extends PromptMessageLike>(messages: readonly T[], tail: string): T[] {
  const last = messages[messages.length - 1];
  if (!tail || !last || last.role !== "user") return [...messages];
  return [...messages.slice(0, -1), { ...last, content: `${last.content}\n\n${tail}` }];
}

export function assemblePrompt<T extends PromptMessageLike>(parts: PromptParts<T>): T[] {
  const stable = stablePrefixText(parts);
  const history = [...(parts.history ?? [])];
  const tail = joinBlocks(parts.volatile, "\n\n");
  let messages: T[];
  if (!stable) messages = history;
  else if (parts.stableAs === "user") {
    const first = history[0];
    messages =
      first && first.role === "user"
        ? [{ ...first, content: `${stable}\n${first.content}` }, ...history.slice(1)]
        : [{ role: "user", content: stable } as T, ...history];
  } else messages = [{ role: "system", content: stable } as T, ...history];
  return appendVolatile(messages, tail);
}

/** FNV-1a (32-bit) hex of a string: a cheap, isolate-safe fingerprint. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Fingerprint of the stable prefix (equal hashes = the provider cache can hit). */
export function stablePrefixHash(parts: Pick<PromptParts, "stable">): string {
  return fnv1a(stablePrefixText(parts));
}
