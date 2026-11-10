/**
 * Tool-call text in chat replies: find it, strip it, and keep it out of the
 * bubble.
 *
 * Models emit tool calls as plain text in several shapes: a bare JSON object
 * on its own line(s), a ```json fence, Hermes/Qwen `<tool_call>…</tool_call>`,
 * LongCat `<longcat_tool_call>…</longcat_tool_call>` (JSON inside, or a tool
 * name followed by `<longcat_arg_key>`/`<longcat_arg_value>` pairs), and
 * sometimes several calls followed by the answer in ONE reply. None of that
 * is ever shown to the user: a grounded reply runs the first call, a reply
 * without tools is retried and then replaced by a short fallback.
 *
 * Pure: no Convex or Node APIs (shared with the worker and unit tests).
 */

export interface ToolCallText {
  tool: string;
  args: Record<string, unknown>;
}

/** Argument aliases models use instead of the protocol names. */
const ARG_ALIASES: Record<string, string> = {
  // read_file window
  maxLines: "lines",
  max_lines: "lines",
  maxlines: "lines",
  limit: "lines",
  numLines: "lines",
  num_lines: "lines",
  lineCount: "lines",
  count: "lines",
  startLine: "start",
  start_line: "start",
  startline: "start",
  from: "start",
  fromLine: "start",
  offset: "start",
  line: "start",
  // paths
  file: "path",
  filepath: "path",
  filePath: "path",
  file_path: "path",
  filename: "path",
  fileName: "path",
  dir: "path",
  directory: "path",
  folder: "path",
  // grep
  query: "pattern",
  regex: "pattern",
  search: "pattern",
  q: "pattern",
  term: "pattern",
  ignore_case: "ignoreCase",
  caseInsensitive: "ignoreCase",
  case_insensitive: "ignoreCase",
  i: "ignoreCase",
  include: "glob",
  filter: "glob",
};

/**
 * Canonical tool arguments: aliases mapped to `path`, `pattern`, `glob`,
 * `ignoreCase`, `start`, `lines`. A canonical key the model also gave wins
 * over its alias. Unknown keys pass through (the worker ignores them).
 */
export function normalizeRepoToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    const canonical = ARG_ALIASES[key] ?? key;
    if (canonical !== key && Object.prototype.hasOwnProperty.call(args, canonical)) continue;
    if (out[canonical] === undefined) out[canonical] = value;
  }
  if (typeof out.ignoreCase === "string") out.ignoreCase = /^(true|1|yes)$/i.test(out.ignoreCase);
  return out;
}

/** A parsed JSON value that is a tool call, or null. */
function toCall(parsed: unknown): ToolCallText | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  // OpenAI-style {"function":{"name":…,"arguments":"{…}"}} / {"type":"function",…}
  const fn = obj.function && typeof obj.function === "object" ? (obj.function as Record<string, unknown>) : null;
  const source = fn ?? obj;
  const name =
    typeof source.tool === "string"
      ? source.tool
      : typeof source.name === "string" &&
          ("arguments" in source || "args" in source || "parameters" in source || "input" in source || fn !== null)
        ? source.name
        : typeof source.tool_name === "string"
          ? source.tool_name
          : "";
  if (!name.trim() || name.length > 60) return null;
  let rawArgs: unknown = source.arguments ?? source.args ?? source.parameters ?? source.input ?? {};
  if (typeof rawArgs === "string") {
    try {
      rawArgs = JSON.parse(rawArgs);
    } catch {
      rawArgs = {};
    }
  }
  const args =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
  return { tool: name.trim(), args: normalizeRepoToolArgs(args) };
}

/** End index (exclusive) of the balanced JSON object starting at `start`, or -1. */
function balancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** The calls in a body that holds only JSON call objects (one or more). */
function callsInJsonBody(body: string): ToolCallText[] | null {
  const calls: ToolCallText[] = [];
  let i = 0;
  const text = body.trim();
  if (!text) return null;
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return null;
      for (const item of parsed) {
        const call = toCall(item);
        if (!call) return null;
        calls.push(call);
      }
      return calls.length ? calls : null;
    } catch {
      return null;
    }
  }
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i += 1;
    if (i >= text.length) break;
    if (text[i] !== "{") return null;
    const end = balancedObjectEnd(text, i);
    if (end < 0) return null;
    try {
      const call = toCall(JSON.parse(text.slice(i, end)));
      if (!call) return null;
      calls.push(call);
    } catch {
      return null;
    }
    i = end;
  }
  return calls.length ? calls : null;
}

