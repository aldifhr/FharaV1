/**
 * SEARCH/REPLACE edit blocks: parser, in-memory apply and "did you mean"
 * feedback for the implementer's non-native code_change answers.
 *
 * Ported from Aider-AI/aider, commit 5dc9490, aider/coders/editblock_coder.py
 * (`find_original_update_blocks`, `find_filename`, `strip_filename`,
 * `strip_quoted_wrapping`, `try_dotdotdots`,
 * `replace_part_with_missing_leading_whitespace`, `find_similar_lines`, and the
 * failure report text of `EditBlockCoder.apply_edits`).
 * SPDX-License-Identifier: Apache-2.0. Copyright Aider-AI contributors.
 *
 * Modified by Fhara: ported from Python to TypeScript; difflib's
 * SequenceMatcher.ratio / get_close_matches re-implemented (no autojunk);
 * shell-command blocks are skipped instead of returned; matching uses the
 * opencode replacers (./editReplacers.ts) after Aider's exact and "..."
 * strategies; edits apply to in-memory content instead of disk; failures are
 * returned as data, with an ambiguity report that lists line numbers.
 * See THIRD_PARTY_NOTICES.md.
 */
import { replace as fuzzyReplace } from "./editReplacers";

export type Fence = readonly [string, string];
export const DEFAULT_FENCE: Fence = ["```", "```"];

export interface EditBlock {
  filePath: string;
  search: string;
  replace: string;
}

const HEAD = /^<{5,9} SEARCH>?\s*$/;
const DIVIDER = /^={5,9}\s*$/;
const UPDATED = /^>{5,9} REPLACE\s*$/;
const HEAD_ANY = /^\s*<{5,9} SEARCH>?\s*$/m;
const UPDATED_ANY = /^\s*>{5,9} REPLACE\s*$/m;

const DIVIDER_ERR = "=======";
const UPDATED_ERR = ">>>>>>> REPLACE";
const TRIPLE_BACKTICKS = "```";

const SHELL_STARTS = [
  "```bash",
  "```sh",
  "```shell",
  "```cmd",
  "```batch",
  "```powershell",
  "```ps1",
  "```zsh",
  "```fish",
  "```ksh",
  "```csh",
  "```tcsh",
];

/** Thrown for a malformed block (Aider's ValueError text). */
export class EditBlockParseError extends Error {}

/** Whether an answer carries at least one SEARCH/REPLACE block. */
export function hasEditBlocks(content: string): boolean {
  return HEAD_ANY.test(content) && UPDATED_ANY.test(content);
}

