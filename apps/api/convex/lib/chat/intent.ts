/**
 * Chat intent detection: deterministic shapes (fast path) and the parser for
 * the LLM intent classifier's structured output. Pure — no Convex or Node
 * APIs — so it is unit-testable and safe to import from any runtime.
 */

import { isSystemLine } from "../systemLine";
import { detectChatRunCommands, explicitRunCommand } from "./runRequest";
import { findBuiltinSlash } from "../slashCommands";
import { isPoliteWriteRequest } from "./offerBrief";

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
  // "can you create file index.html": polite, but a request for concrete work (an offer, never a start).
  if (isPoliteWriteRequest(text)) return { kind: "task", frontend, backend, testing, security };
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
  if (!EXPLICIT_NEGATION.test(text) && isPoliteWriteRequest(text)) return false;
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

// ---------------------------------------------------------------------------
// Explicit task starts (chat never starts a task by itself).
//
// A task starts only from the Create task button, an explicit command
// ("/task …", or a message that opens with a go word such as "kerjakan …"),
// or a bare go reply ("gas", "lanjut", "ok kerjakan") right after a CTO reply
// that offered Create task. Everything else is chat: the regex/LLM
// classifier only shapes the reply (answer vs plan proposal with the button).
// ---------------------------------------------------------------------------

/** Words that, opening a message, make it an explicit order to start a task. */
export const EXPLICIT_GO_WORDS = ["kerjakan", "jalankan", "eksekusi", "do it", "run this"] as const;

const SLASH_TASK = /^\/task\s+([\s\S]+)$/i;
// O7: "/research <question>" is an explicit order too; the marker stays on
// the task command so the planner builds the research fan-out. Detected via
// the shared slash registry (lib/slashCommands.ts, Paradev C1).
function isResearchCommand(text: string): boolean {
  const hit = findBuiltinSlash(text);
  return hit?.command.name === "research" && hit.args.length > 0;
}
const GO_PREFIX = /^(kerjakan|jalankan|eksekusi|do it|run this)(?=$|[\s:,.!\-–—])[\s:,.!\-–—]*([\s\S]*)$/i;
// "kata AI Agent saya …", "dia bilang …", "katanya …": the user is relaying
// someone else's words, not giving an order.
const RELAYED_SPEECH = /^(kata|katanya|dia bilang|doi bilang|mereka bilang|he said|she said|they said)\b/i;
const QUOTE_START = /^[>"“”'‘’`]/;

/**
 * Pasted or relayed content: multi-line text, a quote/code block, or a line
 * that opens with "kata …" / "dia bilang …". Never a command, even when it
 * contains a go word or change verbs.
 */
export function isPastedContent(text: string): boolean {
  const t = text.trim();
  return /\n/.test(t) || t.includes("```") || QUOTE_START.test(t) || RELAYED_SPEECH.test(t);
}

/**
 * The task text when the message is an explicit command, else null:
 *   "/task <text>"                          → <text> (always honored)
 *   "/research <question>"                  → the whole line (research fan-out, O7)
 *   "kerjakan|jalankan|eksekusi|do it|run this <text>" → <text>
 * A go-word message is not a command when it is pasted/relayed content, a
 * question (ends with "?"), or carries an explicit "no task" instruction.
 * A bare go word with no text is a go reply (see isGoReply), not a command.
 */
export function explicitTaskCommand(text: string): string | null {
  const t = text.trim();
  const slash = SLASH_TASK.exec(t);
  if (slash) return slash[1].trim() || null;
  if (isResearchCommand(t)) return t;
  if (isPastedContent(t) || /\?\s*$/.test(t) || EXPLICIT_NEGATION.test(t)) return null;
  // A run order ("jalankan tes", "run npm test", "run the tests") keeps its
  // run verb: the worker classifier (detectRunCommands) plans a shell task
  // from "jalankan tes", but would read the bare "tes" as something else.
  const run = explicitRunCommand(t);
  if (run) return run;
  const go = GO_PREFIX.exec(t);
  if (!go) return null;
  const rest = go[2].trim();
  return rest ? rest : null;
}

const GO_REPLY =
  /^(?:(?:(?:ok(?:e|ay)?|sip|ya|yes|yup|siap|y)[\s,]+)?(?:gas+(?:kan)?|lanjut(?:kan)?|go|kerjakan|jalankan|eksekusi|do it|run it|run this|let'?s go|ship it)|ok(?:e|ay)?|yes|yep|yup|ya|iya|sure|sip|siap)(?:\s+(?:aja|ya|dong|sekarang|now|please|bro|kak))?[\s!.]*$/i;

/** A bare short go reply ("gas", "lanjut", "ok kerjakan", "yes do it"). */
export function isGoReply(text: string): boolean {
  const t = text.trim();
  return t.length <= 32 && GO_REPLY.test(t);
}

/** The CTO's "Create task" offer — same rule as the button in the web chat. */
const OFFERS_CREATE_TASK = /\b(create|bikin|buat)\s+task\b/i;
const OPTION_PICK = /^i choose\s+[a-z0-9]+\s*:\s*(.+)$/i;

export interface OfferedTask {
  /** Index of the CTO reply that offered Create task, in `history`. */
  index: number;
  /** The task command, composed exactly like the Create task button does. */
  command: string;
  title?: string;
  /** The offering reply (its @mentions become the assignees). */
  reply: string;
  /** Assignee stored on the offer (messages.taskOffer.assigneeAgentId). */
  assigneeAgentId?: string;
  /** The prefilled task brief (plan line + request, lib/chat/offerBrief.ts); the task command when set. */
  brief?: string;
}

/**
 * A follow-up that reacts to the conversation instead of asking for work:
 * "kok bikin task?", "kenapa begitu?", a bare go word, punctuation only.
 * Never the request a Create task offer answers.
 */
const META_FOLLOW_UP =
  /^(?:kok|kenapa|knp|ngapain|mengapa|why|how come|loh|lho|lah|hah|eh|wait|tunggu|maksud(?:nya)?|apa maksud(?:nya)?|serius|beneran)\b/i;
export function isMetaFollowUp(text: string): boolean {
  const t = text.trim();
  if (!t || /^[\s.?!…,]+$/.test(t)) return true;
  if (isGoReply(t) || OPTION_PICK.test(t)) return true;
  return META_FOLLOW_UP.test(t);
}

const OVERLAP_STOPWORDS = new Set(
  (
    "yang dan atau untuk dengan saya aku kita kami kamu anda dia bisa nggak gak tidak ini itu ada aja dong ya juga " +
    "buat bikin tolong mau akan sudah belum lagi kalau kalo jadi supaya agar dari pada oleh nya the and for with you " +
    "your this that can could please make add want will would should are was have has not just into from bilang kata"
  ).split(" ")
);
function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !OVERLAP_STOPWORDS.has(w))
  );
}

