/**
 * Sticky round-robin rotation, the empty-completion check and the
 * cooldown-on-error rules for the LLM pool.
 *
 * Adapted from 9router (https://github.com/decolua/9router @ 1339107):
 *  - StickyRotationCursor  ← open-sse/services/combo.js
 *    (getRotatedModels / normalizeStickyLimit / rotateModelsFromIndex)
 *  - isEmptyCompletion     ← open-sse/services/combo.js (isZeroContentResponse)
 *  - cooldownForFailure    ← open-sse/services/accountFallback.js
 *    (checkFallbackError / getQuotaCooldown) + open-sse/config/errorConfig.js
 *    (ERROR_RULES, BACKOFF_CONFIG, TRANSIENT_COOLDOWN_MS)
 * Rewritten in TypeScript and reduced to what Fhara uses.
 *
 * MIT License
 *
 * Copyright (c) 2024-2026 decolua and contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Pure module (no Convex import): the backend and the worker share it.
 */

/** Hands out the start index of a rotation among `size` candidates. */
export interface StickyCursor {
  next(size: number): number;
}

function normalizeStickyLimit(limit: unknown): number {
  const parsed = typeof limit === "number" ? Math.floor(limit) : Number.parseInt(String(limit), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Round robin with a sticky limit: the same start index is handed out
 * `stickyLimit` times in a row before moving to the next one (1 = rotate
 * every call). In-memory, per process: a load-spreading hint, never
 * correctness state.
 */
export class StickyRotationCursor implements StickyCursor {
  private readonly state = new Map<string, { index: number; uses: number }>();
  private readonly stickyLimit: number;

  constructor(
    stickyLimit: number = 1,
    private readonly scope: string = "global"
  ) {
    this.stickyLimit = normalizeStickyLimit(stickyLimit);
  }

  next(size: number): number {
    if (size <= 0) return 0;
    const current = this.state.get(this.scope) ?? { index: 0, uses: 0 };
    const index = current.index % size;
    const uses = current.uses + 1;
    this.state.set(
      this.scope,
      uses >= this.stickyLimit ? { index: (index + 1) % size, uses: 0 } : { index, uses }
    );
    return index;
  }

  /** The index the next call would use, without advancing. */
  peek(size: number): number {
    if (size <= 0) return 0;
    return (this.state.get(this.scope)?.index ?? 0) % size;
  }

  reset(): void {
    this.state.clear();
  }
}

/** `list` rotated so that `start` comes first (the rest keeps its order). */
export function rotateFrom<T>(list: readonly T[], start: number): T[] {
  if (list.length <= 1) return [...list];
  const index = ((start % list.length) + list.length) % list.length;
  return [...list.slice(index), ...list.slice(0, index)];
}

/**
 * A 2xx completion that carries nothing usable: no text, no tool call,
 * no reasoning. Worth failing over to the next model, like an error.
 */
export function isEmptyCompletion(result: {
  content?: string | null;
  reasoning?: string | null;
  toolCalls?: readonly unknown[] | null;
}): boolean {
  const hasText = typeof result.content === "string" && result.content.trim().length > 0;
  const hasReasoning = typeof result.reasoning === "string" && result.reasoning.trim().length > 0;
  const hasTools = Array.isArray(result.toolCalls) && result.toolCalls.length > 0;
  return !hasText && !hasReasoning && !hasTools;
}

const BACKOFF = { baseMs: 2_000, maxMs: 5 * 60_000, maxLevel: 15 };
const TRANSIENT_COOLDOWN_MS = 30_000;
const LONG_COOLDOWN_MS = 2 * 60_000;

const RATE_LIMIT_TEXT = [
  "rate limit",
  "too many requests",
  "quota exceeded",
  "insufficient credit",
  "credit balance is too low",
  "capacity",
  "overloaded",
];

export interface FailureCooldown {
  /** How long to keep the connection out of rotation. 0 = do not cool down. */
  cooldownMs: number;
  /** Rate-limit backoff level after this failure (rate limits only). */
  backoffLevel?: number;
  kind: "rate_limit" | "auth" | "transient" | "request";
}

/** Exponential backoff for rate limits: level 1 = 2s, then doubling, max 5 min. */
export function rateLimitCooldownMs(level: number): number {
  const exponent = Math.max(0, level - 1);
  return Math.min(BACKOFF.baseMs * 2 ** exponent, BACKOFF.maxMs);
}

/** HTTP status of an error: `status` / `statusCode`, or "(429)" / "HTTP 429" in the message. */
export function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown; message?: unknown };
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  if (typeof candidate.message === "string") {
    const match = candidate.message.match(/(?:\(|HTTP\s+|failed:\s*)(\d{3})\b/);
    if (match) return Number(match[1]);
  }
  return undefined;
}

/**
 * How long a failure should keep a connection out of rotation:
 * rate-limit wording or 429 → exponential backoff; 401/402/403 → 2 min
 * (the credential is at fault); other 4xx → no cooldown (the request is at
 * fault, not the connection); anything else (5xx, network) → 30 s.
 */
export function cooldownForFailure(error: unknown, previousLevel = 0): FailureCooldown {
  const status = errorStatus(error);
  const message =
    error instanceof Error ? error.message.toLowerCase() : typeof error === "string" ? error.toLowerCase() : "";
  if (status === 429 || RATE_LIMIT_TEXT.some((text) => message.includes(text))) {
    const level = Math.min(previousLevel + 1, BACKOFF.maxLevel);
    return { cooldownMs: rateLimitCooldownMs(level), backoffLevel: level, kind: "rate_limit" };
  }
  if (status === 401 || status === 402 || status === 403) {
    return { cooldownMs: LONG_COOLDOWN_MS, kind: "auth" };
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return { cooldownMs: 0, kind: "request" };
  }
  return { cooldownMs: TRANSIENT_COOLDOWN_MS, kind: "transient" };
}
