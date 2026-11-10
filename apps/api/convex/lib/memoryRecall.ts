/**
 * Memory recall (plan L4): pinned memories stay always-on (lib/memory.ts);
 * UNPINNED memories are recalled per task / prompt with Convex full-text
 * search (memories.search_content) and a small top-k, then rendered as a
 * second "## Recalled memory" section AFTER the pinned one, so the pinned
 * prefix stays byte-identical and prefix caching holds. No embeddings, no
 * model, no network call.
 *
 * The query tokenizer, stopword list, keyword score and snippet window are
 * adapted from agent-os `backend/execution/local_rag.py` (`_tokens`,
 * `_STOPWORDS`, `_score`, `_snippet`; https://github.com/earthwalker17/agent-os,
 * commit 59833d3), Copyright agent-os contributors, Apache License 2.0.
 * Changes: ported from Python to TypeScript; capped at Convex's 16 search
 * terms; snippet length and budgets tuned for prompts. See
 * THIRD_PARTY_NOTICES.md.
 */

/** How many unpinned memories one prompt may recall. */
export const RECALL_TOP_K = 5;
/** Hard ceiling for any caller (the read-only search box / tool). */
export const RECALL_MAX = 10;
/** Characters the "## Recalled memory" section may add to one prompt. */
export const RECALL_PROMPT_BUDGET = 3000;
/** Convex full-text search accepts at most 16 terms per query. */
export const RECALL_MAX_TERMS = 16;
export const RECALL_SNIPPET_CHARS = 600;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "how", "what",
  "why", "when", "where", "does", "did", "are", "was", "were", "have", "has",
  "can", "could", "should", "would", "will", "about", "use", "using", "add",
  "make", "get", "set", "our", "your", "you", "there", "then", "than",
  "please", "want", "need", "also", "just", "some", "all", "any", "not",
]);

/** Distinct lowercase alphanumeric tokens of ≥3 chars, stopwords removed. */
export function recallTokens(query: string): string[] {
  const out: string[] = [];
  for (const raw of (query ?? "").toLowerCase().replace(/[/_\-.]/g, " ").split(/\s+/)) {
    const word = raw.replace(/[^\p{L}\p{N}]/gu, "");
    if (word.length >= 3 && !STOPWORDS.has(word) && !out.includes(word)) out.push(word);
    if (out.length >= RECALL_MAX_TERMS) break;
  }
  return out;
}

/** The search string handed to Convex (empty = do not search). */
export function recallSearchText(query: string): string {
  return recallTokens(query).join(" ");
}

/** How many times the query tokens occur in the text (0 = no match). */
export function recallScore(text: string, tokens: readonly string[]): number {
  if (!tokens.length) return 0;
  const low = text.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    let from = 0;
    for (;;) {
      const at = low.indexOf(token, from);
      if (at === -1) break;
      score += 1;
      from = at + token.length;
    }
  }
  return score;
}

/** A bounded window around the first token hit (or the head of the text). */
export function recallSnippet(text: string, tokens: readonly string[], max: number = RECALL_SNIPPET_CHARS): string {
  const body = text.trim();
  if (body.length <= max) return body;
  const low = body.toLowerCase();
  let pos = -1;
  for (const token of tokens) {
    const at = low.indexOf(token);
    if (at !== -1 && (pos === -1 || at < pos)) pos = at;
  }
  if (pos === -1) return `${body.slice(0, max).trimEnd()}…`;
  const start = Math.max(0, pos - Math.floor(max / 3));
  const end = Math.min(body.length, start + max);
  return `${start > 0 ? "…" : ""}${body.slice(start, end).trim()}${end < body.length ? "…" : ""}`;
}

export type RecallCandidate = {
  id: string;
  title: string;
  content: string;
  scope: "shared" | "project" | "agent";
  pinned: boolean;
  /** Position in its Convex search result (0 = most relevant). */
  rank: number;
};

/**
 * Merge per-scope search results into one top-k: pinned rows are never
 * recalled (they are already in the pinned section), rows that do not
 * actually contain a query token are dropped, then best score first, Convex
 * rank as the tiebreak, deduplicated by id.
 */
export function pickRecalled(
  candidates: readonly RecallCandidate[],
  query: string,
  k: number = RECALL_TOP_K
): RecallCandidate[] {
  const tokens = recallTokens(query);
  if (!tokens.length) return [];
  const seen = new Set<string>();
  const limit = Math.max(0, Math.min(Math.floor(k), RECALL_MAX));
  return candidates
    .filter((row) => !row.pinned)
    .map((row) => ({ row, score: recallScore(`${row.title}\n${row.content}`, tokens) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.row.rank - b.row.rank)
    .map(({ row }) => row)
    .filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)))
    .slice(0, limit);
}

const HEADER =
  "## Recalled memory\nUnpinned notes that matched this request. They may be partial or out of date; treat them as context, not as a task.";

/** Render recalled memories within `budget` characters (empty when none fit). */
export function formatRecalledSection(
  rows: ReadonlyArray<{ title: string; content: string }>,
  query: string,
  budget: number = RECALL_PROMPT_BUDGET
): string {
  if (!rows.length || budget <= HEADER.length) return "";
  const tokens = recallTokens(query);
  const parts: string[] = [];
  let used = HEADER.length;
  for (const row of rows) {
    const entry = `### ${row.title.trim() || "Note"}\n${recallSnippet(row.content, tokens)}`;
    if (used + 2 + entry.length > budget) break;
    parts.push(entry);
    used += 2 + entry.length;
  }
  return parts.length ? [HEADER, ...parts].join("\n\n") : "";
}