/** "dia bilang: buat halaman FAQ" → "buat halaman FAQ" (titles only). */
function stripRelayPrefix(text: string): string {
  return text.replace(/^(?:kata|katanya|dia bilang|doi bilang|mereka bilang|he said|she said|they said)\s*[:,-]?\s*/i, "").trim();
}

/** A slash command ("/research 3 …", "/task …") ran on its own; never the request an offer answers. */
const SLASH_COMMAND = /^\/[a-z][\w-]*\b/i;

/**
 * The user request a CTO offer (at `offerIndex`) answers. Walks back over
 * the user's messages before the offer (at most 6), skipping meta
 * follow-ups ("kok bikin task?") and slash commands ("/research 3 …").
 *
 * The nearest real request wins when no agent has replied since it: the
 * offer is the CTO's answer to it (the latest "Add a footer…" turn, never an
 * earlier "/research …" that merely shares a word with the offer). Only when
 * the nearest request was already answered (the offer follows a meta
 * follow-up, as in "kok bikin task?") does word overlap pick the request:
 * the one whose words the offer shares most (ties: the nearest). With no
 * overlap anywhere, the nearest real request. "" when there is none — the
 * offer then stands alone.
 */
export function requestAnsweredByOffer(
  history: Array<{ authorType: string; content: string }>,
  offerIndex: number
): string {
  const offerWords = contentWords(history[offerIndex]?.content ?? "");
  let best = "";
  let bestScore = 0;
  let nearest = "";
  let seen = 0;
  let agentSince = false;
  for (let j = offerIndex - 1; j >= 0 && seen < 6; j -= 1) {
    const m = history[j];
    if (m.authorType !== "user") {
      if (m.authorType === "agent" && m.content?.trim()) agentSince = true;
      continue;
    }
    seen += 1;
    const text = m.content.trim();
    if (isMetaFollowUp(text) || SLASH_COMMAND.test(text)) continue;
    // The latest real request with no reply before the offer: the offer answers it.
    if (!nearest && !agentSince) return text;
    if (!nearest) nearest = text;
    let score = 0;
    for (const w of contentWords(text)) if (offerWords.has(w)) score += 1;
    if (score > bestScore) {
      best = text;
      bestScore = score;
    }
  }
  return best || nearest;
}

