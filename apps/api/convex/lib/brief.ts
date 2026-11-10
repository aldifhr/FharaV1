/**
 * Task brief (plan L3): the one place a task's state lives outside the
 * transcript — objective, who owns the next step, the latest result, open
 * questions and the next step. The worker keeps it current after each node
 * (deterministically, no LLM); the user can edit it on the task page. No
 * event is emitted on edit: the brief is a summary, not a message.
 *
 * Pure helpers shared by the Convex functions (briefs.ts), the worker
 * (services/runner/brief.ts) and the web task page. No Convex functions here.
 *
 * Adapted from openagents `workspace/backend/app/routers/briefs.py`
 * (https://github.com/openagents-org/openagents, commit 96d18e8),
 * Copyright OpenAgents contributors, Apache License 2.0. Changes: ported
 * from Python/FastAPI to TypeScript; field names camelCased; the owner is a
 * Fhara role; `updatedBy` is "user" | "worker"; question resolution helpers
 * added. See THIRD_PARTY_NOTICES.md.
 */

/** Caps from openagents briefs.py (MAX_TEXT, MAX_QUESTIONS, MAX_QUESTION_LEN). */
export const BRIEF_TEXT_MAX = 4000;
export const BRIEF_QUESTIONS_MAX = 20;
export const BRIEF_QUESTION_MAX = 500;

export const BRIEF_TEXT_FIELDS = ["objective", "owner", "latestResult", "nextStep"] as const;
export type BriefTextField = (typeof BRIEF_TEXT_FIELDS)[number];

export type TaskBrief = {
  objective?: string;
  owner?: string;
  latestResult?: string;
  openQuestions: string[];
  nextStep?: string;
  updatedAt?: number;
  updatedBy?: "user" | "worker";
};

/**
 * Partial update: a key that is absent (undefined) is left untouched; an
 * explicit `null` or empty string clears it.
 */
export type BriefPatch = {
  [K in BriefTextField]?: string | null;
} & { openQuestions?: string[] | null };

export const EMPTY_BRIEF: TaskBrief = { openQuestions: [] };

export function cleanBriefText(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text ? text.slice(0, BRIEF_TEXT_MAX) : undefined;
}

export function cleanBriefQuestions(items: readonly unknown[] | null | undefined): string[] {
  const out: string[] = [];
  for (const item of items ?? []) {
    if (typeof item !== "string") continue;
    const question = item.trim();
    if (question && !out.includes(question.slice(0, BRIEF_QUESTION_MAX))) {
      out.push(question.slice(0, BRIEF_QUESTION_MAX));
    }
    if (out.length >= BRIEF_QUESTIONS_MAX) break;
  }
  return out;
}

/** Apply a partial patch to a brief (absent = keep, null/"" = clear). */
export function applyBriefPatch(current: TaskBrief | null | undefined, patch: BriefPatch): TaskBrief {
  const next: TaskBrief = { ...EMPTY_BRIEF, ...(current ?? {}), openQuestions: [...(current?.openQuestions ?? [])] };
  for (const field of BRIEF_TEXT_FIELDS) {
    if (!(field in patch) || patch[field] === undefined) continue;
    const value = cleanBriefText(patch[field]);
    if (value === undefined) delete next[field];
    else next[field] = value;
  }
  if ("openQuestions" in patch && patch.openQuestions !== undefined) {
    next.openQuestions = cleanBriefQuestions(patch.openQuestions);
  }
  return next;
}

/** Add one open question (deduped, capped; the oldest drop off past the cap). */
export function addOpenQuestion(questions: readonly string[], question: string): string[] {
  const clean = question.trim().slice(0, BRIEF_QUESTION_MAX);
  if (!clean) return [...questions];
  const rest = questions.filter((q) => q !== clean);
  return [...rest, clean].slice(-BRIEF_QUESTIONS_MAX);
}

/** Remove an answered question (exact match after the same cleaning). */
export function removeOpenQuestion(questions: readonly string[], question: string | undefined): string[] {
  if (!question) return [...questions];
  const clean = question.trim().slice(0, BRIEF_QUESTION_MAX);
  return questions.filter((q) => q !== clean);
}

export function isBriefEmpty(brief: TaskBrief | null | undefined): boolean {
  if (!brief) return true;
  return BRIEF_TEXT_FIELDS.every((field) => !brief[field]) && brief.openQuestions.length === 0;
}

/** Characters the "Task brief" prompt section may use. */
export const BRIEF_PROMPT_BUDGET = 2000;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The "Task brief" prompt section (empty when the brief is empty). Rendered
 * at the top of every subtask's shared context. Bounded by `budget`.
 */
export function formatBriefSection(brief: TaskBrief | null | undefined, budget: number = BRIEF_PROMPT_BUDGET): string {
  if (isBriefEmpty(brief)) return "";
  const b = brief!;
  const lines = ["Task brief (kept current by the team; the user may have edited it — follow it):"];
  const push = (line: string) => {
    const used = lines.reduce((sum, l) => sum + l.length + 1, 0);
    if (used + line.length + 1 <= budget) lines.push(line);
  };
  if (b.objective) push(`- Objective: ${clip(b.objective, 600)}`);
  if (b.owner) push(`- Owner: ${clip(b.owner, 80)}`);
  if (b.latestResult) push(`- Latest result: ${clip(b.latestResult, 500)}`);
  if (b.nextStep) push(`- Next step: ${clip(b.nextStep, 500)}`);
  if (b.openQuestions.length) {
    push("- Open questions:");
    for (const q of b.openQuestions.slice(0, 8)) push(`  - ${clip(q, 200)}`);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

/**
 * The deterministic brief update after one node settles (no LLM). Names the
 * node and its outcome; the next step is the next pending node when known.
 * Leaves the objective and open questions alone.
 */
export function briefAfterNode(input: {
  nodeKey: string;
  title?: string;
  role?: string;
  status: "completed" | "failed" | "skipped" | "blocked" | string;
  summary?: string;
  /** `role` is the display label; `owner` the role key stored as the owner. */
  next?: { key: string; title?: string; role?: string; owner?: string } | null;
}): BriefPatch {
  const label = input.title ? `${input.nodeKey} (${clip(input.title, 120)})` : input.nodeKey;
  const outcome =
    input.status === "completed" ? "completed" : input.status === "failed" ? "failed" : input.status;
  const summary = input.summary ? `: ${clip(input.summary, 400)}` : "";
  const patch: BriefPatch = {
    latestResult: `${input.role ? `${input.role} · ` : ""}${label} ${outcome}${summary}`,
  };
  if (input.next) {
    patch.nextStep = `${input.next.role ? `${input.next.role} · ` : ""}${input.next.key}${input.next.title ? ` (${clip(input.next.title, 120)})` : ""}`;
    const owner = input.next.owner ?? input.next.role;
    if (owner) patch.owner = owner;
  }
  return patch;
}
