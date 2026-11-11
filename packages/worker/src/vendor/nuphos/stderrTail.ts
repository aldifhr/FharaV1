// Ported from openab (https://github.com/openabdev/openab), as vendored in
// Nuphos (https://github.com/nuphos/nuphos) at
// apps/runtime/openab/crates/openab-core/src/acp/connection.rs @ a210a05
// (ERROR_LIKE, CREDENTIAL_LIKE, OPAQUE_RUN, redact_stderr_line, note_stderr)
// and src/redact.rs (redact_session_ids).
// MIT License, Copyright (c) 2026 openabdev. See THIRD_PARTY_NOTICES.md.
//
// Changes for Fhara: Rust → TypeScript. The three pattern lists are copied
// verbatim, except that the case-sensitive `E[A-Z]{3,}` errno branch is its
// own regex (JS has no inline `(?-i:…)`). A line is also withheld when Fhara's
// own L2 redactor (known secret values plus apps/api/convex/lib/secretPatterns)
// would change it. Session ids `ses_`/`sess_`/`acp_` become a short hash. The
// death-line prefix is Fhara's (`fhara-process-death: `).

// What an ACP agent said on stderr, kept so a failure can show the likely
// cause without ever showing a credential: only error-like lines are kept,
// a line that may carry a credential is withheld whole, and long opaque
// runs (keys, hashes) are masked in place.
import crypto from 'node:crypto';
import { redactText } from '../../utils/redact';

export const STDERR_TAIL_LINES = 20;
export const STDERR_TAIL_BYTES = 2_000;
/** One runaway line (a minified stack, a JSON dump) must not evict the whole tail. */
export const STDERR_LINE_CHARS = 500;

export const WITHHELD_LINE = '[line withheld: it may contain a credential]';

/** A stderr line an agent writes once, right before exiting, with why it died. */
export const PROCESS_DEATH_PREFIX = 'fhara-process-death: ';

/** Only lines that read like a failure are kept (and not the body of a multi-line dump, such as a PEM key). */
const ERROR_LIKE =
  /\b(error|errno|exception|fail(s|ed|ure)?|fatal|panic(ked)?|denied|refused|forbidden|unauthori[sz]ed|timed? ?out|timeout|not found|no such|cannot|unable|invalid|abort(ed)?|killed|signal|out of memory|exit(ed)? (with )?(code|status))\b|^\s*at\s|Traceback|\.(rs|js|mjs|cjs|ts|py):\d+/i;
const ERRNO_LIKE = /\bE[A-Z]{3,}\b/;

/**
 * A line that may carry a credential is withheld whole: a partial mask can
 * leak the part it did not recognise. Named secrets, credential-shaped values
 * and URLs with a password all count.
 */
const CREDENTIAL_LIKE = new RegExp(
  [
    String.raw`api[_-]?key|(token|key|secret|credential)s?\W{0,3}\s*[=:]|_token\b|access[_-]?token|refresh[_-]?token|id[_-]?token`,
    String.raw`|secret|passw(or)?d|passphrase|credential|authorization|\bbearer\s|\bbasic\s+[a-z0-9+/=]{8,}|cookie|private[_-]?key|-----(begin|end)`,
    String.raw`|\bsk[-_](live_|test_|proj-|ant-)?[a-z0-9]|\brk_(live|test)_|\bgh[pousr]_|\bgithub_pat_|\bglpat-|\bnpm_[a-z0-9]{20,}|\bxox[abprs]-`,
    String.raw`|\baiza[0-9a-z_-]{20,}|\b(akia|asia)[0-9a-z]{16}\b|\beyj[a-z0-9_-]{6,}\.[a-z0-9_-]{6,}\.|[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@`,
  ].join(''),
  'i',
);

/** A long opaque run (a hash, a key) is masked in place: it never explains a failure. */
const OPAQUE_RUN = /[A-Za-z0-9+/_=-]{32,}/g;

const SESSION_ID = /\b(?:ses|sess|acp)_([A-Za-z0-9-]+)/g;

function hashTag(id: string): string {
  return `#${crypto.createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
}

/** Whether a stderr line may carry a credential (openab's list, or Fhara's L2 redactor would mask it). */
export function isCredentialLike(line: string): boolean {
  return CREDENTIAL_LIKE.test(line) || redactText(line) !== line;
}

/** The line as it may be shown, or null when it is not worth keeping. */
export function redactStderrLine(line: string): string | null {
  if (!line.trim()) return null;
  if (isCredentialLike(line)) return WITHHELD_LINE;
  if (!ERROR_LIKE.test(line) && !ERRNO_LIKE.test(line)) return null;
  const chars = [...line];
  let out = chars.length > STDERR_LINE_CHARS ? `${chars.slice(0, STDERR_LINE_CHARS).join('')}…` : line;
  out = out.replace(OPAQUE_RUN, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? '[redacted]' : run));
  out = out.replace(SESSION_ID, (_m, id: string) => hashTag(id));
  return out.replace(/```/g, "'''");
}

/** The agent's recent stderr, redacted and bounded, plus its death note if it gave one. */
export class StderrTail {
  private lines: string[] = [];
  private death?: string;

  /** Record one raw stderr line. */
  push(raw: string): void {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith(PROCESS_DEATH_PREFIX)) {
      const note = line.slice(PROCESS_DEATH_PREFIX.length).trim();
      // Its own words are still the agent's: never kept if they look like a secret.
      if (note) this.death = isCredentialLike(note) ? undefined : note.slice(0, STDERR_LINE_CHARS);
      return;
    }
    const kept = redactStderrLine(line);
    if (kept === null) return;
    this.lines.push(kept);
    while (this.lines.length > STDERR_TAIL_LINES || this.lines.reduce((n, l) => n + l.length + 1, 0) > STDERR_TAIL_BYTES) {
      this.lines.shift();
    }
  }

  /** The kept lines, oldest first. */
  list(): string[] {
    return [...this.lines];
  }

  /** The last `n` kept lines joined, or '' when nothing was kept. */
  text(n = STDERR_TAIL_LINES): string {
    return this.lines.slice(-n).join('\n');
  }

  /** The agent's own words for why it is dying, if it said so. */
  get processDeath(): string | undefined {
    return this.death;
  }
}