/** Python `str.splitlines(keepends=True)` for \n text. */
function splitLinesKeepEnds(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** Ratcliff/Obershelp ratio, like difflib.SequenceMatcher(None, a, b).ratio() without autojunk. */
export function sequenceRatio<T>(a: readonly T[], b: readonly T[]): number {
  const total = a.length + b.length;
  if (total === 0) return 1;
  const matches = (aLo: number, aHi: number, bLo: number, bHi: number): number => {
    let bestI = aLo;
    let bestJ = bLo;
    let bestSize = 0;
    let prev = new Map<number, number>();
    for (let i = aLo; i < aHi; i += 1) {
      const next = new Map<number, number>();
      for (let j = bLo; j < bHi; j += 1) {
        if (a[i] !== b[j]) continue;
        const k = (prev.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestSize) {
          bestI = i - k + 1;
          bestJ = j - k + 1;
          bestSize = k;
        }
      }
      prev = next;
    }
    if (bestSize === 0) return 0;
    return bestSize + matches(aLo, bestI, bLo, bestJ) + matches(bestI + bestSize, aHi, bestJ + bestSize, bHi);
  };
  return (2 * matches(0, a.length, 0, b.length)) / total;
}

/** difflib.get_close_matches(word, possibilities, n, cutoff) on characters. */
export function getCloseMatches(word: string, possibilities: readonly string[], n = 3, cutoff = 0.6): string[] {
  const scored: Array<{ score: number; value: string }> = [];
  for (const value of possibilities) {
    const score = sequenceRatio([...word], [...value]);
    if (score >= cutoff) scored.push({ score, value });
  }
  scored.sort((x, y) => y.score - x.score || (y.value < x.value ? -1 : 1));
  return scored.slice(0, n).map((entry) => entry.value);
}

/** Aider `strip_filename`. */
export function stripFilename(raw: string, fence: Fence = DEFAULT_FENCE): string | undefined {
  let filename = raw.trim();
  if (filename === "...") return undefined;
  const startFence = fence[0];
  if (filename.startsWith(startFence)) {
    const candidate = filename.slice(startFence.length);
    if (candidate && (candidate.includes(".") || candidate.includes("/"))) return candidate;
    return undefined;
  }
  if (filename.startsWith(TRIPLE_BACKTICKS)) {
    const candidate = filename.slice(TRIPLE_BACKTICKS.length);
    if (candidate && (candidate.includes(".") || candidate.includes("/"))) return candidate;
    return undefined;
  }
  filename = filename.replace(/:+$/, "");
  filename = filename.replace(/^#+/, "");
  filename = filename.trim();
  filename = filename.replace(/^`+|`+$/g, "");
  filename = filename.replace(/^\*+|\*+$/g, "");
  return filename || undefined;
}

/** Aider `find_filename`: look back up to 3 lines for the block's file name. */
export function findFilename(
  lines: readonly string[],
  fence: Fence = DEFAULT_FENCE,
  validFnames: readonly string[] | null = null
): string | undefined {
  const valid = validFnames ?? [];
  const recent = [...lines].reverse().slice(0, 3);
  const filenames: string[] = [];
  for (const line of recent) {
    const filename = stripFilename(line, fence);
    if (filename) filenames.push(filename);
    if (!line.startsWith(fence[0]) && !line.startsWith(TRIPLE_BACKTICKS)) break;
  }
  if (filenames.length === 0) return undefined;
  for (const fname of filenames) if (valid.includes(fname)) return fname;
  for (const fname of filenames) {
    for (const vfn of valid) if (fname === basename(vfn)) return vfn;
  }
  for (const fname of filenames) {
    const close = getCloseMatches(fname, valid, 1, 0.8);
    if (close.length === 1) return close[0];
  }
  for (const fname of filenames) if (fname.includes(".")) return fname;
  return filenames[0];
}

/**
 * Aider `find_original_update_blocks`. Returns the blocks in order; a block
 * without a file name reuses the previous one. Throws EditBlockParseError
 * (text ends with "^^^ <reason>") on a malformed block.
 */
export function findOriginalUpdateBlocks(
  content: string,
  fence: Fence = DEFAULT_FENCE,
  validFnames: readonly string[] | null = null
): EditBlock[] {
  const lines = splitLinesKeepEnds(content.replace(/\r\n/g, "\n"));
  const blocks: EditBlock[] = [];
  let i = 0;
  let currentFilename: string | undefined;
  while (i < lines.length) {
    const line = lines[i];
    const nextIsEditblock =
      (i + 1 < lines.length && HEAD.test(lines[i + 1].trim())) ||
      (i + 2 < lines.length && HEAD.test(lines[i + 2].trim()));
    if (SHELL_STARTS.some((start) => line.trim().startsWith(start)) && !nextIsEditblock) {
      // Shell blocks: Aider runs them; Fhara has no shell here, so skip.
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) i += 1;
      if (i < lines.length && lines[i].trim().startsWith("```")) i += 1;
      continue;
    }
    if (HEAD.test(line.trim())) {
      try {
        const preceding = lines.slice(Math.max(0, i - 3), i).map((l) => l.replace(/\n$/, ""));
        let filename =
          i + 1 < lines.length && DIVIDER.test(lines[i + 1].trim())
            ? findFilename(preceding, fence, null)
            : findFilename(preceding, fence, validFnames);
        if (!filename) {
          if (currentFilename) filename = currentFilename;
          else
            throw new EditBlockParseError(
              `Bad/missing filename. The filename must be alone on the line before the opening fence ${fence[0]}`
            );
        }
        currentFilename = filename;
        const original: string[] = [];
        i += 1;
        while (i < lines.length && !DIVIDER.test(lines[i].trim())) {
          original.push(lines[i]);
          i += 1;
        }
        if (i >= lines.length || !DIVIDER.test(lines[i].trim())) {
          throw new EditBlockParseError(`Expected \`${DIVIDER_ERR}\``);
        }
        const updated: string[] = [];
        i += 1;
        while (i < lines.length && !(UPDATED.test(lines[i].trim()) || DIVIDER.test(lines[i].trim()))) {
          updated.push(lines[i]);
          i += 1;
        }
        if (i >= lines.length || !(UPDATED.test(lines[i].trim()) || DIVIDER.test(lines[i].trim()))) {
          throw new EditBlockParseError(`Expected \`${UPDATED_ERR}\` or \`${DIVIDER_ERR}\``);
        }
        blocks.push({ filePath: filename, search: original.join(""), replace: updated.join("") });
      } catch (error) {
        if (!(error instanceof EditBlockParseError)) throw error;
        const processed = lines.slice(0, i + 1).join("");
        throw new EditBlockParseError(`${processed}\n^^^ ${error.message}`);
      }
    }
    i += 1;
  }
  return blocks;
}

/** Aider `strip_quoted_wrapping`: drop a leading file name line and an outer fence. */
export function stripQuotedWrapping(res: string, fname?: string, fence: Fence = DEFAULT_FENCE): string {
  if (!res) return res;
  let lines = res.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "" && res.endsWith("\n")) lines.pop();
  if (fname && lines.length > 0 && lines[0].trim().endsWith(basename(fname))) lines = lines.slice(1);
  if (lines.length >= 2 && lines[0].startsWith(fence[0]) && lines[lines.length - 1].startsWith(fence[1])) {
    lines = lines.slice(1, -1);
  }
  let out = lines.join("\n");
  if (out && !out.endsWith("\n")) out += "\n";
  return out;
}

