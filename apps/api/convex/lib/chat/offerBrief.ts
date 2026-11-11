/**
 * The concrete Create task offer for a chat write request (chat-offer lane).
 * Pure: no Convex or Node APIs.
 *
 * Live screenshot 2026-11-12: "can you create file index.html" was routed to
 * Frontend, which listed `.` and answered "I can't write files from this
 * read-only session. Create a task for the worker…" and asked for the stack.
 * Now the role makes the offer itself: it infers the stack from the repo
 * (empty or no framework = plain HTML), states a one-line plan, and the reply
 * carries the Create task offer with a prefilled brief. "gas"/"lanjut"/"yes"
 * /"ok" right after it starts exactly that brief.
 */

/** A polite or question-shaped ask that still names concrete work: "can you create file index.html". */
const POLITE_LEAD =
  /^(?:(?:hey|hi|halo|hai|ok(?:e|ay)?|so)[\s,]+)?(?:please[\s,]+)?(?:(?:can|could|would|will)\s+(?:you|u)|(?:kamu|kau|lo|lu)?\s*bisa(?:\s*(?:tolong|minta|gak|nggak|ga|kah))?|tolong|minta|mohon)\s+(?:please\s+|tolong\s+)?/i;
const WRITE_VERB =
  /^(?:create|make|add|write|build|generate|scaffold|set\s*up|setup|update|change|edit|fix|remove|delete|rename|buat\w*|bikin\w*|tambah\w*|tulis\w*|ubah\w*|ganti\w*|perbaiki|hapus\w*|edit\w*)\b/i;
