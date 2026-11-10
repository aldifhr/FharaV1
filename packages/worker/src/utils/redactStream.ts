/**
 * L2: chunk-safe redaction for streamed text (model deltas, PTY output,
 * child stdout/stderr).
 *
 * A secret can arrive split across two chunks (`…sk-proj-AB` | `CD…`):
 * redacting each chunk on its own would let both halves through. The
 * redactor therefore holds back the tail that could still be the start of
 * a secret and releases it, masked, once the next chunk shows how it ends:
 *  - the last whitespace-free run of text (secrets have no whitespace),
 *    together with a `key=` / `key: ` / `Bearer ` right before it, so the
 *    pattern rules still see the key next to its value;
 *  - an open `-----BEGIN … PRIVATE KEY-----` block until its END line;
 *  - a suffix that is the start of a known secret value.
 * The held text is capped at 64 KiB: past that it is released (masked as
 * far as it can be), so a stream with no whitespace can never stall.
 *
 * The record-until-whole buffering, the 64 KiB cap and stripping ANSI before
 * redaction follow openbot's `stderr-diagnostics.ts` (pattern only, no code
 * copied: PolyForm Noncommercial).
 */
import { knownSecretValues, redactText } from "./redact";

export const REDACT_STREAM_HOLD_CAP = 64 * 1024;

const KEY_BEFORE_VALUE =
  /(?:["']?[A-Za-z0-9_.-]{0,32}(?:api[-_]?key|secret|password|passwd|pwd|token|credential|private[-_]?key|access[-_]?key|client[-_]?secret|authorization)[A-Za-z0-9_.-]{0,32}["']?[ \t]{0,4}[:=][ \t]{0,4}|\b(?:Bearer|Basic|token)[ \t]+)$/i;
const PEM_OPEN = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_CLOSE = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;

/** Index from which `buffer` must be held back (buffer.length = nothing held). */
export function holdIndex(buffer: string, knownValues: readonly string[] = knownSecretValues()): number {
  let hold = buffer.length;
  // Last whitespace-free run (may be empty when the buffer ends in whitespace).
  let start = buffer.length;
  while (start > 0 && !/\s/.test(buffer[start - 1])) start -= 1;
  if (start < buffer.length) hold = start;
  // A sensitive key (or auth scheme) right before the run, or ending the buffer.
  const key = KEY_BEFORE_VALUE.exec(buffer.slice(Math.max(0, hold - 128), hold));
  if (key) hold -= key[0].length;
  // Known values containing whitespace: a suffix that starts one.
  for (const value of knownValues) {
    const max = Math.min(value.length - 1, buffer.length);
    for (let k = max; k > 0; k -= 1) {
      if (buffer.length - k >= hold) break;
      if (buffer.endsWith(value.slice(0, k))) {
        hold = buffer.length - k;
        break;
      }
    }
  }
  // An open private-key block.
  let lastOpen = -1;
  for (const match of buffer.matchAll(PEM_OPEN)) lastOpen = match.index ?? -1;
  if (lastOpen >= 0 && !PEM_CLOSE.test(buffer.slice(lastOpen))) hold = Math.min(hold, lastOpen);
  // An escape sequence cut at the end (`\x1b[0` …) stays with the held part.
  const esc = buffer.lastIndexOf("\x1b");
  if (esc >= 0 && esc < hold && !/^\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/.test(buffer.slice(esc))) hold = esc;
  return Math.max(0, hold);
}

const TOKEN_PREFIXES = ["sk-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "xox", "AKIA", "ASIA", "AIza", "glpat-", "npm_", "eyJ", "-----BEGIN"];
const SENSITIVE_WORD = /api[-_]?key|secret|password|passwd|pwd|token|credential|private[-_]?key|access[-_]?key|authorization|bearer|basic/i;

/**
 * Whether a held tail may be shown before the stream continues (a display
 * preview, e.g. a live output tail between deltas): it is not next to a
 * sensitive key, does not start like a known token shape, and does not end
 * with the first 3+ characters of a known secret value.
 */
export function isSafeHeldTail(tail: string, knownValues: readonly string[] = knownSecretValues()): boolean {
  if (!tail) return true;
  if (tail.length > 256) return false;
  if (SENSITIVE_WORD.test(tail)) return false;
  const word = tail.trimStart();
  for (const prefix of TOKEN_PREFIXES) {
    if (word.startsWith(prefix) || (word.length < prefix.length && prefix.startsWith(word) && word.length >= 2)) return false;
  }
  if (/\x1b/.test(tail)) return false;
  for (const value of knownValues) {
    const max = Math.min(value.length - 1, tail.length);
    for (let k = max; k >= 3; k -= 1) {
      if (tail.endsWith(value.slice(0, k))) return false;
    }
  }
  return true;
}

export class StreamRedactor {
  private pending = "";

  constructor(
    private readonly options: { cap?: number; redact?: (text: string) => string } = {}
  ) {}

  /** Feed a chunk; returns the text that is safe to emit now (masked). */
  push(chunk: string): string {
    if (!chunk) return "";
    const buffer = this.pending + chunk;
    let hold = holdIndex(buffer);
    const cap = this.options.cap ?? REDACT_STREAM_HOLD_CAP;
    if (buffer.length - hold > cap) hold = buffer.length;
    this.pending = buffer.slice(hold);
    return this.mask(buffer.slice(0, hold));
  }

  /** End of stream: release whatever is held (masked). */
  end(): string {
    const rest = this.pending;
    this.pending = "";
    return this.mask(rest);
  }

  /** The held text, masked, when it is safe to show ahead of the stream (else ""). */
  preview(): string {
    return isSafeHeldTail(this.pending) ? this.mask(this.pending) : "";
  }

  /** Characters currently held back. */
  get held(): number {
    return this.pending.length;
  }

  private mask(text: string): string {
    if (!text) return "";
    return (this.options.redact ?? redactText)(text);
  }
}
