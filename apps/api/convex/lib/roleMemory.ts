/**
 * Role memory: each role (CTO, Designer, Frontend, Backend, QA, Reviewer,
 * DevOps, Researcher, Support) keeps its OWN notes per project, written by
 * the role itself after it finished work in a task, with no approval step.
 *
 * A role-memory row is a `memories` row with scope "agent", the role's
 * agentId AND a projectId ("role@project"). Legacy agent rows without a
 * projectId stay valid and keep meaning "this agent, every project". Role
 * rows are written UNPINNED (source "agent"), so they reach a prompt only
 * through full-text recall (lib/memoryRecall.ts) for that same role in that
 * same project; pinning stays a user action.
 *
 * Pure helpers only (no Convex APIs): shared by the backend upsert
 * (roleMemories.ts) and the worker (services/runner/roleLearnings.ts).
 */
import { redactSecrets } from "./secretPatterns";

/** Learnings one role may write after one task. */
export const ROLE_LEARNINGS_MAX = 5;
/** Rows one role keeps per project; the oldest unpinned agent-written rows go first. */
export const ROLE_MEMORY_CAP = 50;
export const ROLE_LEARNING_TITLE_MAX = 80;
export const ROLE_LEARNING_CONTENT_MAX = 600;
/** Token-set similarity at or above which two notes count as the same. */
export const ROLE_MEMORY_DUP_THRESHOLD = 0.6;

export const ROLE_LEARNING_KINDS = ["fact", "convention", "pitfall"] as const;
export type RoleLearningKind = (typeof ROLE_LEARNING_KINDS)[number];

export type RoleLearning = { title: string; content: string; kind: RoleLearningKind };

/** Lowercase, punctuation stripped, whitespace collapsed. */
export function normalizeNote(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(normalizeNote(text).split(" ").filter((t) => t.length >= 2));
}

/** Jaccard similarity of the two texts' token sets (0..1). */
export function noteSimilarity(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size && !right.size) return 1;
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * The existing note a learning duplicates: same normalized title, same
 * normalized content, or title+content similarity ≥ threshold. Best match
 * wins; null when none is close enough.
 */
export function findDuplicate<T extends { title: string; content: string }>(
  existing: readonly T[],
  item: { title: string; content: string },
  threshold: number = ROLE_MEMORY_DUP_THRESHOLD
): T | null {
  const title = normalizeNote(item.title);
  const content = normalizeNote(item.content);
  let best: T | null = null;
  let bestScore = 0;
  for (const row of existing) {
    if ((title && normalizeNote(row.title) === title) || (content && normalizeNote(row.content) === content)) return row;
    const score = Math.max(
      noteSimilarity(`${row.title} ${row.content}`, `${item.title} ${item.content}`),
      noteSimilarity(row.content, item.content)
    );
    if (score >= threshold && score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Rows to delete so a role keeps at most `cap` notes in a project. Only
 * UNPINNED rows written by the agent are ever evicted (oldest updatedAt
 * first); pinned rows and rows the user wrote are kept even past the cap.
 */
export function pickEvictions<T extends { pinned: boolean; source: "user" | "agent"; updatedAt: number }>(
  rows: readonly T[],
  cap: number = ROLE_MEMORY_CAP
): T[] {
  const over = rows.length - cap;
  if (over <= 0) return [];
  return rows
    .filter((row) => !row.pinned && row.source === "agent")
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, over);
}

/** A diff / patch / raw log never becomes a note. */
export function looksLikeRawDiff(text: string): boolean {
  if (/^diff --git |^@@ [-+]\d|^(?:---|\+\+\+) [ab]\//m.test(text)) return true;
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 4) return false;
  const changed = lines.filter((l) => /^[+-](?![+-])/.test(l)).length;
  return changed / lines.length >= 0.5;
}

/**
 * Clean one learning: secrets masked, diffs dropped, trimmed to the caps,
 * kind defaulted to "fact". Null when nothing usable is left.
 */
export function cleanLearning(raw: unknown): RoleLearning | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const rawTitle = typeof entry.title === "string" ? entry.title : "";
  const rawContent = typeof entry.content === "string" ? entry.content : "";
  if (looksLikeRawDiff(rawContent)) return null;
  const title = redactSecrets(rawTitle.replace(/\s+/g, " ").trim()).slice(0, ROLE_LEARNING_TITLE_MAX).trim();
  const content = redactSecrets(rawContent.replace(/\r\n/g, "\n").trim()).slice(0, ROLE_LEARNING_CONTENT_MAX).trim();
  if (!title || !content) return null;
  const kindRaw = String(entry.kind ?? "fact").trim().toLowerCase();
  const kind = (ROLE_LEARNING_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as RoleLearningKind) : "fact";
  return { title, content, kind };
}

function stripFence(text: string): string {
  const t = text.trim();
  const first = t.indexOf("```");
  const last = t.lastIndexOf("```");
  if (first === -1 || first === last) return t;
  const inner = t.slice(first, last);
  const nl = inner.indexOf("\n");
  return nl === -1 ? "" : inner.slice(nl + 1).trim();
}

/**
 * Parse a role's reply: `{"learnings":[...]}` or a bare array. Invalid
 * entries are dropped, duplicates inside the reply collapse, at most
 * ROLE_LEARNINGS_MAX survive. Null on malformed JSON.
 */
export function parseLearnings(raw: string): RoleLearning[] | null {
  const text = stripFence(raw ?? "");
  const objAt = text.indexOf("{");
  const arrAt = text.indexOf("[");
  let body: string;
  if (arrAt !== -1 && (objAt === -1 || arrAt < objAt)) body = text.slice(arrAt, text.lastIndexOf("]") + 1);
  else if (objAt !== -1) body = text.slice(objAt, text.lastIndexOf("}") + 1);
  else return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { learnings?: unknown }).learnings)
      ? (parsed as { learnings: unknown[] }).learnings
      : null;
  if (!list) return null;
  const out: RoleLearning[] = [];
  for (const entry of list) {
    if (out.length >= ROLE_LEARNINGS_MAX) break;
    const clean = cleanLearning(entry);
    if (!clean) continue;
    if (findDuplicate(out, clean)) continue;
    out.push(clean);
  }
  return out;
}
