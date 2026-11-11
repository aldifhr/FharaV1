/**
 * Project instruction chain for worker calls (DeepSeek Harness D4, pattern
 * only, MIT, Copyright (c) 2026 DeepSeek; no code copied). Reads the files;
 * the chain rules (order, budget, broadest dropped first) are the pure
 * helpers in lib/projectInstructions.ts, which chat shares.
 *
 * Chain: `<workspace>/AGENTS.md`, then `<workspace>/<dir>/AGENTS.md` for
 * each directory on the subtask's allowedPaths (shallow to deep), then the
 * user-global `~/.fhara/AGENTS.md`. Files are read confined to the
 * workspace (a symlink that leaves it is skipped) and capped per file.
 *
 * The OpenCode runtime reads AGENTS.md itself, so the native prompt never
 * gets this block (agentExecutor only adds it on the API path).
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyInstructionBudget,
  DEFAULT_INSTRUCTION_BUDGET_CHARS,
  formatInstructionChain,
  INSTRUCTION_FILE,
  nestedInstructionDirs,
  type InstructionChain,
  type InstructionSource,
} from "@/api/convex/lib/projectInstructions";

export { INSTRUCTION_BLOCK_HEADER } from "@/api/convex/lib/projectInstructions";

/** Per-file read cap (bytes): a huge AGENTS.md is cut by the budget anyway. */
const MAX_FILE_BYTES = 64 * 1024;

export interface InstructionChainOptions {
  budgetChars?: number;
  /** User-global file; null disables it. Default `~/.fhara/AGENTS.md`. */
  userGlobalPath?: string | null;
}

export function defaultUserInstructionsPath(): string {
  return path.join(os.homedir(), ".fhara", INSTRUCTION_FILE);
}

function readCapped(file: string): string | null {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return null;
    const raw = readFileSync(file);
    return raw.subarray(0, MAX_FILE_BYTES).toString("utf8").replace(/\uFFFD$/, "");
  } catch {
    return null;
  }
}

/** `<root>/<rel>/AGENTS.md` when it exists and stays inside the root. */
function readInside(rootReal: string, rel: string): string | null {
  const candidate = path.join(rootReal, rel, INSTRUCTION_FILE);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return null;
  }
  if (real !== path.join(rootReal, INSTRUCTION_FILE) && !real.startsWith(rootReal + path.sep)) return null;
  return readCapped(real);
}

/** The raw sources (before the budget) for one workspace and scope. */
export function readInstructionSources(
  workspacePath: string,
  allowedPaths: readonly string[] | undefined,
  options: InstructionChainOptions = {}
): InstructionSource[] {
  const sources: InstructionSource[] = [];
  let rootReal: string | null = null;
  try {
    rootReal = realpathSync(workspacePath);
  } catch {
    rootReal = null;
  }
  if (rootReal) {
    const root = readInside(rootReal, "");
    if (root !== null) sources.push({ scope: "root", path: INSTRUCTION_FILE, depth: 0, text: root });
    for (const dir of nestedInstructionDirs(allowedPaths)) {
      const text = readInside(rootReal, dir);
      if (text !== null) sources.push({ scope: "nested", path: `${dir}/${INSTRUCTION_FILE}`, depth: dir.split("/").length, text });
    }
  }
  const userPath = options.userGlobalPath === undefined ? defaultUserInstructionsPath() : options.userGlobalPath;
  if (userPath) {
    const text = readCapped(userPath);
    if (text !== null) sources.push({ scope: "user", path: `~/.fhara/${INSTRUCTION_FILE}`, depth: 0, text });
  }
  return sources;
}

export function projectInstructionChain(
  workspacePath: string,
  allowedPaths: readonly string[] | undefined,
  options: InstructionChainOptions = {}
): InstructionChain {
  return applyInstructionBudget(readInstructionSources(workspacePath, allowedPaths, options), options.budgetChars ?? DEFAULT_INSTRUCTION_BUDGET_CHARS);
}

/** The rendered block ("" when no file applies). Never throws. */
export function projectInstructionsBlock(
  workspacePath: string,
  allowedPaths: readonly string[] | undefined,
  options: InstructionChainOptions = {}
): string {
  try {
    return formatInstructionChain(projectInstructionChain(workspacePath, allowedPaths, options));
  } catch {
    return "";
  }
}