/** A file name with an extension ("index.html", "src/app.tsx"). */
const FILE_NAME = /(?:^|[\s"'`(])((?:[\w.-]+\/)*[\w-]+(?:\.[\w-]+)*\.[a-z][a-z0-9]{0,5})(?=$|[\s"'`),;:?!]|\.(?:\s|$))/i;
/** A named thing to build: "a login page", "the navbar component", "halaman login". */
const NAMED_TARGET =
  /\b(?!(?:a|an|the|new|some|any|baru)\b)[a-z][\w-]+\s+(?:page|component|endpoint|route|section|modal|form|script|function|file|halaman|komponen|fungsi)\b|\b(?:halaman|komponen|fungsi|file|page)\s+(?!(?:yang|baru|apa|ini|itu)\b)[a-z][\w.-]+/i;
const NOT_A_REQUEST = /\b(how|why|what|when|where|which|explain|bagaimana|gimana|kenapa|mengapa|apa itu|jelaskan)\b/i;

/** "can you create file index.html" / "bisa buatkan halaman login?" — a write request, never a capability question. */
export function isPoliteWriteRequest(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 300 || /\n/.test(t) || NOT_A_REQUEST.test(t)) return false;
  const lead = POLITE_LEAD.exec(t);
  if (!lead) return false;
  const rest = t.slice(lead[0].length);
  if (!WRITE_VERB.test(rest)) return false;
  return FILE_NAME.test(rest) || NAMED_TARGET.test(rest);
}

/** The first file the request names ("index.html"), or null. */
export function requestedFile(text: string): string | null {
  const m = FILE_NAME.exec(text);
  return m ? m[1].replace(/^\.\//, "") : null;
}

const STACKS: Array<[RegExp, string]> = [
  [/"next"\s*:|\bnext\.config\.(?:js|mjs|ts)\b/, "Next.js"],
  [/"nuxt"\s*:|\bnuxt\.config\./, "Nuxt"],
  [/"astro"\s*:|\bastro\.config\./, "Astro"],
  [/"@sveltejs\/kit"\s*:|"svelte"\s*:|\bsvelte\.config\./, "Svelte"],
  [/"vue"\s*:/, "Vue"],
  [/"react"\s*:[\s\S]*"vite"\s*:|"vite"\s*:[\s\S]*"react"\s*:/, "React/Vite"],
  [/"react"\s*:/, "React"],
  [/"vite"\s*:|\bvite\.config\./, "Vite"],
];

/**
 * The project's web stack from what the reply saw (repo snapshot, list_files
 * results). An empty repo, or one with no framework, is plain HTML.
 */
export function inferStack(...sources: Array<string | null | undefined>): string {
  const text = sources.filter(Boolean).join("\n");
  for (const [re, name] of STACKS) if (re.test(text)) return name;
  return "plain HTML";
}

const UPDATE_VERB = /\b(update|change|edit|fix|ubah\w*|ganti\w*|perbaiki|edit\w*)\b/i;

/**
 * The one-line plan the offer states, e.g. "I'll add a plain HTML index.html
 * at the repo root." Null when the request names no file (the reply then
 * states its own plan from what it read).
 */
export function offerPlanLine(text: string, stack: string): string | null {
  const file = requestedFile(text);
  if (!file) return null;
  const verb = UPDATE_VERB.test(text) ? "update" : "add";
  // "add tests for main.js": the file is the subject, not the thing to add.
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (verb === "add" && new RegExp(`\\b(?:for|untuk|to|ke|in|di|from|dari|on|of)\\s+(?:the\\s+|file\\s+)?(?:\\./)?${escaped}`, "i").test(text)) return null;
  const where = file.includes("/") ? "" : " at the repo root";
  const isPage = /\.html?$/i.test(file);
  if (verb === "update") return `I'll update ${file}${where ? " (repo root)" : ""}.`;
  if (isPage && stack === "plain HTML") return `I'll add a plain HTML ${file}${where}.`;
  if (isPage) return `I'll add ${file}${where}, using this ${stack} project's setup.`;
  return `I'll add ${file}${where}.`;
}

/** The prefilled task brief: the plan line, then the user's request word for word. */
export function buildOfferBrief(request: string, plan: string | null): string | undefined {
  const ask = request.trim();
  if (!ask) return undefined;
  return plan ? `${plan.replace(/^I'll /, "").replace(/^./, (c) => c.toUpperCase())}\n\nRequest: ${ask}` : undefined;
}

/**
 * A reply that found the request needs file writes and hands it to a task
 * ("Chat can't change files. Want me to create a task for it?"), including
 * the old wording ("read-only session", "create a task for the worker").
 * Used to attach the offer when the intent classifier missed the request.
 */
const REPLY_NEEDS_TASK =
  /\b(?:chat\s+can(?:not|['’]t)\s+(?:change|write|create|modify|edit)\s+files|can(?:not|['’]t)\s+(?:write|create|change|modify|edit)\s+(?:files?|it)\b[^.]*\b(?:chat|session|here)|read-only\s+session|create\s+a\s+task\s+for\s+(?:it|this|the\s+worker)|want\s+me\s+to\s+create\s+a\s+task|(?:chat|di\s+chat)\s+(?:tidak|nggak|gak|ga)\s+bisa\s+(?:mengubah|menulis|membuat|ubah|tulis|bikin)\s+file|mau\s+(?:saya|aku)\s+(?:buatkan|bikinkan)\s+task)\b/i;
export function replyNeedsTask(reply: string): boolean {
  return REPLY_NEEDS_TASK.test(reply);
}

/** The words the reply uses to hand a write over (shared by every chat prompt). */
export const CHAT_CANNOT_WRITE_LINE = "Chat can't change files. Want me to create a task for it?";

/**
 * Prompt rule for a reply that turns out to need file writes (shared by
 * project and personal chat). Never "read-only session", never "create a
 * task yourself", never a question the repo answers.
 */
export function writeNeededGuidance(plan: string | null): string {
  return [
    "If the request needs files created or changed, make a concrete offer instead of telling the user to create a task themselves:",
    "infer the stack from the repo you can see (an empty repo or one with no framework means plain HTML), never ask the user for something the repo answers,",
    plan ? `state the plan in one line ("${plan}"),` : 'state the plan in one line (e.g. "I\'ll add a plain HTML index.html at the repo root."),',
    `then end with "${CHAT_CANNOT_WRITE_LINE}" (in the user's language). Replying "gas" or pressing Create task under your reply starts it.`,
    "Describe the limit in plain words (chat can't change files), never as a mode or a session.",
  ].join(" ");
}
