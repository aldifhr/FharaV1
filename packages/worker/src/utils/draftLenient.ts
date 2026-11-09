/**
 * Lenient parsing of a code_change answer that is not a strict file-changes
 * JSON object. Slow models (e2e ULTRA: longcat) often wrap the JSON in
 * prose/fences, leave raw newlines in strings, or break on escaping when the
 * file content is large. Accepted fallbacks, in order:
 *   1. "file blocks": a path header (`FILE: path`, `### path`, or a fence
 *      info string with `path=...`) followed by a fenced block of the full
 *      file content (no JSON escaping needed);
 *   2. JSON repair: raw control characters inside strings, invalid escapes,
 *      trailing commas, and (heuristically) unescaped inner quotes.
 */
import { parseDraft, type DraftFile } from "./json";

export type DraftFormat = "json" | "file-blocks" | "json-repaired";

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const PATH_RE = /^(?:\.\/)?[A-Za-z0-9_@\-.][A-Za-z0-9_@\-./]*$/;

/** Path-looking token: no spaces, a directory or a file extension, no URL scheme. */
function cleanPath(raw: string): string | null {
  let value = raw.trim();
  value = value.replace(/^\*\*|\*\*$/g, "").trim();
  value = value.replace(/^[`'"]+|[`'":]+$/g, "").trim();
  value = value.replace(/^\*\*|\*\*$/g, "").replace(/^`|`$/g, "").trim();
  if (value.startsWith("./")) value = value.slice(2);
  if (!value || value.length > 300 || /\s/.test(value) || value.includes("://")) return null;
  if (!PATH_RE.test(value)) return null;
  if (!value.includes("/") && !/\.[A-Za-z0-9]{1,10}$/.test(value) && !/^(Dockerfile|Makefile|LICENSE)$/.test(value)) {
    return null;
  }
  if (value.split("/").some((part) => part === "..")) return null;
  return value;
}

/** Path from a fence info string: ```js path=src/a.js / title="a.js" / file=... / ```src/a.js */
function pathFromInfo(info: string): string | null {
  const keyed = info.match(/(?:^|\s)(?:path|file|filename|filepath|title)\s*[=:]\s*("([^"]+)"|'([^']+)'|(\S+))/i);
  if (keyed) return cleanPath(keyed[2] ?? keyed[3] ?? keyed[4] ?? "");
  const tokens = info.trim().split(/\s+/).filter(Boolean);
  // ```src/a.js  or  ```js src/a.js
  for (const token of tokens.slice(0, 2)) {
    if (token.includes("/") || /\.[A-Za-z0-9]{1,10}$/.test(token)) {
      const p = cleanPath(token);
      if (p) return p;
    }
  }
  return null;
}

/** Path from a header line: FILE: path / File: `path` / ### path / **path** / path: */
function pathFromHeader(line: string): string | null {
  const trimmed = line.trim();
  const labeled = trimmed.match(/^(?:#{1,6}\s*)?(?:\*\*)?(?:FILE|File|file|Path|PATH|path|Filename|FILENAME)(?:\*\*)?\s*[:=]\s*(.+)$/);
  if (labeled) return cleanPath(labeled[1]);
  const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
  if (heading) return cleanPath(heading[1]);
  const bold = trimmed.match(/^\*\*(.+)\*\*:?$/);
  if (bold) return cleanPath(bold[1]);
  const bare = trimmed.match(/^`([^`]+)`:?$/);
  if (bare) return cleanPath(bare[1]);
  return null;
}

type Header = { line: number; path: string; fenceLine: number };

/**
 * Parse the file-block format. Each block ends at the LAST matching bare
 * closing fence before the next header, so files whose content holds
 * fences of their own (a README with code samples) survive.
 */
export function parseFileBlocks(content: string): { files: DraftFile[] } | null {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const headers: Header[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const fence = lines[i].match(FENCE_RE);
    if (fence) {
      const p = pathFromInfo(fence[2]);
      if (p) {
        headers.push({ line: i, path: p, fenceLine: i });
        continue;
      }
    }
    const p = pathFromHeader(lines[i]);
    if (!p) continue;
    // The header must be followed (after blank lines) by an opening fence.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j += 1;
    if (j < lines.length && FENCE_RE.test(lines[j])) {
      headers.push({ line: i, path: p, fenceLine: j });
      i = j; // the opening fence belongs to this header
    }
  }
  if (headers.length === 0) return null;
  const files = new Map<string, DraftFile>();
  for (let h = 0; h < headers.length; h += 1) {
    const header = headers[h];
    const end = h + 1 < headers.length ? headers[h + 1].line : lines.length;
    const open = lines[header.fenceLine].match(FENCE_RE)!;
    const fenceChar = open[1][0];
    const fenceLen = open[1].length;
    let close = -1;
    let shorterClose = -1;
    for (let k = end - 1; k > header.fenceLine; k -= 1) {
      const m = lines[k].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (!m || m[1][0] !== fenceChar) continue;
      if (m[1].length >= fenceLen) {
        close = k;
        break;
      }
      if (shorterClose < 0) shorterClose = k;
    }
    // Models often open with ```` and close with ``` (seen in e2e ULTRA):
    // without a closer of the full length, take the last shorter one.
    if (close < 0) close = shorterClose;
    // An unclosed block means the answer was cut off (output token limit):
    // reject the whole answer, so a partial change set (a file missing, a
    // file truncated) is never staged; the retry asks again.
    if (close < 0) return null;
    const body = lines.slice(header.fenceLine + 1, close).join("\n");
    files.set(header.path, { filePath: header.path, newContent: body.endsWith("\n") || body === "" ? body : `${body}\n` });
  }
  if (files.size === 0) return null;
  return { files: Array.from(files.values()) };
}

/**
 * Repair common JSON breakage in one candidate object text: raw control
 * characters inside strings, invalid escapes, trailing commas, and inner
 * double quotes that are clearly not string terminators.
 */
export function repairJson(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      if (ch === ",") {
        // Trailing comma before } or ] (outside strings only).
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j += 1;
        if (text[j] === "}" || text[j] === "]") continue;
      }
      out += ch;
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) {
        out += "\\\\";
        continue;
      }
      if ('"\\/bfnrt'.includes(next)) {
        out += ch + next;
        i += 1;
      } else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
        out += text.slice(i, i + 6);
        i += 5;
      } else if (next === "\n") {
        out += "\\n";
        i += 1;
      } else {
        // Invalid escape such as \' \$ \` : keep the backslash literally.
        out += "\\\\";
      }
      continue;
    }
    if (ch === '"') {
      // A real terminator is followed by , : } ] or the end.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      const after = text[j];
      if (after === undefined || after === ":" || after === "}" || after === "]") {
        inString = false;
        out += ch;
      } else if (after === ",") {
        // `", "` inside code is ambiguous; a terminator's comma is followed by
        // a key ("x":), a value start, or a closing bracket.
        let k = j + 1;
        while (k < text.length && /\s/.test(text[k])) k += 1;
        const rest = text.slice(k);
        const looksStructural = /^("[^"\n]{0,80}"\s*:|\{|\[|\]|\}|"(?:\\.|[^"\\])*"\s*[,}\]])/.test(rest) || rest === "";
        if (looksStructural) {
          inString = false;
          out += ch;
        } else {
          out += '\\"';
        }
      } else {
        out += '\\"';
      }
      continue;
    }
    if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch.charCodeAt(0) < 0x20) out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out;
}