/** The server-detected Create task offer stored on a CTO reply (messages.taskOffer). */
export interface ChatTaskOffer {
  kind: string;
  commands?: string[];
  /** The task created from this offer; a used offer offers nothing more. */
  usedTaskId?: string;
  usedAt?: number;
  /** The agent the offered task goes to (an @mentioned code role, or the role the request's files belong to). */
  assigneeAgentId?: string;
  /** The prefilled task brief (plan line + request, lib/chat/offerBrief.ts); the task command when set. */
  brief?: string;
}

/** Whether a reply's Create task offer already produced a task. */
export function isOfferUsed(offer: ChatTaskOffer | null | undefined): boolean {
  return Boolean(offer?.usedTaskId);
}

/** The task command a run-request offer starts: the run verb + the exact lines. */
export function runOfferCommand(commands: string[]): string {
  return `jalankan ${commands.join(" && ")}`;
}

/**
 * The Create task command for a CTO reply, composed for both the button
 * (apps/web ChatPanel) and a bare go reply: an option pick right before the
 * reply, else the user request the reply answers (requestAnsweredByOffer),
 * then the reply itself. The title comes from the request, never from a
 * meta follow-up such as "kok bikin task?".
 */
export function composeOfferedTask(
  history: Array<{ authorType: string; content: string; taskOffer?: ChatTaskOffer }>,
  offerIndex: number
): { command: string; title?: string; pick?: string } {
  const reply = (history[offerIndex]?.content ?? "").trim();
  // A run request ("tolong jalankan tes"): the task is exactly the commands
  // the server detected, with the run verb the worker classifier keys on.
  // The CTO's prose (which may carry change verbs) stays out of it.
  const runCommands = history[offerIndex]?.taskOffer?.commands;
  if (runCommands && runCommands.length > 0) {
    const ask = requestAnsweredByOffer(history, offerIndex);
    const title = (ask ? stripRelayPrefix(ask) || ask : runOfferCommand(runCommands)).split("\n")[0].trim().slice(0, 80) || undefined;
    return { command: runOfferCommand(runCommands), title };
  }
  let prevUser: string | null = null;
  for (let j = offerIndex - 1; j >= 0; j -= 1) {
    if (history[j].authorType === "user") {
      prevUser = history[j].content.trim();
      break;
    }
  }
  const pick = prevUser?.match(OPTION_PICK)?.[1]?.trim();
  if (pick) return { command: [`Chosen option: ${pick}`, reply].filter(Boolean).join("\n\n"), title: `Implement ${pick}`.slice(0, 80), pick };
  const ask = requestAnsweredByOffer(history, offerIndex);
  const titleSource = ask ? stripRelayPrefix(ask) || ask : reply;
  const title = titleSource.split("\n")[0].trim().slice(0, 80) || undefined;
  // A prefilled brief (plan line + the request) is the task as offered.
  const brief = history[offerIndex]?.taskOffer?.brief?.trim();
  if (brief) return { command: brief, title };
  return { command: [ask, reply].filter(Boolean).join("\n\n"), title };
}

/**
 * The task a bare go reply starts: the agent reply right before the user's
 * latest message (System lines skipped) that offered Create task. Mirrors `suggestTaskId` + `createTaskFromMessage` in the web
 * chat, so "gas" does exactly what clicking the button would. Null when the
 * latest message is not preceded by such an offer.
 */
export function findOfferedTask(
  history: Array<{ authorType: string; content: string; agentId?: string; voice?: string; taskOffer?: ChatTaskOffer }>,
  roleOf: (agentId: string | undefined) => string | undefined
): OfferedTask | null {
  const last = history.length - 1;
  if (last < 1 || history[last].authorType !== "user") return null;
  for (let i = last - 1; i >= 0; i -= 1) {
    const m = history[i];
    if (m.authorType === "user") return null;
    if (m.authorType !== "agent" || !m.content?.trim()) continue;
    // System lines (routing, task created) are not replies.
    if (isSystemLine(m) || !m.agentId) continue;
    // O3: the nearest reply decides. It offers a task through its
    // server-stored offer (the owner System routed to, or an @mentioned
    // agent), as the answer to an option pick, or (pre-O3 CTO rows without
    // a stored offer) through the CTO's Create task wording.
    const isCto = String(roleOf(m.agentId) ?? "").trim().toLowerCase() === "cto";
    let prevUser: string | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (history[j].authorType === "user") {
        prevUser = history[j].content.trim();
        break;
      }
    }
    // The offer already became a task (button or an earlier go reply).
    if (isOfferUsed(m.taskOffer)) return null;
    const pick = prevUser?.match(OPTION_PICK)?.[1];
    if (!pick && !m.taskOffer && !(isCto && OFFERS_CREATE_TASK.test(m.content))) return null;
    const { command, title } = composeOfferedTask(history, i);
    const assigneeAgentId = m.taskOffer?.assigneeAgentId ?? (isCto ? undefined : m.agentId);
    return { index: i, command, title, reply: m.content, ...(assigneeAgentId ? { assigneeAgentId } : {}) };
  }
  return null;
}

