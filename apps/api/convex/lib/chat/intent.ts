/**
 * Chat intent detection: deterministic shapes (fast path) and the parser for
 * the LLM intent classifier's structured output. Pure — no Convex or Node
 * APIs — so it is unit-testable and safe to import from any runtime.
 */

// Mirrored from packages/worker/src/router/route.ts (Convex cannot import
// worker code). The backend chat auto-dispatch must honor the same platform
// rule: questions, advice and analysis never become tasks.
const QUESTION_SHAPE =
  /\b(how do i|how to|how can|how does|why|what is|what are|what's|what does|what do|where is|explain|describe|summari[sz]e|document|understand)\b/i;
// Indonesian questions, comparisons and opinion asks ("mana yang cocok?",
// "menurutmu …", "bandingkan A vs B") are discussion, never a task.
const QUESTION_SHAPE_ID =
  /\b(apa itu|apa yang|apa bedanya|apakah|bagaimana|gimana|kenapa|mengapa|kok|mana yang|yang mana|menurut(mu| kamu| lo| lu| anda)?|bandingkan|perbandingan|jelaskan|jelasin)\b|\bvs\.?\b/i;
// Indonesian tag questions and discussion particles ("kan …", "emang iya",
// "bukannya …", "masa sih") and any message ending in "?" are remarks or
// questions in a discussion, never an order. "kan ga cuma buat project ini
// kedepannya" became a task because "buat" (= "for") matched a change verb.
const DISCUSSION_SHAPE_ID =
  /(^|\s)(kan|emang(nya)?|memang(nya)?|bukan(nya)?|masa(k)?|toh)(\s|[?!.,]|$)|\?\s*$/i;
// "buat" is also the preposition "for": "buat project ini", "buat kamu",
// "buat ke depannya". Those uses are removed before looking for a change verb.
const BUAT_PREPOSITION =
  /\b(buat|untuk)\s+(project|proyek|projek|ini|itu|kamu|saya|aku|gue|gw|kita|kami|mereka|dia|apa|siapa|ke\s*depan\w*|kedepan\w*|nanti|sekarang|semua|user|pengguna|tim|team|orang|jaga[- ]jaga)\b/gi;
// "can you …" / "bisa …?" / "kamu bisa …?" — a question to the agent, not an
// order to build something. Was missing: the shape above only covered
// "can I …", so capability questions ("can you be CTO?") fell through to
// Stage B, where the LLM read "be CTO for the team" as execute_task.
const CONFIRMATION_SHAPE =
  /\b(can you|can u|are you able|bisa (nggak|ga|tidak)?|bisa kah|kamu bisa|apakah)\b/i;
const ADVICE_SHAPE =
  /\b(should i|recommend|best (practice|way)|suggest|advice|prefer)\b/i;
const EXPLICIT_NEGATION =
  /\b(do not|don't|dont|never)\b.*\b(create|make|start|run|execute|buat|bikin|jalankan)\b.*\btask\b|\b(jangan|tidak perlu)\b.*\btask\b/i;

// "baca ulang" / "cek lagi" / "koreksi": re-read and correct the agent's own
// previous reply. Chat, not a task — unless the same message also asks for a
// change ("cek lagi lalu perbaiki bug X").
const SELF_REVIEW_SHAPE =
  /\b(baca (ulang|lagi)|cek (lagi|ulang)|check (again|ulang|lagi)|periksa (lagi|ulang)|koreksi|ralat|re-?read|re-?check|double[- ]check)\b/i;
const CHANGE_VERB =
  /\b(buatin|buat\w*|tambah\w*|implement|build|create|fix|perbaiki|refactor|update|change|add|remove|migrate|hapus|ubah|edit)\b/i;

/** The user asks the agent to re-read and correct its own previous reply. */
export function isSelfReviewRequest(text: string): boolean {
  return SELF_REVIEW_SHAPE.test(text) && !CHANGE_VERB.test(text.replace(BUAT_PREPOSITION, " "));
}

/**
 * The speaker's own previous reply in this conversation (for "koreksi" /
 * "cek lagi"): its latest agent message before the user's latest message,
 * else the latest agent message at all.
 */
export function previousReplyOf(
  history: Array<{ authorType: string; content: string; agentId?: string }>,
  agentId: string
): string | null {
  const before = history.slice(0, -1);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const m = before[i];
    if (m.authorType === "agent" && String(m.agentId ?? "") === agentId && m.content.trim()) return m.content;
  }
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const m = before[i];
    if (m.authorType === "agent" && m.content.trim()) return m.content;
  }
  return null;
}

