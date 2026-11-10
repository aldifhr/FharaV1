/**
 * O7 research fan-out: N read-only Researcher angles in parallel, then one
 * synthesis node that depends on all of them (plan 043).
 *
 * The focus-angle list and the report / synthesis contract are adapted from
 * karayaman/cursor-cli-heavy@dbfc88f ccheavy.py:73-86 (`get_focus_for_index`)
 * and :324-421 (the synthesis input and the orchestration prompt's tagged
 * blocks). MIT, © 2025 Alper Karayaman (THIRD_PARTY_NOTICES.md). Changed by
 * Fhara: the angles become DAG subtasks (no separate orchestrator call), at
 * most 4 by default, each report is one tagged block, and the synthesis
 * reads the reports from the subtask outputs instead of files.
 */

/** Explicit trigger only: the task command starts with `/research`. */
const RESEARCH_TRIGGER = /^\s*\/research(?:\s+([2-6]))?\s+([\s\S]+)$/i;

export const RESEARCH_ANGLES = [
  "Factual research and direct information",
  "Analysis and metrics",
  "Alternative perspectives and criticisms",
  "Case studies and examples",
  "Implementation challenges and risks",
  "Future trends and research gaps",
  "Ethical, legal, and societal implications",
  "Contrarian view and edge cases",
] as const;

export const DEFAULT_FANOUT = 4;
export const MAX_FANOUT = 6;
/** Characters of one angle report the synthesis prompt asks for (the executor caps prior outputs too). */
export const REPORT_CHAR_BUDGET = 3_500;

export interface ResearchFanoutRequest {
  question: string;
  angles: number;
}

/** `/research <question>` or `/research 3 <question>` → the request; anything else → null. */
export function researchFanoutRequest(command: string): ResearchFanoutRequest | null {
  // Only the user's own line counts (the chat context block is appended after).
  const own = command.split("\n--- Conversation context ---")[0];
  const match = RESEARCH_TRIGGER.exec(own);
  if (!match) return null;
  const question = match[2].trim();
  if (!question) return null;
  const asked = match[1] ? Number(match[1]) : DEFAULT_FANOUT;
  return { question: question.slice(0, 2000), angles: Math.max(2, Math.min(MAX_FANOUT, asked)) };
}

export const angleKey = (index: number) => `ra-${index + 1}`;
export const SYNTHESIS_KEY = "synthesis";

/** One angle's subtask description (a Researcher, read-only). */
export function angleDescription(question: string, index: number, total: number): string {
  const n = index + 1;
  return [
    `You are research assistant RA-${n} of ${total} on this question:`,
    "",
    question,
    "",
    `Your focus: ${RESEARCH_ANGLES[index]}. Other assistants cover other angles, so stay on yours.`,
    "Read-only: search and read, do not modify files or run mutating commands.",
    "Cite every claim inline with a markdown link to its source (or a file:line for code).",
    `Keep the report under ${REPORT_CHAR_BUDGET} characters: key findings first, then evidence, then open questions.`,
    `Put the whole report inside one block: [BEGIN_RA_${n}] … [END_RA_${n}].`,
  ].join("\n");
}

/** The synthesis subtask description: it reads the angle reports from the previous outputs. */
export function synthesisDescription(question: string, total: number): string {
  const keys = Array.from({ length: total }, (_, i) => angleKey(i)).join(", ");
  return [
    "You are a senior analyst. Synthesize the research assistant reports into one answer to:",
    "",
    question,
    "",
    `The reports are the previous subtask outputs ${keys}, each inside [BEGIN_RA_n] … [END_RA_n].`,
    "Write: an executive summary, key findings, where the reports agree and disagree, and recommended next steps.",
    "Keep every source link the reports cite (inline markdown links). Do not invent sources.",
    "An angle that failed has no report: name the missing angle and answer from the reports you have, without filling the gap.",
    "Read-only: do not modify files or run mutating commands.",
  ].join("\n");
}

/**
 * The synthesis node of a `/research` fan-out plan: it runs on partial input
 * (the scheduler starts it once every angle settled and one succeeded).
 */
export function isResearchSynthesis(subtask: { key: string; dependencies: string[] }): boolean {
  return (
    subtask.key === SYNTHESIS_KEY &&
    subtask.dependencies.length >= 2 &&
    subtask.dependencies.every((dependency) => /^ra-\d+$/.test(dependency))
  );
}

/** The fan-out plan: N parallel angles + one synthesis that depends on all. */
export function researchFanoutPlan(request: ResearchFanoutRequest, maxSubtasks: number) {
  const total = Math.max(2, Math.min(request.angles, MAX_FANOUT, Math.max(2, maxSubtasks - 1)));
  const angles = Array.from({ length: total }, (_, index) => ({
    key: angleKey(index),
    title: `Research: ${RESEARCH_ANGLES[index]}`,
    description: angleDescription(request.question, index, total),
    kind: "research" as const,
    capability: "research",
    dependencies: [] as string[],
    order: index,
    objective: `Report on "${RESEARCH_ANGLES[index]}" for the question, with inline sources`,
    deliverable: `A cited report in one [BEGIN_RA_${index + 1}] block`,
  }));
  return {
    version: 1 as const,
    goal: request.question.slice(0, 500),
    strategy: "dag" as const,
    requiresApproval: false,
    maxConcurrency: total,
    subtasks: [
      ...angles,
      {
        key: SYNTHESIS_KEY,
        title: "Synthesize the research",
        description: synthesisDescription(request.question, total),
        kind: "research" as const,
        capability: "research",
        dependencies: angles.map((a) => a.key),
        order: total,
        objective: "One cited answer that combines every angle report",
        deliverable: "Executive summary, findings, agreements and disagreements, next steps",
      },
    ],
  };
}