/**
 * A task command that only makes sense with the chat before it: it points
 * back ("kerjakan yang tadi", "do that", "itu aja") or is a bare verb
 * ("buatin", "push"). A self-contained command ("buat halaman login,
 * register, logout") gets no earlier chat turns appended to it.
 */
const BACK_REFERENCE =
  /\b(?:yang tadi|tadi|barusan|di atas|sebelumnya|tersebut|itu|ini|that|this|it|above|previous|earlier|same)\b/i;
const BARE_COMMAND = /^(?:git pull|pull|push|checkout|buatin|buat|bikin|bikinin|lakukan|do it|continue)[\s!.]*$/i;
export function commandNeedsChatContext(command: string): boolean {
  const t = command.trim();
  if (!t) return false;
  if (BARE_COMMAND.test(t)) return true;
  // A run order ("jalankan tes itu") carries its own subject: the commands.
  if (detectChatRunCommands(t)) return false;
  // Long commands carry their own subject.
  if (t.length >= 60 || /\n/.test(t)) return false;
  return BACK_REFERENCE.test(t);
}

// ---------------------------------------------------------------------------
// Write requests in chat (create or change files). Chat cannot write files:
// the reply is a short "this will be a task" line plus the Create task offer,
// never the whole file pasted into the bubble (live transcript 2026-11-11:
// "@Frontend tolong buatkan bold.html …" got a full HTML dump).
// ---------------------------------------------------------------------------

/** The user explicitly wants the code shown in chat ("tampilkan kodenya", "show me the code", "contoh kode"). */
const CODE_IN_CHAT =
  /\b(?:show|paste|give|send|print)\s+(?:me\s+)?(?:the\s+)?(?:code|snippet|source)\b|\b(?:code|snippet)\s+(?:here|in (?:the )?chat)\b|\b(?:tampilkan|tunjukkan|tunjukin|kasih|kirim|tulis(?:kan)?)\s+(?:aja\s+)?(?:kode|kodenya|code|codenya|snippet)\b|\bcontoh\s+(?:kode|code)\b|\b(?:kode|code)(?:nya)?\s+(?:aja|saja|di\s*(?:sini|chat))\b|\bjust (?:the )?code\b/i;
export function wantsCodeInChat(text: string): boolean {
  return CODE_IN_CHAT.test(text);
}

const FRONTEND_FILE = /\.(?:html?|css|scss|sass|less|jsx|tsx|vue|svelte)\b/i;
const FRONTEND_WORDS = /\b(?:html|css|tailwind|halaman|page|landing|ui|komponen|component|button|tombol|tampilan|layout|frontend|website|web\s*page|background|font|warna|color|style)\b/i;
const BACKEND_FILE = /\.(?:sql|prisma|go|py|rs|java|rb|php)\b/i;
const BACKEND_WORDS = /\b(?:api|endpoint|server|database|db|schema|migration|migrasi|backend|auth|query|mutation|convex|cron|webhook)\b/i;

/**
 * The role a write request's work belongs to, read from its files and words:
 * "buatkan ultimate.html …" → frontend, "tambah endpoint /users" → backend.
 * Null when it is not clear (the CTO assigns it in the task).
 */
export function codeRoleForRequest(text: string): "frontend" | "backend" | null {
  const fe = FRONTEND_FILE.test(text) ? 2 : FRONTEND_WORDS.test(text) ? 1 : 0;
  const be = BACKEND_FILE.test(text) ? 2 : BACKEND_WORDS.test(text) ? 1 : 0;
  if (fe === 0 && be === 0) return null;
  if (fe === be) return null;
  return fe > be ? "frontend" : "backend";
}
