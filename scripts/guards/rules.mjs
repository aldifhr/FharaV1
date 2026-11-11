// Guard rules for `scripts/code-budget.mjs` and `apps/web/tests/unit/uiRules.test.mjs`.
//
// Parts of this file are adapted from GOAT (https://github.com/goat-si/goat, commit 718f5b11),
// MIT License, Copyright (c) 2026 T3 Tools Inc., Copyright (c) 2026 goat-si contributors:
//   - `countLines`, `isTestCode`, `isGenerated`, `allowance` from `oxlint-plugin-goat/codeBudget.ts`
//   - the suppression-reason logic from `oxlint-plugin-goat/rules/require-suppression-reason.ts`
// `unawaitedAsyncAssertions` is adapted from Nuphos `eslint-rules/no-unawaited-async-assertion.js`,
// Copyright 2026 Zeabur Inc., Apache License 2.0.
// Modified by Fhara, 2026-11: oxlint/ESLint rules rewritten as plain source scans over text and the
// TypeScript AST; Fhara's own UI rules (animate-pulse, pills/badges, palette tints, raw hex, the retired brand colour) added;
// the line budget lowered to 800. See THIRD_PARTY_NOTICES.md (## GOAT, ## Nuphos).
import { createRequire } from "node:module";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Files longer than this need a baseline entry, and a baselined file may not grow. */
export const MAX_LINES = 800;

// typescript is a workspace devDependency, not a root one, so resolve it from a workspace.
let tsModule;
export function loadTypeScript() {
  if (tsModule) return tsModule;
  for (const pkg of ["apps/web", "packages/worker", "apps/api"]) {
    try {
      tsModule = createRequire(path.join(REPO_ROOT, pkg, "package.json"))("typescript");
      return tsModule;
    } catch {
      // try the next workspace
    }
  }
  throw new Error("typescript is not installed in any workspace; run npm ci");
}

const TEST_CODE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:(?:^|\/)(?:test|tests|__tests__|fixtures)\/)/u;
// Regenerated files grow with their source; holding them to a budget would block regeneration.
const GENERATED = /(?:(?:^|\/)_generated\/)|(?:\.(?:gen|generated)\.[cm]?[jt]sx?$)|(?:\.d\.ts$)/u;
const SOURCE = /\.[cm]?[jt]sx?$/u;

export const isTestCode = (file) => TEST_CODE.test(file);
export const isGenerated = (file) => GENERATED.test(file);
export const isBudgeted = (file) => SOURCE.test(file) && !isGenerated(file);

/** UI rules apply to the web app's own components, routes and libs. */
const UI_SOURCE = /^apps\/web\/(?:app|components|lib)\/.+\.tsx?$/u;
export const isUiSource = (file) => UI_SOURCE.test(file) && !isTestCode(file) && !isGenerated(file);

/** Counts lines the way `wc -l` does, plus a final line without a newline. */
export const countLines = (text) => {
  let lines = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) lines++;
  return text.length > 0 && !text.endsWith("\n") ? lines + 1 : lines;
};

// ---------------------------------------------------------------- suppressions

const DIRECTIVE = /(?:\/\/|\/\*)\s*\*?\s*((?:eslint|oxlint)-(?:disable|enable)(?:-next-line|-line)?|@ts-(?:expect-error|ignore|nocheck))(?![\w-])(.*)$/u;
const COMMENT_ONLY = /^\s*(?:\/\/|\/\*|\*)/u;
const EMPTY_COMMENT = /^\s*(?:\/\/|\/\*|\*)[\s*/]*$/u;

/**
 * Lines (1-based) holding a lint or type-checker suppression that does not say why.
 * A reason is `-- why` after an eslint/oxlint directive, any text after a `@ts-*` directive,
 * or an ordinary comment on the line above.
 */
export function unexplainedSuppressions(text) {
  const lines = text.split("\n");
  const found = [];
  const isDirectiveLine = (line) => DIRECTIVE.test(line);
  const explainedAbove = (index) => {
    let i = index - 1;
    while (i >= 0 && COMMENT_ONLY.test(lines[i]) && (isDirectiveLine(lines[i]) || EMPTY_COMMENT.test(lines[i]))) i--;
    return i >= 0 && COMMENT_ONLY.test(lines[i]) && !isDirectiveLine(lines[i]);
  };
  lines.forEach((line, index) => {
    const match = DIRECTIVE.exec(line);
    if (!match) return;
    const [, directive, rest] = match;
    if (/-enable/u.test(directive)) return;
    const tail = rest.replace(/\*\/\s*$/u, "");
    const reason = directive.startsWith("@ts-")
      ? tail.replace(/^[\s:-]+/u, "").trim()
      : (/\s--\s*(.*)$/u.exec(tail)?.[1] ?? "").trim();
    if (reason) return;
    if (explainedAbove(index)) return;
    found.push(index + 1);
  });
  return found;
}

// ---------------------------------------------------------------- UI rules