/** Body of a `<…tool_call>` tag: JSON, or LongCat/GLM name + arg_key/arg_value pairs. */
function callFromTagBody(body: string): ToolCallText | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  const json = callsInJsonBody(trimmed);
  if (json) return json[0];
  const nameMatch = /^([A-Za-z_][\w.-]*)/.exec(trimmed);
  if (!nameMatch) return null;
  const args: Record<string, unknown> = {};
  const pair = /<(?:[a-z_]+_)?arg_key>([\s\S]*?)<\/(?:[a-z_]+_)?arg_key>\s*<(?:[a-z_]+_)?arg_value>([\s\S]*?)<\/(?:[a-z_]+_)?arg_value>/gi;
  let m: RegExpExecArray | null;
  while ((m = pair.exec(trimmed))) {
    const key = m[1].trim();
    const raw = m[2].trim();
    let value: unknown = raw;
    if (/^-?\d+$/.test(raw)) value = Number(raw);
    else if (/^(true|false)$/i.test(raw)) value = raw.toLowerCase() === "true";
    if (key) args[key] = value;
  }
  return { tool: nameMatch[1], args: normalizeRepoToolArgs(args) };
}

interface Segment {
  start: number;
  end: number;
  calls: ToolCallText[];
}

export interface ExtractedToolCalls {
  /** Every tool call in the reply, in text order. */
  calls: ToolCallText[];
  /** The reply with every tool-call block, fence, tag and stray tag removed. */
  prose: string;
  /** Tool-call markup whose call could not be parsed (stripped, but not runnable). */
  malformed: number;
}

const TAG_BLOCK = /<((?:[a-z_]+_)?tool_calls?)\b[^>]*>([\s\S]*?)(?:<\/\1\s*>|$)/gi;
const STRAY_TAG = /<\/?(?:[a-z_]+_)?tool_calls?\b[^>]*>/gi;
const FENCE = /```[a-zA-Z]*[ \t]*\n?([\s\S]*?)```/g;

/**
 * Find every tool call in a model reply and the prose left without them.
 * A JSON call counts only when it stands on its own line(s) (or in a fence
 * or tag), so prose that merely quotes JSON inline stays prose.
 */
export function extractToolCalls(text: string): ExtractedToolCalls {
  const source = text ?? "";
  const segments: Segment[] = [];
  let malformed = 0;
  const overlaps = (start: number, end: number) => segments.some((s) => start < s.end && end > s.start);

  TAG_BLOCK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_BLOCK.exec(source))) {
    if (m[0].length === 0) {
      TAG_BLOCK.lastIndex += 1;
      continue;
    }
    const closed = /<\/(?:[a-z_]+_)?tool_calls?\s*>$/i.test(m[0]);
    if (!closed) {
      // Unterminated tag: a JSON call right after it is the call; prose after that stays.
      const bodyStart = m.index + m[0].length - m[2].length;
      const brace = bodyStart + (m[2].length - m[2].trimStart().length);
      const end = source[brace] === "{" ? balancedObjectEnd(source, brace) : -1;
      if (end > 0) {
        let call: ToolCallText | null = null;
        try {
          call = toCall(JSON.parse(source.slice(brace, end)));
        } catch {
          call = null;
        }
        if (!call) malformed += 1;
        segments.push({ start: m.index, end, calls: call ? [call] : [] });
        TAG_BLOCK.lastIndex = end;
        continue;
      }
    }
    const call = callFromTagBody(m[2]);
    if (!call) malformed += 1;
    segments.push({ start: m.index, end: m.index + m[0].length, calls: call ? [call] : [] });
  }

  FENCE.lastIndex = 0;
  while ((m = FENCE.exec(source))) {
    const start = m.index;
    const end = start + m[0].length;
    if (overlaps(start, end)) continue;
    const calls = callsInJsonBody(m[1]);
    if (calls) segments.push({ start, end, calls });
  }

  // Bare JSON objects that start a line.
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== "{") continue;
    const lineStart = source.lastIndexOf("\n", i - 1) + 1;
    if (source.slice(lineStart, i).trim() !== "") continue;
    if (overlaps(i, i + 1)) continue;
    const end = balancedObjectEnd(source, i);
    if (end < 0) continue;
    const lineEnd = source.indexOf("\n", end);
    const restEnd = lineEnd < 0 ? source.length : lineEnd;
    const rest = source.slice(end, restEnd).replace(STRAY_TAG, "").trim();
    if (rest !== "" && rest !== ",") continue;
    let call: ToolCallText | null = null;
    try {
      call = toCall(JSON.parse(source.slice(i, end)));
    } catch {
      call = null;
    }
    if (!call) continue;
    // A stray closing tag on the same line belongs to the call.
    segments.push({ start: i, end: restEnd, calls: [call] });
    i = restEnd - 1;
  }

  segments.sort((a, b) => a.start - b.start);
  const calls: ToolCallText[] = [];
  let prose = "";
  let cursor = 0;
  for (const s of segments) {
    if (s.start < cursor) continue;
    prose += source.slice(cursor, s.start);
    calls.push(...s.calls);
    cursor = s.end;
  }
  prose += source.slice(cursor);
  if (STRAY_TAG.test(prose)) malformed += 1;
  STRAY_TAG.lastIndex = 0;
  prose = prose
    .replace(STRAY_TAG, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { calls, prose, malformed };
}