/** JSON object candidates: fenced ```json blocks first, then first "{" .. last "}". */
function jsonCandidates(content: string): string[] {
  const out: string[] = [];
  const fenced = content.match(/```(?:json|JSON)?[^\n]*\n([\s\S]*?)\n\s*```\s*$/m);
  if (fenced) out.push(fenced[1]);
  const fencedGreedy = content.match(/```(?:json|JSON)[^\n]*\n([\s\S]*)\n\s*```/);
  if (fencedGreedy) out.push(fencedGreedy[1]);
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first >= 0 && last > first) out.push(content.slice(first, last + 1));
  return out.map((c) => {
    const s = c.indexOf("{");
    const e = c.lastIndexOf("}");
    return s >= 0 && e > s ? c.slice(s, e + 1) : c;
  });
}

export function parseRepairedJsonDraft(content: string): { files: DraftFile[] } | null {
  for (const candidate of jsonCandidates(content)) {
    for (const text of [candidate, repairJson(candidate)]) {
      try {
        const draft = parseDraft(JSON.stringify(JSON.parse(text)));
        if (draft) return draft;
      } catch {
        // try next
      }
    }
  }
  return null;
}

/** Strict JSON, then file blocks, then repaired JSON. */
export function parseDraftLenient(content: string): { draft: { files: DraftFile[] } | null; format: DraftFormat | null } {
  const strict = parseDraft(content);
  if (strict) return { draft: strict, format: "json" };
  const blocks = parseFileBlocks(content);
  if (blocks) return { draft: blocks, format: "file-blocks" };
  const repaired = parseRepairedJsonDraft(content);
  if (repaired) return { draft: repaired, format: "json-repaired" };
  return { draft: null, format: null };
}

/** Short reason an answer did not parse (for the task events). */
export function diagnoseDraftParse(content: string): string {
  if (content.trim() === "") return "empty answer";
  if (/^\s*(?:FILE|File)\s*:/m.test(content) && /^ {0,3}(?:`{3,}|~{3,})/m.test(content)) {
    return `file blocks found but one is not closed (answer cut off at ${content.length} chars? check the output token limit)`;
  }
  const first = content.indexOf("{");
  if (first < 0) return "no JSON object and no file blocks found";
  const last = content.lastIndexOf("}");
  if (last <= first) return "JSON object is not closed (answer truncated?)";
  try {
    const parsed = JSON.parse(content.slice(first, last + 1));
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { files?: unknown }).files)) {
      return "JSON parsed but has no files array";
    }
    return "JSON parsed but no entry has string filePath + newContent";
  } catch (error) {
    return `JSON.parse: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
  }
}