/** Aider `try_dotdotdots`: null when the block has no "..." lines; throws on a mismatch. */
export function tryDotDotDots(whole: string, part: string, replacement: string): string | null {
  const dots = /(^\s*\.\.\.\n)/gm;
  const partPieces = part.split(dots);
  const replacePieces = replacement.split(dots);
  if (partPieces.length !== replacePieces.length) throw new Error("Unpaired ... in SEARCH/REPLACE block");
  if (partPieces.length === 1) return null;
  for (let k = 1; k < partPieces.length; k += 2) {
    if (partPieces[k] !== replacePieces[k]) throw new Error("Unmatched ... in SEARCH/REPLACE block");
  }
  const parts = partPieces.filter((_, k) => k % 2 === 0);
  const replaces = replacePieces.filter((_, k) => k % 2 === 0);
  let result = whole;
  for (let k = 0; k < parts.length; k += 1) {
    const p = parts[k];
    const r = replaces[k];
    if (!p && !r) continue;
    if (!p && r) {
      if (!result.endsWith("\n")) result += "\n";
      result += r;
      continue;
    }
    const count = result.split(p).length - 1;
    if (count !== 1) throw new Error(count === 0 ? "no match" : "multiple matches");
    result = result.replace(p, () => r);
  }
  return result;
}

/** Python `splitlines(keepends=True)` after Aider `prep` (adds a final newline). */
function prepLines(text: string): string[] {
  const value = text && !text.endsWith("\n") ? `${text}\n` : text;
  return splitLinesKeepEnds(value);
}

function lstrip(text: string): string {
  return text.replace(/^\s+/, "");
}

