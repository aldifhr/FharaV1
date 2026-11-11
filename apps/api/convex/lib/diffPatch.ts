// Portions adapted from Paradev, formerly Superset (https://github.com/paradevai/paradev, cloned from github.com/superset-sh/superset @ ce98da26),
// packages/host-service/src/trpc/router/git/utils/diff-patch.ts (CONFIG_ARGS, BASE_ARGS, MAX_PATCH_BYTES, PatchBudget, keepCompleteSections).
// MIT License, Copyright (c) 2025-2026 Superset Inc.
// See THIRD_PARTY_NOTICES.md.
//
// Changed by Fhara (Paradev A1): no spawn here. Fhara's own `gitExec`
// (worktreeNode.ts, execFileSync with a scrubbed env) runs git through the
// injected `GitRun` with a maxBuffer just past the budget, so this module
// stays pure (no node: imports) and the worker tests drive it on a real
// repo. A truncated patch ends with a `\ ` marker line, which diff parsers
// (DiffCard included) skip like git's "\ No newline at end of file".

import { type ChangesetFile, filesFromGitZ } from "./changeset";

/** Context lines each hunk carries. */
const PATCH_CONTEXT_LINES = 3;

/** Most patch text one request may build. 32 MB is far past any patch a person reads. */
export const MAX_PATCH_BYTES = 32 * 1024 * 1024;

/** File lists (name-status, numstat) are bounded separately: paths only. */
const MAX_LIST_BYTES = 8 * 1024 * 1024;

export const BASE_ARGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", `--unified=${PATCH_CONTEXT_LINES}`];

/**
 * `git`-level config every diff runs with, so the user's gitconfig cannot
 * change the patch shape: `diff.mnemonicPrefix`, `diff.noprefix` and
 * `diff.srcPrefix`/`dstPrefix` would replace the `a/` `b/` prefixes, and
 * `core.quotePath` would escape a non-ASCII path into `"a/caf\303\251.txt"`.
 * Unknown config keys are ignored by older gits.
 */
export const CONFIG_ARGS = [
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.srcPrefix=a/",
  "-c",
  "diff.dstPrefix=b/",
  "-c",
  "core.quotePath=false",
];

/** One request's shared byte allowance. */
export class PatchBudget {
  private remaining: number;

  constructor(limit: number) {
    this.remaining = limit;
  }

  get exhausted(): boolean {
    return this.remaining <= 0;
  }

  /** Grants up to `bytes`, returning how many. */
  take(bytes: number): number {
    const granted = Math.min(bytes, this.remaining);
    this.remaining -= granted;
    return granted;
  }
}

/** Every content line is prefixed (` `, `+`, `-`), so this at a line start is a real header. */
const SECTION_HEADER = "diff --git ";

/**
 * Whole file sections only: half a section would render as a diff silently
 * missing its hunks. `overflow` is the start of the refused bytes; when it
 * opens the next section, the cut landed on a boundary.
 */
export function keepCompleteSections(patch: string, overflow: string): string {
  if (overflow.startsWith(SECTION_HEADER)) return patch;
  const lastHeader = patch.lastIndexOf(`\n${SECTION_HEADER}`);
  if (lastHeader === -1) return "";
  return patch.slice(0, lastHeader + 1);
}

export function truncationMarker(maxBytes: number): string {
  const size = maxBytes >= 1024 * 1024 ? `${Math.round(maxBytes / (1024 * 1024))} MB` : `${maxBytes} bytes`;
  return `\\ Fhara: diff truncated at ${size}; later files are listed but not shown\n`;
}

/** Runs git with argv and a maxBuffer; `overflowed` when git wrote more than that. */
export type GitRun = (args: string[], maxBuffer: number) => { stdout: string; overflowed: boolean };

/** Bounds one git output to `maxBytes`, cutting on a section boundary. */
export function boundPatch(stdout: string, maxBytes: number): { patch: string; truncated: boolean } {
  // TextEncoder, not Buffer: this module is pure and also loads outside Node.
  const bytes = new TextEncoder().encode(stdout);
  const budget = new PatchBudget(maxBytes);
  const granted = budget.take(bytes.byteLength);
  if (granted === bytes.byteLength) return { patch: stdout, truncated: false };
  const decode = (from: number, to: number) => new TextDecoder().decode(bytes.subarray(from, to));
  const overflow = decode(granted, granted + SECTION_HEADER.length);
  return { patch: keepCompleteSections(decode(0, granted), overflow) + truncationMarker(maxBytes), truncated: true };
}

export interface BranchPatch {
  patch: string;
  truncated: boolean;
  files: ChangesetFile[];
}

/** `base..head` patch and file list with the safe config, bounded by `maxBytes`. */
export function buildBranchPatch(run: GitRun, base: string, head: string, maxBytes = MAX_PATCH_BYTES): BranchPatch {
  const range = `${base}..${head}`;
  // A little past the budget, so the overflow sample can tell a boundary cut.
  const out = run([...CONFIG_ARGS, "diff", ...BASE_ARGS, range], maxBytes + SECTION_HEADER.length);
  const { patch, truncated } = boundPatch(out.stdout, maxBytes);
  const listArgs = [...CONFIG_ARGS, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "-z"];
  const nameStatus = run([...listArgs, "--name-status", range], MAX_LIST_BYTES);
  const numstat = run([...listArgs, "--numstat", range], MAX_LIST_BYTES);
  return { patch, truncated: truncated || out.overflowed, files: filesFromGitZ(nameStatus.stdout, numstat.stdout) };
}