const PALETTE = "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const UTILITY = "bg|text|border|border-[trblxy]|ring|ring-offset|from|via|to|fill|stroke|outline|divide|shadow|decoration|accent|caret|placeholder";
const TINT = new RegExp(`(?<![\\w-])(?:${UTILITY})-(?:${PALETTE})-\\d{2,3}(?![\\w])`, "gu");
// A hex colour starting a string or a Tailwind arbitrary value: "#fff", '#635bff', [#ebe9f0].
const RAW_HEX = /(?<=["'`[])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w])/gu;
// The old purple brand: the primary is ink now (bg-ink text-canvas), with no accent colour.
const BRAND = new RegExp(`(?<![\\w-])(?:${UTILITY})-brand(?:-(?:hover|soft|ink))?(?![\\w-])|var\\(--(?:shell|accent)-brand`, "gu");
const PULSE = /(?<![\w-])animate-pulse(?![\w-])/gu;
const PILL_SHAPE = /(?<![\w-])rounded-full(?![\w-])[^"'`\n]*?(?<![\w-])px-|(?<![\w-])px-[\d.]+(?![\w-])[^"'`\n]*?(?<![\w-])rounded-full(?![\w-])/u;
const PILL_CLASS = /["'`\s](?:pill|badge|chip)(?:-[\w-]+)?(?=["'`\s])/u;
const BADGE_COMPONENT = /from\s+["'][^"']*\/ui\/badge["']|<Badge[\s>]/u;

const countMatches = (text, regex) => (text.match(regex) ?? []).length;

/** Strips `//` line comments and block comments so prose about a rule does not trip it. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gmu, "$1");
}

/** Counts per UI rule in one web source file. */
export function uiRuleCounts(text) {
  const code = stripComments(text);
  let pill = 0;
  for (const line of code.split("\n")) {
    if (PILL_SHAPE.test(line) || BADGE_COMPONENT.test(line) || (/className|cn\(|clsx\(/u.test(line) && PILL_CLASS.test(line))) pill++;
  }
  return {
    pulse: countMatches(code, PULSE),
    pill,
    tint: countMatches(code, TINT),
    hex: countMatches(code, RAW_HEX),
  };
}

/** Uses of the retired purple brand colour (kept out of uiRuleCounts so its shape stays stable). */
export const brandUses = (text) => countMatches(stripComments(text), BRAND);

// ---------------------------------------------------------------- async assertions

const ASYNC_MODIFIERS = new Set(["rejects", "resolves"]);

/** Lines (1-based) with `expect(...).rejects/.resolves...` used as a bare statement (no await/return). */
export function unawaitedAsyncAssertions(text, fileName = "file.ts") {
  const ts = loadTypeScript();
  const kind = /\.tsx$/u.test(fileName) ? ts.ScriptKind.TSX : /\.[cm]?jsx?$/u.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found = [];

  const isExpectCall = (node) =>
    ts.isCallExpression(node) &&
    ((ts.isIdentifier(node.expression) && node.expression.text === "expect") ||
      (ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "expect"));

  const asyncModifier = (call) => {
    let current = call.expression;
    while (ts.isPropertyAccessExpression(current) || ts.isCallExpression(current)) {
      if (ts.isPropertyAccessExpression(current)) {
        const object = current.expression;
        if (ts.isPropertyAccessExpression(object) && ASYNC_MODIFIERS.has(object.name.text) && isExpectCall(object.expression)) {
          return object.name.text;
        }
        current = object;
      } else {
        current = current.expression;
      }
    }
    return null;
  };

  const visit = (node) => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && asyncModifier(node.expression)) {
      found.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// ---------------------------------------------------------------- measuring

/** Every measure the baseline tracks for one file; zero counts are omitted. */
export function measureFile(file, text) {
  const out = {};
  const lines = countLines(text);
  if (lines > MAX_LINES) out.lines = lines;
  const suppressions = unexplainedSuppressions(text).length;
  if (suppressions) out.suppressions = suppressions;
  if (isUiSource(file)) {
    for (const [key, value] of Object.entries(uiRuleCounts(text))) if (value) out[key] = value;
    const brand = brandUses(text);
    if (brand) out.brand = brand;
  }
  if (isTestCode(file) && /\b(?:rejects|resolves)\b/u.test(text)) {
    const unawaited = unawaitedAsyncAssertions(text, file).length;
    if (unawaited) out.unawaited = unawaited;
  }
  return out;
}

export const RULE_HELP = {
  lines: `Files may not exceed ${MAX_LINES} lines, and a file already over it may not grow. Split it along a responsibility boundary.`,
  suppressions: "Say why: end an eslint directive with `-- reason`, write the reason after `@ts-expect-error`, or put a comment on the line above.",
  pulse: "No animate-pulse. Show a static loading state (text-ink-3 \"Loading…\" or a plain bg-hover block).",
  pill: "No pills or badges (rounded-full + px-, pill/badge/chip classes, ui/badge). Use plain text in text-ink-2/-3.",
  tint: "No palette tints (bg-rose-100, text-emerald-600, …). Use theme tokens: bg-canvas/panel/hover, border-line, text-ink/-2/-3.",
  brand: "No brand/accent colour. The primary is ink: bg-ink text-canvas, focus rings ring-ink/30, active rows bg-hover text-ink.",
  hex: "No raw hex colours in UI code. Use theme tokens defined in app/globals.css.",
  unawaited: "`expect(...).rejects/.resolves` settles asynchronously. Prefix it with `await` (or `return`).",
};

/** Over-baseline findings: [{file, rule, found, allowed}]. Improvements are not failures. */
export function compareMeasures(measured, baseline) {
  const problems = [];
  const improved = [];
  for (const [file, measures] of Object.entries(measured)) {
    const allowed = baseline[file] ?? {};
    for (const [rule, found] of Object.entries(measures)) {
      const limit = rule === "lines" ? Math.max(allowed.lines ?? 0, MAX_LINES) : (allowed[rule] ?? 0);
      if (found > limit) problems.push({ file, rule, found, allowed: limit });
    }
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    for (const [rule, limit] of Object.entries(allowed)) {
      const found = measured[file]?.[rule] ?? 0;
      if (found < limit) improved.push({ file, rule, found, allowed: limit });
    }
  }
  return { problems, improved };
}
