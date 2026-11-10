/**
 * Scope guard (live test 4): cheap, heuristic checks that a prepared change
 * stays inside what the request asked for, run before apply / approval.
 *
 *  - deleted_test:      an existing test file deleted, or existing test
 *                       cases (`it(…)` / `test(…)`) dropped from one;
 *  - removed_export:    an exported symbol of an existing source file gone;
 *  - doc_only_behavior: a documentation/comment-only request whose change
 *                       touches code outside comments.
 *
 * A request that itself asks to remove / rename things skips the matching
 * check. Findings are warnings: they are shown on the approval and sent
 * back to the implementer once, never a hard block.
 */

export type ScopeViolationCode = "deleted_test" | "removed_export" | "doc_only_behavior";

export interface ScopeViolation {
  code: ScopeViolationCode;
  filePath: string;
  message: string;
}

export interface ScopeChange {
  filePath: string;
  changeType: string;
  oldContent?: string;
  newContent?: string;
}

const TEST_FILE = /(?:^|\/)(?:__tests__|tests?)\/|[._-](?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[\w-]+\.py$|_test\.(?:py|go)$/i;
const JS_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;

/** The request asks to remove / delete / rename / replace something. */
const REMOVAL_REQUEST =
  /\b(?:remove|removes|removing|delete|deletes|deleting|drop|drops|rename|renames|renaming|replace|replaces|rewrite|deprecate|hapus\w*|buang\w*|ganti\w*|ubah nama|rename\w*)\b/i;
const TEST_WORD = /\b(?:tests?|specs?|unit tests?|test cases?|tes|pengujian)\b/i;
const DOC_WORD = /\b(?:jsdoc|tsdoc|docstrings?|doc comments?|comments?|komentar\w*|dokumentasi\w*|documentation|documents?|docs?)\b/i;
/** A doc request still counts as doc-only when it says "only" or the doc is the verb's object. */
const DOC_ONLY_MARK = /\b(?:only|just|saja|hanya|cuma|aja)\b/i;
const DOC_OBJECT =
  /\b(?:add|adds|adding|write|writes|update|improve|document|tambah\w*|tulis\w*|buat\w*|beri\w*|lengkapi\w*|perbarui\w*)\s+(?:\S+\s+){0,2}?(?:jsdoc|tsdoc|docstrings?|doc comments?|comments?|komentar\w*|dokumentasi\w*|documentation|docs?)\b/i;
/** Words that make a request about code behaviour, not just docs. */
const CODE_WORK =
  /\b(?:fix|fixes|bug|implement\w*|refactor\w*|optimi[sz]e\w*|perbaiki\w*|feature|fitur|endpoint|logic|logika|behaviou?r|perilaku|output|tests?|unit tests?|tes|test cases?|rename|ganti|ubah|change the|new function|fungsi baru|handle|support)\b/i;

/** True for a request that only asks for documentation / comments. */
export function isDocOnlyRequest(command: string): boolean {
  const text = command ?? "";
  if (!DOC_WORD.test(text)) return false;
  if (CODE_WORK.test(text) && !DOC_ONLY_MARK.test(text)) return false;
  return DOC_ONLY_MARK.test(text) || DOC_OBJECT.test(text);
}

/** Names of `it(…)` / `test(…)` cases (and `describe` blocks) in a JS/TS test file. */
export function testCaseNames(source: string): string[] {
  const names: string[] = [];
  const pattern = /\b(?:it|test|describe)(?:\.(?:only|skip|todo|concurrent|each\([^)]*\)))*\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const match of source.matchAll(pattern)) names.push(match[2].trim());
  // Python: def test_x(
  for (const match of source.matchAll(/^\s*(?:async\s+)?def\s+(test_\w+)\s*\(/gm)) names.push(match[1]);
  return names;
}

