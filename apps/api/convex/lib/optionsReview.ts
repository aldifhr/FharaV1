/**
 * Options review: a role-agnostic "pick between these" primitive (pure;
 * shared by Convex, the worker and the web card).
 *
 * An agent with the `options` permission calls `show_options` with 1–6
 * options (plus optional reference options that cannot be picked). Each
 * option's body is one of:
 *  - html: a static HTML + CSS page, validated and sanitized by the worker,
 *    rendered to a PNG with scripts off, shown sandboxed (srcdoc, no
 *    scripts, CSP default-src 'none');
 *  - image: a picture (stored in Convex file storage);
 *  - markdown: trade-off text or tables.
 * The user picks any number or none, writes a note per option and a reply.
 * The draft is saved separately from the submit: closing the card never
 * sends anything.
 *
 * Draft validation, the reply text and the "passed over" line are ported
 * from threadbear (MIT, Copyright (c) 2026 Mike Cann):
 * runner/src/reviews.ts `reviewDraft` / `reviewReply` / `sameDraft` and
 * app/Sources/ThreadbearCore/Protocol/DesignReview.swift `canSubmit`.
 * Modified by Fhara: option bodies are typed (html | image | markdown),
 * notes are an array (Convex field names), reviews carry role + purpose,
 * and the reply also goes into the task brief. See THIRD_PARTY_NOTICES.md.
 */

export const OPTIONS_REVIEW_PURPOSES = ["design", "architecture", "schema", "research", "deploy", "other"] as const;
export type OptionsReviewPurpose = (typeof OPTIONS_REVIEW_PURPOSES)[number];

export const OPTION_KINDS = ["html", "image", "markdown"] as const;
export type OptionKind = (typeof OPTION_KINDS)[number];

export const OPTIONS_REVIEW_LIMITS = {
  titleMax: 200,
  noteMax: 4_000,
  replyMax: 8_000,
  optionIdMax: 40,
  /** Pickable options per review. */
  optionsMax: 6,
  /** Reference options (cannot be picked) per review. */
  referencesMax: 2,
  markdownMax: 20_000,
  /** Sanitized HTML stored per option. */
  htmlMax: 200_000,
  routeMax: 300,
} as const;

export type OptionsReviewStatus = "pending" | "answered" | "auto" | "cancelled";

/** One option as stored (after the worker validated and sanitized it). */
export interface StoredReviewOption {
  id: string;
  title: string;
  note?: string;
  reference?: boolean;
  kind: OptionKind;
  /** kind html: the SANITIZED page (never the agent's raw output). */
  html?: string;
  /** kind markdown. */
  markdown?: string;
  /** kind image, or the PNG render of an html option. */
  imageStorageId?: string;
  /** Validator findings that were fixed by the sanitizer (warnings). */
  findings?: string[];
}

export interface ReviewDraft {
  pickedIds: string[];
  notes: Array<{ optionId: string; note: string }>;
  reply?: string;
  none?: boolean;
}

export const EMPTY_DRAFT: ReviewDraft = { pickedIds: [], notes: [] };

type OptionLike = { id: string; title: string; reference?: boolean };
type ReviewLike = { title: string; options: readonly OptionLike[] };