/** Aider `match_but_for_leading_whitespace`. */
function matchButForLeadingWhitespace(wholeLines: string[], partLines: string[]): string | undefined {
  const num = wholeLines.length;
  for (let i = 0; i < num; i += 1) if (lstrip(wholeLines[i]) !== lstrip(partLines[i])) return undefined;
  const add = new Set<string>();
  for (let i = 0; i < num; i += 1) {
    if (wholeLines[i].trim()) add.add(wholeLines[i].slice(0, wholeLines[i].length - partLines[i].length));
  }
  if (add.size !== 1) return undefined;
  return add.values().next().value;
}

/**
 * Aider `replace_part_with_missing_leading_whitespace`: the model dropped
 * (or shortened) the indentation uniformly; re-indent the replacement.
 */
export function replacePartWithMissingLeadingWhitespace(whole: string, part: string, replacement: string): string | null {
  let wholeLines = prepLines(whole);
  let partLines = prepLines(part);
  let replaceLines = prepLines(replacement);
  const leadingOf = (line: string) => line.length - lstrip(line).length;
  const leading = [...partLines.filter((p) => p.trim()).map(leadingOf), ...replaceLines.filter((p) => p.trim()).map(leadingOf)];
  if (leading.length > 0 && Math.min(...leading) > 0) {
    const num = Math.min(...leading);
    partLines = partLines.map((p) => (p.trim() ? p.slice(num) : p));
    replaceLines = replaceLines.map((p) => (p.trim() ? p.slice(num) : p));
  }
  const numPart = partLines.length;
  for (let i = 0; i <= wholeLines.length - numPart; i += 1) {
    const addLeading = matchButForLeadingWhitespace(wholeLines.slice(i, i + numPart), partLines);
    if (addLeading === undefined) continue;
    replaceLines = replaceLines.map((r) => (r.trim() ? addLeading + r : r));
    wholeLines = [...wholeLines.slice(0, i), ...replaceLines, ...wholeLines.slice(i + numPart)];
    return wholeLines.join("");
  }
  return null;
}

/** Aider `find_similar_lines`: the closest chunk (with context when not exact at both ends). */
export function findSimilarLines(searchText: string, contentText: string, threshold = 0.6): string {
  const searchLines = searchText.split(/\r?\n/);
  if (searchLines.length > 0 && searchLines[searchLines.length - 1] === "") searchLines.pop();
  const contentLines = contentText.split(/\r?\n/);
  if (contentLines.length > 0 && contentLines[contentLines.length - 1] === "") contentLines.pop();
  let bestRatio = 0;
  let bestMatch: string[] | null = null;
  let bestI = 0;
  for (let i = 0; i <= contentLines.length - searchLines.length; i += 1) {
    const chunk = contentLines.slice(i, i + searchLines.length);
    const ratio = sequenceRatio(searchLines, chunk);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestMatch = chunk;
      bestI = i;
    }
  }
  if (bestRatio < threshold || !bestMatch) return "";
  if (bestMatch[0] === searchLines[0] && bestMatch[bestMatch.length - 1] === searchLines[searchLines.length - 1]) {
    return bestMatch.join("\n");
  }
  const N = 5;
  const end = Math.min(contentLines.length, bestI + searchLines.length + N);
  const start = Math.max(0, bestI - N);
  return contentLines.slice(start, end).join("\n");
}

export type EditFailureKind = "no_match" | "ambiguous" | "missing_file" | "malformed";

export interface EditFailure {
  block: EditBlock;
  kind: EditFailureKind;
  /** Actual lines that look close (no_match). */
  didYouMean?: string;
  /** 1-based line numbers of the candidate matches (ambiguous). */
  lines?: number[];
  /** The REPLACE text is already in the file (no_match). */
  alreadyApplied?: boolean;
  detail?: string;
}

/** 1-based line numbers where `needle` starts in `haystack`. */
function occurrenceLines(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let from = 0;
  while (out.length < 20) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    out.push(haystack.slice(0, index).split("\n").length);
    from = index + 1;
  }
  return out;
}