/** Bare greetings/small talk — answered with a brief LLM persona reply on
 *  minimal context (no history, no planning guidance), so old topics cannot
 *  drag a full execution plan into a "hi". */
export const GREETING =
  /^(hi|hello|hey|halo|hai|yo|good (morning|afternoon|evening))[!.,?\s]*$/i;

/**
 * Paths outside the project repository: parent traversal, home-relative
 * paths and system directories (e2e safety probe: "hapus /etc/hosts dan
 * edit ../outside.txt" must never become a task).
 */
const OUTSIDE_REPO_PATH =
  /(?:^|[\s"'`(=:,])((?:\.\.[\/\\]|~[\/\\])\S*|\/(?:etc|usr|var|bin|sbin|boot|root|proc|sys|dev|lib|lib64|System|Windows)(?:[\/\\]\S*)?(?=$|[\s"'`),;])|[A-Za-z]:\\\S*)/;

/** The first path in `text` that points outside the repository, or null. */
export function targetsOutsideRepo(text: string): string | null {
  const match = OUTSIDE_REPO_PATH.exec(text);
  return match ? match[1] : null;
}

const REFUSAL_REPLY =
  /(\bi\s+(?:can(?:not|['’]t)|won['’]t|will\s+not|must\s+(?:decline|refuse)|have\s+to\s+(?:decline|refuse)|refuse)\b|\bi['’]?m\s+(?:not\s+able|unable)\s+to\b|\bi\s+am\s+(?:not\s+able|unable)\s+to\b|\b(?:not|never)\s+(?:allowed|permitted|safe)\s+to\b|\boutside\s+(?:the|this|our)\s+(?:project|repo|repository|workspace)\b|\b(?:saya|aku|kami)\s+(?:tidak|nggak|gak|ga)\s+(?:bisa|dapat|boleh|akan)\b|\btidak\s+(?:diizinkan|aman)\b|\bmenolak\b|\bdi\s+luar\s+(?:repo|repositori|repository|proyek|project|workspace)\b)/i;

/**
 * The CTO's reply declines the request ("I can't do that", "Saya tidak
 * bisa…", "outside the repository"). Only the opening of the reply is
 * read, and a reply that still hands work to teammates (@mentions) is not
 * a refusal.
 */
export function isRefusalReply(text: string, mentionedAssignees = 0): boolean {
  if (mentionedAssignees > 0) return false;
  return REFUSAL_REPLY.test(text.slice(0, 400));
}

export function classifyChatIntent(text: string): { kind: string; frontend: boolean; backend: boolean; testing: boolean; security: boolean } {
  const t = text.toLowerCase();
  const frontend = /\b(frontend|ui|react|component|page|button|css|tailwind)\b/.test(t);
  const backend = /\b(backend|api|server|database|auth|endpoint|convex)\b/.test(t);
  const testing = /\b(test|qa|e2e|bug|error)\b/.test(t);
  const security = /\b(security|audit|vulnerab|secret)\b/.test(t);

  // Explicit user instruction always wins: "do not create a task" must be
  // honored as chat even when the text contains change verbs.
  if (EXPLICIT_NEGATION.test(text)) {
    return { kind: "chat", frontend, backend, testing, security };
  }
  // Boundary guard (same as worker router): question/advice shapes never
  // become tasks, even when they contain a change verb. Capability/
  // confirmation questions ("can you be X?", "bisa kan?") belong here too.
  if ((QUESTION_SHAPE.test(text) || QUESTION_SHAPE_ID.test(text)) || ADVICE_SHAPE.test(text) || CONFIRMATION_SHAPE.test(text) || DISCUSSION_SHAPE_ID.test(text.trim()) || isSelfReviewRequest(text)) {
    return { kind: "chat", frontend, backend, testing, security };
  }
  const verbs = t.replace(BUAT_PREPOSITION, " ");
  // Read-only analysis without a change verb is chat (audit/research).
  const hasChangeVerb = /\b(buat\w*|tambah\w*|implement|build|create|fix|perbaiki|refactor|update|change|add|remove)\b/i.test(verbs);
  const isReadOnly = /\b(audit|review|research|investigate|analyze|analyse)\b/i.test(t);
  if (isReadOnly && !hasChangeVerb) {
    return { kind: "chat", frontend, backend, testing, security };
  }

  // If command contains impl keywords, treat as task regardless
  const impl = /\b(buatin|buat\w*|tambah\w*|implement|build|create|fix|perbaiki|refactor|update|change|add|remove|migrate|convert|scaffold|setup|install|pindah|konversi|pasang|sesuaikan)\b/.test(verbs);
  return { kind: impl ? "task" : "chat", frontend, backend, testing, security };
}

/**
 * LLM Intent Classifier (plan 016). Structured output mirrors the worker
 * router's IntentResult. Deterministic shapes are a fast path (greeting,
 * explicit negation, question/advice/confirmation); everything else goes here.
 * Invalid output fails closed to `ask`.
 */
export type IntentSubtype =
  | "explanation" | "recommendation" | "research" | "audit"
  | "implementation" | "debugging" | "testing"
  | "continue" | "pause" | "cancel" | "status" | "approve" | "reject"
  | "other";

export interface IntentResult {
  intent: "ask" | "task" | "continue" | "pause" | "cancel" | "status" | "approve" | "reject";
  subtype: IntentSubtype;
  requiresWorkspace: boolean;
  requiresExecution: boolean;
  target?: string;
  confidence: number;
  reasoning: string;
}

const INTENT_SUBTYPES: IntentSubtype[] = [
  "explanation", "recommendation", "research", "audit",
  "implementation", "debugging", "testing", "other",
];

export function parseIntentResult(raw: string): IntentResult | null {
  const text = raw.trim();
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) return null;
  try {
    const o = JSON.parse(json[0]) as Partial<IntentResult>;
    if (o.intent !== "ask" && o.intent !== "task") return null;
    const subtype: IntentSubtype = INTENT_SUBTYPES.includes(o.subtype as IntentSubtype)
      ? (o.subtype as IntentSubtype)
      : "other";
    if (typeof o.confidence !== "number") o.confidence = 0.5;
    o.confidence = Math.max(0, Math.min(1, o.confidence));
    return {
      intent: o.intent,
      subtype,
      requiresWorkspace: Boolean(o.requiresWorkspace),
      requiresExecution: o.intent === "task" ? true : Boolean(o.requiresExecution),
      target: typeof o.target === "string" ? o.target : undefined,
      confidence: o.confidence,
      reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
    };
  } catch {
    return null;
  }
}

/**
 * True when the text has a deterministic ASK shape: an explicit "no task"
 * instruction, or a question/advice/confirmation shape. Such text never
 * becomes a task, whatever change verbs it contains.
 */
export function hasAskShape(text: string): boolean {
  return (
    EXPLICIT_NEGATION.test(text) ||
    (QUESTION_SHAPE.test(text) || QUESTION_SHAPE_ID.test(text)) ||
    ADVICE_SHAPE.test(text) ||
    CONFIRMATION_SHAPE.test(text) ||
    DISCUSSION_SHAPE_ID.test(text.trim()) ||
    isSelfReviewRequest(text)
  );
}

/** The chat "I choose A: …" reply to an options block. */
export function isOptionPick(text: string): boolean {
  return /^i choose ([a-z0-9]+)\s*:\s*(.+)$/i.test(text.trim());
}
