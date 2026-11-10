/**
 * R9: commit message from the staged diff.
 *
 * `COMMIT_SYSTEM_PROMPT` is copied from Aider-AI/aider, commit 5dc9490,
 * aider/prompts.py `commit_system` (lines 6-23).
 * SPDX-License-Identifier: Apache-2.0. Copyright Aider-AI contributors.
 * Aider's note, kept: Conventional Commits text adapted from
 * https://www.conventionalcommits.org/en/v1.0.0/#summary (CC BY 3.0).
 *
 * Modified by Fhara: the `{language_instruction}` placeholder is removed
 * (commit messages are always English, AGENTS.md); the user message is
 * built like aider/repo.py `get_commit_message` ("# Diffs:" after the
 * context), with the diff truncated to a character budget.
 * See THIRD_PARTY_NOTICES.md.
 */

export const COMMIT_SYSTEM_PROMPT = `You are an expert software engineer that generates concise, \
one-line Git commit messages based on the provided diffs.
Review the provided context and diffs which are about to be committed to a git repo.
Review the diffs carefully.
Generate a one-line commit message for those changes.
The commit message should be structured as follows: <type>: <description>
Use these for <type>: fix, feat, build, chore, ci, docs, style, refactor, perf, test

Ensure the commit message:
- Starts with the appropriate prefix.
- Is in the imperative mood (e.g., "add feature" not "added feature" or "adding feature").
- Does not exceed 72 characters.

Reply only with the one-line commit message, without any additional text, explanations, or line breaks.
`;

/** Diff characters sent to the model (the rest is cut with a marker). */
export const COMMIT_DIFF_MAX_CHARS = 20_000;

/** Accepted message shape (Aider's types, one line, description ≤72). */
export const COMMIT_MESSAGE_RE = /^(fix|feat|build|chore|ci|docs|style|refactor|perf|test): .{1,72}$/;

/** The user message: optional context, then "# Diffs:" and the (truncated) diff. */
export function buildCommitMessagePrompt(diff: string, context?: string): string {
  const cut = diff.length > COMMIT_DIFF_MAX_CHARS ? `${diff.slice(0, COMMIT_DIFF_MAX_CHARS)}\n... (diff truncated)` : diff;
  return `${context ? `${context}\n` : ""}# Diffs:\n${cut}`;
}

/**
 * Clean a model reply into one commit line, or null when it does not match
 * the expected shape (the caller then keeps its fallback message).
 */
export function normalizeCommitMessage(reply: string): string | null {
  let line = (reply ?? "").trim().split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
  if (line.length >= 2 && line.startsWith('"') && line.endsWith('"')) line = line.slice(1, -1).trim();
  line = line.replace(/^`+|`+$/g, "").trim();
  return COMMIT_MESSAGE_RE.test(line) ? line : null;
}
