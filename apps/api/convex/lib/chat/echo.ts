/**
 * Speaker-echo cleanup for agent chat replies (pure; unit-tested in echo.test.ts).
 *
 * The chat history reaches a model as transcript-style lines ("CTO: …"),
 * and a model sometimes opens its reply by copying one of them. Live bug:
 * after the CTO's handoff line, Frontend's answer began with
 * "CTO: Handing this to @Frontend for the frontend side." and then the real
 * answer. This removes, at the very start of a reply only:
 *
 * - "<Speaker>: <text of a recent prior message>" — a teammate's (or the
 *   user's) name/role, then text equal to or starting with a prior message;
 *   the copied message is dropped and the rest of the reply kept;
 * - a bare "<OwnName>:" / "<OwnRole>:" speaker prefix.
 *
 * A reply that only starts with a label that is not a speaker ("Note:",
 * "HTML:"), or a speaker label followed by new text, is left alone.
 */

export interface EchoContext {
  /** The replying agent's own name and role ("Frontend", "frontend"). */
  selfNames: string[];
  /** Every other speaker in the chat: teammate names and roles, "CTO", "User". */
  speakerNames: string[];
  /** Recent messages a reply could copy (handoff line, this turn's replies, last history rows). */
  priorMessages: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Normalises for comparison: no markdown emphasis, single spaces. */
function norm(text: string): string {
  return text.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const t = n?.trim();
    if (!t || t.length > 40) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  // Longest first so "QA Engineer" wins over "QA".
  return out.sort((a, b) => b.length - a.length);
}

/** "**CTO:**", "@CTO:", "CTO (cto):" … at the start of `text`; returns where the label ends. */
function speakerPrefix(text: string, names: string[]): { end: number; name: string } | null {
  for (const name of uniqueNames(names)) {
    const re = new RegExp(`^\\s*(?:\\*\\*|__)?@?${escape(name)}(?:\\s*\\([^)\\n]{1,30}\\))?\\s*(?:\\*\\*|__)?\\s*:\\s*(?:\\*\\*|__)?`, "i");
    const m = re.exec(text);
    if (m) return { end: m[0].length, name };
  }
  return null;
}

/**
 * Removes a prior message copied at the start of `rest`. Matching is on
 * normalised text, so the cut point is found by walking the original.
 */
function cutPrior(rest: string, priors: string[]): string | null {
  const restNorm = norm(rest);
  const ordered = priors.map((p) => p?.trim()).filter((p): p is string => Boolean(p && norm(p).length >= 8));
  ordered.sort((a, b) => b.length - a.length);
  for (const prior of ordered) {
    const p = norm(prior);
    if (!restNorm.startsWith(p)) continue;
    // Walk `rest` until its normalised prefix covers the prior message.
    for (let i = 1; i <= rest.length; i += 1) {
      if (norm(rest.slice(0, i)).length >= p.length) {
        return rest.slice(i).replace(/^[\s*_]+/, "");
      }
    }
    return "";
  }
  return null;
}

/** The reply without a leading speaker echo (see module doc). At most two passes. */
export function stripLeadingEcho(content: string, ctx: EchoContext): string {
  let text = content;
  for (let pass = 0; pass < 2; pass += 1) {
    const before = text;
    const other = speakerPrefix(text, [...ctx.speakerNames, ...ctx.selfNames]);
    if (other) {
      const rest = text.slice(other.end);
      const cut = cutPrior(rest, ctx.priorMessages);
      if (cut !== null) {
        text = cut;
        continue;
      }
    }
    const self = speakerPrefix(text, ctx.selfNames);
    if (self) {
      const rest = text.slice(self.end).trimStart();
      // "Frontend:" alone (nothing yet) is held by the streaming guard, not stripped here.
      if (rest) text = rest;
    }
    if (text === before) break;
  }
  return text;
}

/**
 * Streaming guard: while the visible text could still turn into an echo
 * (it is a prefix of "<Speaker>:" or "<Speaker>: <prior message>"), show
 * nothing yet; once it is decided, show the cleaned text.
 */
export function streamEchoSafe(content: string, ctx: EchoContext): string {
  const cleaned = stripLeadingEcho(content, ctx);
  if (cleaned !== content) return mightStillEcho(cleaned, ctx) ? "" : cleaned;
  return mightStillEcho(content, ctx) ? "" : content;
}

function mightStillEcho(content: string, ctx: EchoContext): boolean {
  const t = content.replace(/^[\s*_@]+/, "").toLowerCase();
  if (!t) return false;
  const names = uniqueNames([...ctx.speakerNames, ...ctx.selfNames]);
  // A partial label: "Fron", "CTO" (no colon yet).
  if (t.length < 45 && names.some((n) => `${n.toLowerCase()}:`.startsWith(t) || t === n.toLowerCase())) return true;
  const prefix = speakerPrefix(content, names);
  if (!prefix) return false;
  const rest = norm(content.slice(prefix.end));
  if (!rest) return true;
  return ctx.priorMessages.some((p) => {
    const n = norm(p ?? "");
    return n.length >= 8 && n.startsWith(rest);
  });
}