/** Does this (final) reply contain a tool call anywhere? */
export function hasToolCallText(text: string): boolean {
  const { calls, malformed } = extractToolCalls(text);
  return calls.length > 0 || malformed > 0;
}

/** The reply without any tool-call text (what may be shown or persisted). */
export function stripToolCallText(text: string): string {
  return extractToolCalls(text).prose;
}

/**
 * While streaming: could this partial reply still turn out to be a tool
 * call? Such text is not shown in the bubble until it is known to be prose.
 */
export function mayBeToolCall(partial: string): boolean {
  const t = (partial ?? "").trimStart();
  if (!t) return true;
  return t.startsWith("{") || t.startsWith("[{") || t.startsWith("```") || /^<(?:[a-z_]+_)?tool/i.test(t);
}

/**
 * The part of a streaming reply that may be shown now: complete tool calls
 * are removed, and an unfinished one at the tail (a line that opened a JSON
 * object, a fence or a tool tag that has not closed yet) is held back.
 */
export function streamVisibleText(partial: string): string {
  if (mayBeToolCall(partial)) return "";
  let text = stripToolCallText(partial);
  // Hold back an unclosed tool tag (stripToolCallText removed closed ones).
  const tag = text.search(/<(?:[a-z_]+_)?tool/i);
  if (tag >= 0) text = text.slice(0, tag);
  // Hold back an open fence (odd number of ``` marks).
  const fences = text.match(/```/g)?.length ?? 0;
  if (fences % 2 === 1) text = text.slice(0, text.lastIndexOf("```"));
  // Hold back a JSON object that starts a line and has not closed yet.
  const lineObject = /(^|\n)[ \t]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = lineObject.exec(text))) {
    const brace = m.index + m[0].length - 1;
    if (balancedObjectEnd(text, brace) < 0) {
      text = text.slice(0, m.index);
      break;
    }
  }
  return text.trimEnd();
}

/** Extra system line for the one retry of a reply that tried to call a tool without tools. */
export const NO_TOOLS_RETRY_LINE =
  "You have no tools in this reply. Answer in prose; say 'belum saya cek' for anything you cannot confirm.";

/** Rough check that the user writes Indonesian (for fixed fallback copy). */
export function looksIndonesian(text: string): boolean {
  return /\b(apa|berapa|yang|dan|di|ini|itu|saja|aja|tolong|bisa|gimana|bagaimana|kenapa|mana|ada|tidak|nggak|gak|ga|sih|dong|kah|baris|tabel|cek|udah|sudah|belum|kalau|kalo)\b/i.test(
    text ?? ""
  );
}

/** Shown instead of a reply that is still only a tool call after the retry. */
export function noToolsFallback(userText: string): string {
  return looksIndonesian(userText)
    ? "Belum saya cek — repo tidak bisa dibaca dari chat sekarang (worker belum online atau folder project belum di-set)."
    : "I haven't checked that yet — the repo can't be read from chat right now (no worker online or the project folder isn't set).";
}

/** Shown when a grounded reply used its whole tool budget without writing an answer. */
export function toolBudgetFallback(userText: string): string {
  return looksIndonesian(userText)
    ? "Belum saya cek sampai tuntas — batas pemeriksaan repo untuk balasan ini habis sebelum saya menulis jawaban. Tanyakan bagian yang lebih spesifik."
    : "I haven't finished checking — this reply ran out of repo checks before I wrote an answer. Ask about a narrower part.";
}

/**
 * Shown when a grounded reply ended with no answer and no repo check (the
 * model only kept announcing a check). Never an empty bubble: that left no
 * agent message for the user's turn.
 */
export function noAnswerFallback(userText: string): string {
  return looksIndonesian(userText)
    ? "Belum saya cek — saya belum sempat membaca repo untuk balasan ini. Sebutkan file atau bagian yang perlu saya periksa."
    : "I haven't checked that yet — I didn't get to read the repo for this reply. Name the file or part you want me to look at.";
}

/**
 * Final text for a reply made without tools after it was retried once: its
 * prose when the model answered (a stray call is dropped), otherwise the
 * fallback.
 */
export function resolveNoToolsReply(retryContent: string, userText: string): string {
  const { calls, prose, malformed } = extractToolCalls(retryContent);
  if (calls.length === 0 && malformed === 0 && prose) return prose;
  // A real answer with a stray call: keep the answer, drop the call.
  if (calls.length > 0 && prose.length >= 80) return prose;
  return noToolsFallback(userText);
}
