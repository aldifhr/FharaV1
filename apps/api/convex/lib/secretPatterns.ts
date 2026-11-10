/**
 * Secret patterns shared by the Convex side (context snapshots) and the
 * worker (L2: every path out of the worker — live output, command output,
 * tool results, task events, logs — runs through `redactSecrets` after the
 * worker's own known-value masking).
 *
 * Pure: no database, no network, no env. Moved here unchanged from
 * `contextSnapshot.ts` (which re-exports `redactSecrets` for its callers).
 */

export const SECRET_VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY-----|$)/g,
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[bpasr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

// Bounded key name, anchored at a non-identifier char: an unbounded
// `[\w.-]*` on both sides backtracks quadratically on long runs of text.
export const SECRET_KEY =
  "(?<![A-Za-z0-9_.-])(?:[A-Za-z0-9_.-]{0,32}?(?:api[-_]?key|secret|password|passwd|pwd|token|credential|private[-_]?key|access[-_]?key|client[-_]?secret)[A-Za-z0-9_.-]{0,32})";

/** `KEY=value`, `key: value`, `"key": "value"` with a sensitive key name. */
export const KEY_VALUE_PATTERN = new RegExp(
  `(["']?${SECRET_KEY}["']?[ \\t]{0,4}[:=][ \\t]{0,4})(["']?)([^\\s"',;}{]{4,})(\\2)`,
  "gi"
);

/** `Authorization: Bearer x` / `Bearer x` / `Basic x`. */
export const AUTH_HEADER_PATTERN = /\b(Bearer|Basic|token)\s+([A-Za-z0-9._~+/=-]{12,})/g;

/** Mask secrets anywhere in free text. Idempotent. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags), "[REDACTED]");
  }
  out = out.replace(KEY_VALUE_PATTERN, (match, prefix: string, quote: string, value: string, close: string) =>
    value === "[REDACTED]" || /^\[REDACTED/.test(value) ? match : `${prefix}${quote}[REDACTED]${close}`
  );
  out = out.replace(AUTH_HEADER_PATTERN, (_m, scheme: string) => `${scheme} [REDACTED]`);
  return out;
}
