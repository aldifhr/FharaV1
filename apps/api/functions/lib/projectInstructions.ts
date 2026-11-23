/**
 * Project instruction chain (pure; shared by the worker and chat).
 *
 * Pattern from DeepSeek Harness (MIT, Copyright (c) 2026 DeepSeek): the
 * project-instructions loader that walks AGENTS.md files from the root to
 * the working scope. No code copied.
 *
 * The chain for one call is: the repository root `AGENTS.md`, then the
 * nested `AGENTS.md` files on the directories a subtask may touch (its
 * `allowedPaths`, shallow to deep), then the user-global file
 * (`~/.fhara/AGENTS.md`). The chain has one character budget. Over budget,
 * the broadest file is dropped first: the user-global file, then the root,
 * then nested files from the shallowest. Only the last remaining (most
 * specific) file is ever truncated.
 */

export const INSTRUCTION_FILE = "AGENTS.md";
/** Characters for the whole chain (about 2k tokens). */
export const DEFAULT_INSTRUCTION_BUDGET_CHARS = 8_000;
/** First line of the rendered block; also how a prompt is checked for it. */
export const INSTRUCTION_BLOCK_HEADER = "Project instructions (AGENTS.md; later files are more specific and win on conflict; must follow):";
/** At most this many nested directories are probed per call. */
export const MAX_NESTED_DIRS = 16;

export type InstructionScope = "root" | "nested" | "user";

export interface InstructionSource {
  scope: InstructionScope;
  /** Display path: `AGENTS.md`, `src/AGENTS.md`, `~/.fhara/AGENTS.md`. */
  path: string;
  /** Directory depth for nested files (root 0); ignored for the user file. */
  depth: number;
  text: string;
}

export interface InstructionEntry extends InstructionSource {
  truncated: boolean;
}

export interface InstructionChain {
  entries: InstructionEntry[];
  /** Display paths dropped for the budget, broadest first. */
  dropped: string[];
}

const GLOB_CHAR = /[*?[\]{}!]/;

/**
 * The directories (excluding the root) whose AGENTS.md applies to a set of
 * allowedPaths, shallow to deep. A glob segment ends the walk (`src/**` →
 * `src`); a last segment that looks like a file is not a directory.
 */
export function nestedInstructionDirs(allowedPaths: readonly string[] | undefined): string[] {
  const dirs = new Set<string>();
  for (const raw of allowedPaths ?? []) {
    const trimmed = raw.trim().replace(/\\/g, "/");
    if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) continue;
    const endsWithSlash = trimmed.endsWith("/");
    const segments = trimmed.split("/").filter((segment) => segment !== "" && segment !== ".");
    if (segments.some((segment) => segment === ".." || segment.startsWith("."))) continue;
    const kept: string[] = [];
    let sawGlob = false;
    for (const segment of segments) {
      if (GLOB_CHAR.test(segment)) {
        sawGlob = true;
        break;
      }
      kept.push(segment);
    }
    const last = kept[kept.length - 1];
    if (!sawGlob && !endsWithSlash && last !== undefined && kept.length === segments.length && /\.[A-Za-z0-9]+$/.test(last)) kept.pop();
    for (let index = 1; index <= kept.length; index += 1) dirs.add(kept.slice(0, index).join("/"));
  }
  return [...dirs]
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .slice(0, MAX_NESTED_DIRS);
}

/** Broadness rank: lower is broader and is dropped first. */
function broadness(source: InstructionSource): number {
  if (source.scope === "user") return -2;
  if (source.scope === "root") return -1;
  return source.depth;
}

/** Display order: root, nested shallow → deep, then the user-global file. */
function displayRank(source: InstructionSource): number {
  if (source.scope === "root") return -1;
  if (source.scope === "user") return Number.MAX_SAFE_INTEGER;
  return source.depth;
}

/** Cut at a code-point boundary (never a lone surrogate). */
function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

export const TRUNCATION_NOTE = "\n… (truncated to fit the instruction budget)";

/**
 * Fit the sources into `budgetChars`: drop the broadest until the rest fit,
 * and truncate only when one file is left and it is still over.
 */
export function applyInstructionBudget(
  sources: readonly InstructionSource[],
  budgetChars: number = DEFAULT_INSTRUCTION_BUDGET_CHARS
): InstructionChain {
  const budget = Math.max(0, Math.floor(budgetChars));
  const kept = sources
    .map((source) => ({ ...source, text: source.text.trim() }))
    .filter((source) => source.text !== "");
  const dropOrder = [...kept].sort((a, b) => broadness(a) - broadness(b) || a.path.localeCompare(b.path));
  const dropped: string[] = [];
  const size = (list: InstructionSource[]) => list.reduce((sum, source) => sum + source.text.length, 0);
  let remaining = kept;
  for (const candidate of dropOrder) {
    if (size(remaining) <= budget || remaining.length <= 1) break;
    remaining = remaining.filter((source) => source !== candidate);
    dropped.push(candidate.path);
  }
  const entries: InstructionEntry[] = remaining
    .sort((a, b) => displayRank(a) - displayRank(b) || a.path.localeCompare(b.path))
    .map((source) => ({ ...source, truncated: false }));
  if (entries.length === 1 && entries[0].text.length > budget) {
    const room = Math.max(0, budget - TRUNCATION_NOTE.length);
    entries[0] = { ...entries[0], text: `${cutText(entries[0].text, room)}${TRUNCATION_NOTE}`, truncated: true };
  }
  return { entries, dropped };
}

/** The chain as one prompt block; empty when there is nothing to say. */
export function formatInstructionChain(chain: InstructionChain): string {
  if (chain.entries.length === 0) return "";
  const parts = chain.entries.map((entry) => `--- ${entry.path} ---\n${entry.text}`);
  const note = chain.dropped.length > 0 ? `\n(Left out for the instruction budget: ${chain.dropped.join(", ")}.)` : "";
  return `${INSTRUCTION_BLOCK_HEADER}\n${parts.join("\n\n")}${note}`;
}