/** Exported symbol names of a JS/TS module (ESM and CommonJS forms). */
export function exportedSymbols(source: string): string[] {
  const names = new Set<string>();
  const add = (name: string | undefined) => {
    const trimmed = name?.trim();
    if (trimmed && /^[A-Za-z_$][\w$]*$/.test(trimmed)) names.add(trimmed);
  };
  const code = stripComments(source);
  for (const m of code.matchAll(/\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  if (/\bexport\s+default\b/.test(code)) names.add("default");
  for (const m of code.matchAll(/\bexport\s*(?:type\s*)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) add(part.split(/\s+as\s+/).pop());
  }
  for (const m of code.matchAll(/\bmodule\.exports\s*=\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) add(part.split(":")[0]);
  }
  for (const m of code.matchAll(/\bmodule\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;?/g)) add(m[1]);
  for (const m of code.matchAll(/\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)) add(m[1]);
  return [...names];
}

/**
 * JS/TS source with comments removed (strings and template literals kept).
 * Approximate: regex literals are not tokenized.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Code with comments and all whitespace removed (formatting-only edits compare equal). */
function codeSignature(source: string): string {
  return stripComments(source).replace(/\s+/g, "");
}

/**
 * The user's request without the attached conversation / file context
 * (same split as orchestrator/classifier requestText, which this layer
 * may not import).
 */
function requestPart(command: string): string {
  const text = command ?? "";
  return text.split(/\n\s*(?:---\s*Conversation context\s*---|Attached file context:|---\s*File:)/i)[0] ?? text;
}

/** Scope violations of a prepared change set against the request (the full task command is fine). */
export function scopeViolations(command: string, changes: ReadonlyArray<ScopeChange>): ScopeViolation[] {
  const request = requestPart(command);
  const asksRemoval = REMOVAL_REQUEST.test(request);
  const asksTestRemoval = asksRemoval && TEST_WORD.test(request);
  const docOnly = isDocOnlyRequest(request);
  const violations: ScopeViolation[] = [];

  for (const change of changes) {
    const filePath = change.filePath.replace(/\\/g, "/");
    const isTest = TEST_FILE.test(filePath);
    const oldContent = change.oldContent ?? "";
    const newContent = change.newContent ?? "";

    if (change.changeType === "deleted") {
      if (isTest && !asksTestRemoval) {
        violations.push({ code: "deleted_test", filePath, message: `deletes the existing test file ${filePath}` });
      } else if (!isTest && JS_FILE.test(filePath) && !asksRemoval) {
        const exported = exportedSymbols(oldContent);
        if (exported.length > 0) {
          violations.push({
            code: "removed_export",
            filePath,
            message: `deletes ${filePath}, which exports ${exported.slice(0, 5).join(", ")}`,
          });
        }
      }
      if (docOnly && change.changeType === "deleted" && JS_FILE.test(filePath)) {
        violations.push({ code: "doc_only_behavior", filePath, message: `deletes ${filePath} on a documentation-only request` });
      }
      continue;
    }
    if (change.changeType !== "modified" || change.oldContent === undefined) continue;

    if (isTest && !asksTestRemoval) {
      const before = testCaseNames(oldContent);
      const after = new Set(testCaseNames(newContent));
      const dropped = [...new Set(before.filter((name) => !after.has(name)))];
      if (dropped.length > 0) {
        violations.push({
          code: "deleted_test",
          filePath,
          message: `drops existing test case(s) from ${filePath}: ${dropped
            .slice(0, 5)
            .map((name) => `"${name}"`)
            .join(", ")}${dropped.length > 5 ? ", …" : ""}`,
        });
      }
    }
    if (!isTest && JS_FILE.test(filePath) && !asksRemoval) {
      const after = new Set(exportedSymbols(newContent));
      const removed = exportedSymbols(oldContent).filter((name) => !after.has(name));
      if (removed.length > 0) {
        violations.push({
          code: "removed_export",
          filePath,
          message: `removes exported symbol(s) from ${filePath}: ${removed.slice(0, 5).join(", ")}`,
        });
      }
    }
    if (docOnly && JS_FILE.test(filePath) && codeSignature(oldContent) !== codeSignature(newContent)) {
      violations.push({
        code: "doc_only_behavior",
        filePath,
        message: `changes code outside comments in ${filePath} on a documentation-only request (behaviour may change)`,
      });
    }
  }
  return violations;
}

/** One warning paragraph for the approval / diff, or null when clean. */
export function scopeWarning(violations: ReadonlyArray<ScopeViolation>): string | null {
  if (violations.length === 0) return null;
  const lines = violations.slice(0, 6).map((violation) => `- ${violation.message}`);
  if (violations.length > 6) lines.push(`- …and ${violations.length - 6} more`);
  return `Scope check: this change goes beyond the request:\n${lines.join("\n")}`;
}

/** Feedback for the implementer's one corrective retry. */
export function scopeRetryFeedback(violations: ReadonlyArray<ScopeViolation>): string {
  return [
    "Your previous answer was REJECTED by the scope guard because it changed more than the request asked:",
    ...violations.slice(0, 8).map((violation) => `- ${violation.message}`),
    "Return the corrected file changes JSON. Keep every existing test case and exported symbol, and keep the existing documentation. For a documentation/comment-only request, change comments only: leave the code (and therefore its behaviour and output) exactly as it is.",
  ].join("\n");
}
