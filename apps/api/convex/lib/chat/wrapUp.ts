/**
 * CTO wrap-up gating (pure, no LLM).
 *
 * After the CTO hands a question to a specialist, it may post a short
 * wrap-up. Live bug: "can you ask frontend, what is html" → Frontend
 * answered, then the CTO restated the same answer and the same offer.
 *
 * Rules:
 * - No wrap-up when the user named the specialist ("@Frontend", "ask
 *   frontend", "tanya frontend", "minta reviewer", "Frontend, …"), or when
 *   exactly one specialist answered and its reply is short.
 * - Otherwise the wrap-up may only add a decision or next step: at most
 *   WRAP_UP_MAX_LINES lines. Empty / "nothing to add" output, or output that
 *   is a near-duplicate of a specialist reply (token Jaccard), is dropped.
 *
 * Unit-tested in wrapUp.test.ts.
 */

/** A single specialist reply at or under this many words (and lines, below) needs no wrap-up. */
export const WRAP_UP_SHORT_REPLY_MAX_WORDS = 120;
/** …and at or under this many non-empty lines. */
export const WRAP_UP_SHORT_REPLY_MAX_LINES = 8;
/** The wrap-up's own length cap (non-empty lines). */
export const WRAP_UP_MAX_LINES = 2;
/** Token Jaccard above this against a specialist reply (or one of its sentences) = restatement. */
export const WRAP_UP_DUPLICATE_JACCARD = 0.6;
/** A wrap-up line whose tokens (≥ 6 of them) are at least this share taken from the reply = restatement. */
export const WRAP_UP_DUPLICATE_CONTAINMENT = 0.8;

type Named = { name: string; role: string };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Words the user may call an agent by: its name and its role key/label. */
function aliasesOf(agent: Named): string[] {
  const out = new Set<string>();
  for (const raw of [agent.name, agent.role]) {
    const s = (raw ?? "").trim();
    if (!s) continue;
    out.add(s);
    out.add(s.replace(/[-_]+/g, " "));
  }
  return [...out].filter((s) => s.length >= 2);
}

// "ask frontend", "can you ask the frontend", "tanya frontend", "tanyain ke
// frontend", "minta reviewer", "suruh qa", "ping backend", "let QA check".
const ASK_VERBS =
  "ask|asking|tell|ping|let|consult|loop in|bring in|check with|tanya|tanyain|tanyakan|nanya|minta|mintain|suruh|panggil|coba tanya|biar|biarkan";
const ASK_LINKS = "(?:\\s+(?:ke|kepada|sama|si|pada|the|our|to|with))?";

/**
 * The user addressed this agent by name in the message itself: a typed
 * @mention, an "ask <agent>" / "tanya <agent>" phrase, or a leading
 * "<Agent>, …" vocative.
 */
export function userNamedAgent(text: string, agent: Named): boolean {
  const body = text ?? "";
  for (const alias of aliasesOf(agent)) {
    const a = escapeRe(alias).replace(/ +/g, "[\\s_-]+");
    const end = "(?![\\w-])";
    if (new RegExp(`@${a}${end}`, "i").test(body)) return true;
    if (new RegExp(`\\b(?:${ASK_VERBS})${ASK_LINKS}\\s+@?${a}${end}`, "i").test(body)) return true;
    if (new RegExp(`^\\s*(?:hey|hi|halo|hai)?[\\s,]*@?${a}\\s*[,:]`, "i").test(body)) return true;
  }
  return false;
}

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/** The reply is short enough that a wrap-up would only repeat it. */
export function isShortReply(reply: string): boolean {
  return wordCount(reply) <= WRAP_UP_SHORT_REPLY_MAX_WORDS && nonEmptyLines(reply).length <= WRAP_UP_SHORT_REPLY_MAX_LINES;
}

export type WrapUpSkip = "user-named-agent" | "short-single-reply" | "no-reply";

/**
 * Why the CTO posts no wrap-up this turn, or null when it may post one.
 * `specialists` are the teammates (not the CTO) who answered, with replies.
 */
export function wrapUpSkipReason(input: {
  userText: string;
  specialists: Array<{ agent: Named; reply: string }>;
}): WrapUpSkip | null {
  const answered = input.specialists.filter((s) => s.reply.trim());
  if (answered.length === 0) return "no-reply";
  if (answered.some((s) => userNamedAgent(input.userText, s.agent))) return "user-named-agent";
  if (answered.length === 1 && isShortReply(answered[0].reply)) return "short-single-reply";
  return null;
}

function tokens(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length > 1)
  );
}

/** Token-set Jaccard similarity, 0..1. */
export function jaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

const NOTHING_TO_ADD =
  /^(?:\W*)(?:nothing (?:more |else )?to add|no(?:thing)? further (?:notes|comments)|n\/a|none|-+|tidak ada (?:yang perlu )?(?:tambahan|ditambahkan)|nggak ada tambahan|gak ada tambahan|tidak ada tambahan)\W*$/i;

const OFFER =
  /\b(?:want me to|would you like|should i|shall i|do you want|if you(?:'d)? (?:like|want)|let me know if|happy to|mau saya|perlu saya|apakah (?:anda|kamu) (?:mau|ingin)|kalau (?:mau|perlu)|jika (?:anda )?(?:mau|ingin|perlu)|bisa saya bantu)\b/i;

/** Share of `a`'s tokens that also appear in `b`, 0..1. */
function containment(a: string, b: string): number {
  const ta = tokens(a);
  if (ta.size === 0) return 0;
  const tb = tokens(b);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / ta.size;
}

/** Sentences of a reply (for per-sentence duplicate checks). */
function pieces(text: string): string[] {
  return nonEmptyLines(text).flatMap((l) => l.split(/(?<=[.!?])\s+/)).map((s) => s.trim()).filter((s) => tokens(s).size >= 3);
}

/**
 * Clean the model's wrap-up: null to post nothing. Drops empty / "nothing
 * to add" output and near-duplicates of a specialist reply; drops lines that
 * restate a reply sentence or repeat an offer when the specialist already
 * made one; keeps at most WRAP_UP_MAX_LINES lines.
 */
export function sanitizeWrapUp(output: string, specialistReplies: string[]): string | null {
  const text = (output ?? "").trim();
  if (!text || NOTHING_TO_ADD.test(text)) return null;
  const replies = specialistReplies.map((r) => r.trim()).filter(Boolean);
  if (replies.some((r) => jaccard(text, r) > WRAP_UP_DUPLICATE_JACCARD)) return null;
  const replyPieces = replies.flatMap(pieces);
  const specialistOffered = replies.some((r) => OFFER.test(r));
  const kept = nonEmptyLines(text).filter((line) => {
    if (NOTHING_TO_ADD.test(line)) return false;
    if (specialistOffered && OFFER.test(line)) return false;
    if (replies.some((r) => jaccard(line, r) > WRAP_UP_DUPLICATE_JACCARD)) return false;
    if (pieces(line).some((sentence) => replyPieces.some((p) => jaccard(sentence, p) > WRAP_UP_DUPLICATE_JACCARD))) return false;
    if (tokens(line).size >= 6 && replies.some((r) => containment(line, r) >= WRAP_UP_DUPLICATE_CONTAINMENT)) return false;
    return true;
  });
  if (kept.length === 0) return null;
  return kept.slice(0, WRAP_UP_MAX_LINES).join("\n");
}