function text(value: unknown, name: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${name} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${name} must be text`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`${name} is required`);
  if (trimmed.length > max) throw new Error(`${name} must be at most ${max} characters`);
  return trimmed || undefined;
}

export function isPurpose(value: unknown): value is OptionsReviewPurpose {
  return typeof value === "string" && (OPTIONS_REVIEW_PURPOSES as readonly string[]).includes(value);
}

/**
 * Structural checks on a review the worker is about to store. Body content
 * (HTML safety) is the worker's validator's job; this guards shape, ids,
 * counts and the recommended option. Throws a plain reason.
 */
export function validateReviewShape(input: {
  title: unknown;
  note?: unknown;
  purpose: unknown;
  recommended?: unknown;
  route?: unknown;
  options: ReadonlyArray<{ id: unknown; title: unknown; note?: unknown; reference?: unknown; kind: unknown; html?: unknown; markdown?: unknown; imageStorageId?: unknown }>;
}): { title: string; note?: string; purpose: OptionsReviewPurpose; recommended?: string; route?: string } {
  const L = OPTIONS_REVIEW_LIMITS;
  const title = text(input.title, "title", L.titleMax, true)!;
  const note = text(input.note, "note", L.noteMax);
  if (!isPurpose(input.purpose)) throw new Error(`purpose must be one of ${OPTIONS_REVIEW_PURPOSES.join(", ")}`);
  const route = text(input.route, "route", L.routeMax);
  if (route && !/^\/[^\s]*$/.test(route)) throw new Error("route must be an app path starting with /");
  if (!Array.isArray(input.options) || input.options.length === 0) throw new Error("A review needs options");
  const ids = new Set<string>();
  let pickable = 0;
  let references = 0;
  for (const [i, option] of input.options.entries()) {
    const id = text(option.id, `options[${i}].id`, L.optionIdMax, true)!;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error(`Option id "${id}" may use letters, digits, - and _ only`);
    if (ids.has(id)) throw new Error(`Duplicate option id: ${id}`);
    ids.add(id);
    text(option.title, `Option ${id} title`, L.titleMax, true);
    text(option.note, `Option ${id} note`, L.noteMax);
    if (option.reference !== undefined && typeof option.reference !== "boolean") throw new Error("reference must be true or false");
    if (option.reference === true) references++;
    else pickable++;
    if (!(OPTION_KINDS as readonly unknown[]).includes(option.kind)) throw new Error(`Option ${id}: kind must be html, image or markdown`);
    if (option.kind === "html" && (typeof option.html !== "string" || !option.html.trim())) throw new Error(`Option ${id}: html is empty`);
    if (option.kind === "html" && String(option.html).length > L.htmlMax) throw new Error(`Option ${id}: html is over ${L.htmlMax} characters`);
    if (option.kind === "markdown") text(option.markdown, `Option ${id} markdown`, L.markdownMax, true);
    if (option.kind === "image" && (typeof option.imageStorageId !== "string" || !option.imageStorageId)) {
      throw new Error(`Option ${id}: image is missing`);
    }
  }
  if (pickable === 0) throw new Error("A review needs at least one option that can be picked");
  if (pickable > L.optionsMax) throw new Error(`At most ${L.optionsMax} options (got ${pickable})`);
  if (references > L.referencesMax) throw new Error(`At most ${L.referencesMax} reference options`);
  const recommended = text(input.recommended, "recommended", L.optionIdMax);
  if (recommended) {
    const option = input.options.find((o) => o.id === recommended);
    if (!option) throw new Error(`recommended must be one of the option ids: ${recommended}`);
    if (option.reference === true) throw new Error("recommended cannot be a reference option");
  }
  return { title, ...(note ? { note } : {}), purpose: input.purpose, ...(recommended ? { recommended } : {}), ...(route ? { route } : {}) };
}

/**
 * Normalize a draft against the review (threadbear reviewDraft): picks in
 * the review's order, no reference picks, not both picks and none, notes
 * only for known options. `answer` additionally requires something to send.
 */
export function normalizeDraft(review: ReviewLike, raw: unknown, answer = false): ReviewDraft {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("draft must be an object");
  const d = raw as Record<string, unknown>;
  const L = OPTIONS_REVIEW_LIMITS;
  const pickedRaw = d.pickedIds ?? [];
  if (!Array.isArray(pickedRaw) || pickedRaw.some((id) => typeof id !== "string")) throw new Error("pickedIds must be a list of option ids");
  const wanted = new Set(pickedRaw as string[]);
  for (const id of wanted) {
    const option = review.options.find((o) => o.id === id);
    if (!option) throw new Error(`Unknown option: ${id}`);
    if (option.reference) throw new Error("A reference option cannot be picked");
  }
  const pickedIds = review.options.filter((o) => wanted.has(o.id)).map((o) => o.id);
  if (d.none !== undefined && typeof d.none !== "boolean") throw new Error("none must be true or false");
  const none = d.none === true;
  if (none && pickedIds.length) throw new Error("Pick options or none of them, not both");
  const notesRaw = d.notes ?? [];
  if (!Array.isArray(notesRaw)) throw new Error("notes must be a list");
  const notes: ReviewDraft["notes"] = [];
  for (const entry of notesRaw) {
    if (!entry || typeof entry !== "object") throw new Error("Each note needs optionId and note");
    const { optionId, note } = entry as { optionId?: unknown; note?: unknown };
    if (typeof optionId !== "string" || !review.options.some((o) => o.id === optionId)) throw new Error(`Unknown option: ${String(optionId)}`);
    const clean = text(note, `Note on ${optionId}`, L.noteMax);
    if (clean && !notes.some((n) => n.optionId === optionId)) notes.push({ optionId, note: clean });
  }
  notes.sort((a, b) => review.options.findIndex((o) => o.id === a.optionId) - review.options.findIndex((o) => o.id === b.optionId));
  const reply = text(d.reply, "reply", L.replyMax);
  if (answer && !pickedIds.length && !none && !reply && !notes.length) throw new Error("Pick an option or write a reply");
  return { pickedIds, notes, ...(reply ? { reply } : {}), ...(none ? { none: true } : {}) };
}

/** Client-side guard for the Send button (the server validates again). */
export function canSubmit(review: ReviewLike, draft: ReviewDraft): boolean {
  try {
    normalizeDraft(review, draft, true);
    return true;
  } catch {
    return false;
  }
}

export function sameDraft(a: ReviewDraft | undefined, b: ReviewDraft): boolean {
  if (!a) return false;
  if (a.pickedIds.join("\n") !== b.pickedIds.join("\n")) return false;
  if ((a.reply ?? "") !== (b.reply ?? "") || !!a.none !== !!b.none) return false;
  return a.notes.length === b.notes.length && a.notes.every((n, i) => n.optionId === b.notes[i].optionId && n.note === b.notes[i].note);
}

/** threadbear PASSED_OVER_TAIL. */
export const PASSED_OVER_TAIL =
  "Don't offer one of these later (a next step, a follow-up) as if it were new: say it's one they passed over.";

/**
 * What the agent reads after the user answered (threadbear reviewReply):
 * "Picked A." / "Picked A + C.", the reply, notes per option, and the
 * options passed over.
 */
export function reviewReplyText(review: ReviewLike & { recommended?: string }, draft: ReviewDraft, opts: { auto?: boolean } = {}): string {
  const lines = [`Review: ${review.title}`];
  const titleOf = (id: string) => review.options.find((o) => o.id === id)?.title ?? id;
  if (opts.auto) lines.push("Reviews are set to skip for this project and role, so the recommended option was picked automatically.");
  if (draft.pickedIds.length) lines.push(`Picked ${draft.pickedIds.join(" + ")}. ${draft.pickedIds.map(titleOf).join(" + ")}.`);
  if (draft.none) lines.push("Picked none of them.");
  if (draft.reply) lines.push(draft.reply);
  for (const n of draft.notes) lines.push(`Notes on ${n.optionId} (${titleOf(n.optionId)}): ${n.note}`);
  const passed = draft.pickedIds.length ? review.options.filter((o) => !o.reference && !draft.pickedIds.includes(o.id)) : [];
  if (passed.length) lines.push(`Passed over: ${passed.map((o) => `${o.id}. ${o.title}`).join("; ")}. ${PASSED_OVER_TAIL}`);
  return lines.join("\n\n");
}

/** The draft an auto-picked review records: the recommended option, else the first pickable one. */
export function autoPickDraft(review: ReviewLike & { recommended?: string }): ReviewDraft {
  const pick = review.recommended ?? review.options.find((o) => !o.reference)?.id;
  return { pickedIds: pick ? [pick] : [], notes: [] };
}

/** Whether a project skips reviews for a role (off by default: reviews ask). */
export function skipsOptionsReview(project: { optionsReviewSkipRoles?: readonly string[] | null } | null | undefined, role: string | undefined): boolean {
  const key = (role ?? "").trim().toLowerCase();
  return Boolean(key && project?.optionsReviewSkipRoles?.some((r) => r.trim().toLowerCase() === key));
}

/**
 * Cheap server-side backstop for stored HTML: the worker's validator and
 * sanitizer are the real gate; this refuses anything that still carries a
 * script, an event handler or a javascript: URL, so a buggy or old worker
 * can never store an active page.
 */
export function htmlLooksActive(html: string): string | null {
  if (/<\s*script\b/i.test(html)) return "a script element";
  if (/<[^>]*\son[a-z]+\s*=/i.test(html)) return "an event handler attribute";
  if (/=\s*["']?\s*(?:java|vb)script\s*:/i.test(html) || /url\(\s*["']?\s*(?:java|vb)script\s*:/i.test(html)) return "a javascript: URL";
  if (/<\s*(?:iframe|object|embed|frame|frameset|base|form)\b/i.test(html)) return "an embedding or form element";
  if (/<\s*meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(html)) return "a meta refresh";
  return null;
}

/** CSP for every option preview (srcdoc iframe and the worker's PNG render). */
export const OPTION_PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/**
 * The document an html option is shown as: the sanitized page with the
 * CSP meta as the first element of its head. Shown only in an iframe with
 * `sandbox=""` (no scripts, no same-origin) via srcdoc.
 */
export function previewDocument(sanitizedHtml: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${OPTION_PREVIEW_CSP}">`;
  const head = /<head(\s[^>]*)?>/i.exec(sanitizedHtml);
  if (head) {
    const at = head.index + head[0].length;
    return `${sanitizedHtml.slice(0, at)}${meta}${sanitizedHtml.slice(at)}`;
  }
  return `<!doctype html><html><head>${meta}<meta charset="utf-8"></head><body>${sanitizedHtml}</body></html>`;
}