function candidateLines(content: string, search: string): number[] {
  const exact = occurrenceLines(content, search.replace(/\n$/, ""));
  if (exact.length > 1) return exact;
  const first = search.split("\n").find((line) => line.trim().length > 0)?.trim();
  if (!first) return exact;
  return content
    .split("\n")
    .map((line, idx) => (line.trim() === first ? idx + 1 : 0))
    .filter((n) => n > 0)
    .slice(0, 20);
}

export type ApplyOneResult = { ok: true; content: string } | { ok: false; failure: Omit<EditFailure, "block"> };

/** Apply one block to `content` (exact, Aider leading-whitespace and "...", then the opencode replacers). */
export function applyEditBlock(content: string, block: EditBlock, fence: Fence = DEFAULT_FENCE): ApplyOneResult {
  const search = stripQuotedWrapping(block.search, block.filePath, fence);
  const replacement = stripQuotedWrapping(block.replace, block.filePath, fence);
  if (!search.trim()) return { ok: true, content: content + replacement };
  if (search === replacement) return { ok: true, content };
  const exactCount = content.split(search).length - 1;
  if (exactCount === 1) return { ok: true, content: content.replace(search, () => replacement) };
  if (exactCount > 1) {
    return { ok: false, failure: { kind: "ambiguous", lines: occurrenceLines(content, search) } };
  }
  if (content.endsWith("\n") || !content) {
    const reindented = replacePartWithMissingLeadingWhitespace(content, search, replacement);
    if (reindented !== null) return { ok: true, content: reindented };
  }
  try {
    const dotted = tryDotDotDots(content, search, replacement);
    if (dotted !== null) return { ok: true, content: dotted };
  } catch {
    // A "..." block that does not line up falls through to the fuzzy replacers.
  }
  // The opencode replacers match line blocks without the trailing newline;
  // strip it from both sides so the replacement keeps the file's line ends.
  const trail = search.endsWith("\n") && replacement.endsWith("\n");
  const find = trail ? search.slice(0, -1) : search;
  const repl = trail ? replacement.slice(0, -1) : replacement;
  try {
    return { ok: true, content: fuzzyReplace(content, find, repl) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/multiple matches/i.test(message)) {
      return { ok: false, failure: { kind: "ambiguous", lines: candidateLines(content, search) } };
    }
    if (/must be different/i.test(message)) return { ok: true, content };
    const didYouMean = findSimilarLines(search, content);
    const alreadyApplied = replacement.trim().length > 0 && content.includes(replacement);
    return {
      ok: false,
      failure: { kind: "no_match", ...(didYouMean ? { didYouMean } : {}), ...(alreadyApplied ? { alreadyApplied } : {}) },
    };
  }
}

export interface ApplyEditBlocksResult {
  /** Final content per touched file, in first-touch order. */
  files: Array<{ filePath: string; newContent: string; isNew: boolean }>;
  failures: EditFailure[];
  applied: EditBlock[];
}

/**
 * Apply blocks in order to in-memory copies. `readCurrent` returns the
 * file's current text (staged edit or disk), or null when it does not
 * exist. An empty SEARCH creates (or appends to) a file. Nothing is
 * written; the caller stages the result through the normal diff flow.
 * `start` seeds files already edited by an earlier round.
 */
