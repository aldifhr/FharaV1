// Pattern ported from Aider (https://github.com/Aider-AI/aider, commit 5dc9490),
// aider/linter.py (basic_lint, tree_context) and aider/coders/base_coder.py
// (lint_edited: lint the edited files and reflect the errors back to the model).
// SPDX-License-Identifier: Apache-2.0. See THIRD_PARTY_NOTICES.md.
// Modified by Fhara: rewritten in TypeScript; the tree-sitter parse is replaced by the
// TypeScript compiler's parser (ts.createSourceFile parseDiagnostics) for JS/TS and
// JSON.parse for JSON; only errors that are new against the pre-edit content count
// (SWE-agent pre/post lint pattern); runs on staged content before an approval exists.
import * as path from "node:path";
import { loadTypescript } from "./tsRuntime";

/**
 * Pre-approval syntax gate (multi-repo adoption R3): a staged file whose
 * content no longer parses is sent back to the implementer once, and never
 * reaches the approval card.
 */

export interface SyntaxIssue {
  filePath: string;
  line: number;
  column: number;
  message: string;
}

const JS_TS = /\.(?:[cm]?[jt]sx?)$/i;
/** JSON flavours that allow comments / trailing commas. */
const JSONC = /(?:^|\/)(?:tsconfig[^/]*|jsconfig[^/]*|\.eslintrc|\.babelrc|devcontainer)\.json$|\.jsonc$|(?:^|\/)\.vscode\/[^/]+\.json$/i;

function scriptKindFor(ts: NonNullable<ReturnType<typeof loadTypescript>>, filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return ts.ScriptKind.TS;
  // .js files often hold JSX (React projects): parse them leniently.
  return ts.ScriptKind.JSX;
}

function lineColumn(content: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) {
      line += 1;
      last = i;
    }
  }
  return { line, column: offset - last };
}

/** All syntax errors of a file's content ([] for unsupported file types or when the parser is unavailable). */
export function syntaxErrorsOf(filePath: string, content: string): SyntaxIssue[] {
  const file = filePath.replace(/\\/g, "/");
  if (/\.jsonc?$/i.test(file)) {
    if (JSONC.test(file)) {
      const ts = loadTypescript();
      if (!ts) return [];
      const parsed = ts.parseConfigFileTextToJson(file, content);
      if (!parsed.error) return [];
      const start = parsed.error.start ?? 0;
      const { line, column } = lineColumn(content, start);
      return [{ filePath: file, line, column, message: ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n") }];
    }
    try {
      JSON.parse(content);
      return [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const position = /position (\d+)/.exec(message);
      const { line, column } = position ? lineColumn(content, Number(position[1])) : { line: 1, column: 1 };
      return [{ filePath: file, line, column, message }];
    }
  }
  if (!JS_TS.test(file) || /\.d\.[cm]?ts$/i.test(file)) return [];
  const ts = loadTypescript();
  if (!ts) return [];
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, false, scriptKindFor(ts, file));
  const diagnostics = (source as unknown as { parseDiagnostics?: readonly import("typescript").DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  return diagnostics.map((diagnostic) => {
    const { line, character } = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return {
      filePath: file,
      line: line + 1,
      column: character + 1,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    };
  });
}

/**
 * Syntax errors the edit INTRODUCED: errors of the new content minus the
 * ones the old content already had (by message, as a multiset; lines shift).
 */
export function newSyntaxErrors(filePath: string, newContent: string, oldContent?: string | null): SyntaxIssue[] {
  const after = syntaxErrorsOf(filePath, newContent);
  if (after.length === 0 || !oldContent) return after;
  const remaining = new Map<string, number>();
  for (const issue of syntaxErrorsOf(filePath, oldContent)) remaining.set(issue.message, (remaining.get(issue.message) ?? 0) + 1);
  return after.filter((issue) => {
    const left = remaining.get(issue.message) ?? 0;
    if (left > 0) {
      remaining.set(issue.message, left - 1);
      return false;
    }
    return true;
  });
}

export interface GuardedFile {
  filePath: string;
  changeType?: string;
  oldContent?: string | null;
  newContent?: string | null;
}

/** New syntax errors across a staged change set (deleted files are skipped). */
export function stagedSyntaxErrors(files: ReadonlyArray<GuardedFile>): SyntaxIssue[] {
  const issues: SyntaxIssue[] = [];
  for (const file of files) {
    if (file.changeType === "deleted" || typeof file.newContent !== "string") continue;
    issues.push(...newSyntaxErrors(file.filePath, file.newContent, file.oldContent ?? null));
  }
  return issues;
}

/** Aider-style context: the lines around an error, the error line marked with █. */
function contextFor(content: string, line: number, radius = 2): string {
  const lines = content.split(/\r?\n/);
  const from = Math.max(1, line - radius);
  const to = Math.min(lines.length, line + radius);
  const out: string[] = [];
  for (let n = from; n <= to; n += 1) out.push(`${n === line ? "█" : "│"}${String(n).padStart(4)} ${lines[n - 1] ?? ""}`);
  return out.join("\n");
}

/** Feedback for the implementer's one corrective retry. */
export function syntaxRetryFeedback(issues: ReadonlyArray<SyntaxIssue>, contents: ReadonlyMap<string, string>): string {
  const byFile = new Map<string, SyntaxIssue[]>();
  for (const issue of issues) byFile.set(issue.filePath, [...(byFile.get(issue.filePath) ?? []), issue]);
  const sections: string[] = [];
  for (const [filePath, fileIssues] of [...byFile].slice(0, 5)) {
    const content = contents.get(filePath) ?? "";
    sections.push(
      [
        `## ${filePath}`,
        ...fileIssues.slice(0, 5).map((issue) => `${filePath}:${issue.line}:${issue.column}: ${issue.message}`),
        "",
        "See relevant lines below marked with █.",
        contextFor(content, fileIssues[0].line),
      ].join("\n")
    );
  }
  return [
    "Your previous answer was REJECTED before approval because the files you returned do not parse (syntax errors):",
    "",
    ...sections,
    "",
    "Return the corrected file changes JSON with complete, syntactically valid file contents. Fix only the syntax; keep the intended change.",
  ].join("\n");
}

/** One-paragraph summary (subtask error / approval warning), or null when clean. */
export function syntaxWarning(issues: ReadonlyArray<SyntaxIssue>): string | null {
  if (issues.length === 0) return null;
  const lines = issues.slice(0, 6).map((issue) => `- ${issue.filePath}:${issue.line}:${issue.column}: ${issue.message}`);
  if (issues.length > 6) lines.push(`- …and ${issues.length - 6} more`);
  return `Syntax check: the staged files do not parse:\n${lines.join("\n")}`;
}