export async function applyEditBlocks(
  blocks: readonly EditBlock[],
  readCurrent: (filePath: string) => Promise<string | null>,
  options: {
    fence?: Fence;
    start?: ReadonlyMap<string, { content: string; isNew: boolean }>;
    /** Reflection rounds: a resent block whose REPLACE text is already in the file counts as applied. */
    acceptAlreadyApplied?: boolean;
  } = {}
): Promise<ApplyEditBlocksResult> {
  const fence = options.fence ?? DEFAULT_FENCE;
  const working = new Map<string, { content: string; isNew: boolean }>(options.start ?? []);
  const order: string[] = [...working.keys()];
  const failures: EditFailure[] = [];
  const applied: EditBlock[] = [];
  for (const block of blocks) {
    const filePath = block.filePath.trim().replace(/^\.\//, "");
    const normalized = { ...block, filePath };
    let entry = working.get(filePath);
    if (!entry) {
      const current = await readCurrent(filePath);
      if (current === null) {
        if (stripQuotedWrapping(block.search, filePath, fence).trim()) {
          failures.push({ block: normalized, kind: "missing_file" });
          continue;
        }
        entry = { content: "", isNew: true };
      } else {
        entry = { content: current, isNew: false };
      }
    }
    const result = applyEditBlock(entry.content, normalized, fence);
    if (!result.ok && options.acceptAlreadyApplied && result.failure.alreadyApplied) continue;
    if (!result.ok) {
      failures.push({ block: normalized, ...result.failure });
      continue;
    }
    if (!working.has(filePath)) order.push(filePath);
    working.set(filePath, { content: result.content, isNew: entry.isNew });
    applied.push(normalized);
  }
  return {
    files: order.map((filePath) => {
      const entry = working.get(filePath)!;
      return { filePath, newContent: entry.content, isNew: entry.isNew };
    }),
    failures,
    applied,
  };
}

/**
 * Aider's failure report ("# N SEARCH/REPLACE block(s) failed to match!"
 * with "Did you mean to match some of these actual lines"), extended with
 * the ambiguity, missing-file and malformed cases.
 */
export function editFailureFeedback(failures: readonly EditFailure[], passedCount: number, fence: Fence = DEFAULT_FENCE): string {
  const blocks = failures.length === 1 ? "block" : "blocks";
  let res = `# ${failures.length} SEARCH/REPLACE ${blocks} failed to match!\n`;
  for (const failure of failures) {
    const { filePath, search, replace } = failure.block;
    if (failure.kind === "malformed") {
      res += `\n## Malformed SEARCH/REPLACE block\n${failure.detail ?? ""}\n`;
      continue;
    }
    const heading =
      failure.kind === "ambiguous"
        ? `## SearchReplaceAmbiguousMatch: This SEARCH block matches more than one place in ${filePath}`
        : failure.kind === "missing_file"
          ? `## SearchReplaceMissingFile: ${filePath} does not exist, so a non-empty SEARCH cannot match`
          : `## SearchReplaceNoExactMatch: This SEARCH block failed to exactly match lines in ${filePath}`;
    res += `\n${heading}\n<<<<<<< SEARCH\n${search}=======\n${replace}>>>>>>> REPLACE\n\n`;
    if (failure.kind === "ambiguous" && failure.lines && failure.lines.length > 0) {
      res += `It matches at lines ${failure.lines.join(", ")}. Include more surrounding lines so the SEARCH section matches exactly one place.\n\n`;
    }
    if (failure.kind === "missing_file") {
      res += "To create a new file, use an empty SEARCH section and put the whole file in REPLACE.\n\n";
    }
    if (failure.didYouMean) {
      res += `Did you mean to match some of these actual lines from ${filePath}?\n\n${fence[0]}\n${failure.didYouMean}\n${fence[1]}\n\n`;
    }
    if (failure.alreadyApplied) {
      res += `Are you sure you need this SEARCH/REPLACE block?\nThe REPLACE lines are already in ${filePath}!\n\n`;
    }
  }
  res +=
    "The SEARCH section must exactly match an existing block of lines including all white space, comments, indentation, docstrings, etc\n";
  if (passedCount > 0) {
    const pblocks = passedCount === 1 ? "block" : "blocks";
    res += `\n# The other ${passedCount} SEARCH/REPLACE ${pblocks} were applied successfully.\nDon't re-send them.\nJust reply with fixed versions of the ${blocks} above that failed to match.\n`;
  }
  return res;
}
