/**
 * GOAT G13: the CTO's decision turn for a question (prompt + parser).
 *
 * The CTO decides technical and architecture questions only. The prompt
 * says so, and the parser holds it there: an option outside the offered
 * ones, an unparseable reply, or an answer that touches secrets, push or a
 * destructive action is escalated to the user instead of delivered. The
 * Convex side re-checks the same ceiling (decisionTurns.answer).
 */
import { extractJson } from "@/utils/json";
import { answerCrossesCeiling } from "@/api/convex/lib/questionPolicy";
import type { DecisionTurnSpec, DecisionVerdict } from "./runDecisionTurn";

export interface CtoQuestion {
  question: string;
  options: string[];
  /** Escalation kind (plan 022) when the question came from one. */
  kind?: string;
  /** What the asking agent was doing (subtask title and objective, task title). */
  context?: string;
}

const ANSWER_MAX = 1500;

export function ctoQuestionPrompt(input: CtoQuestion): string {
  const options = input.options.length > 0 ? input.options.map((option, index) => `${index + 1}. ${option}`).join("\n") : "(free answer)";
  return [
    "You are the CTO role of a software team in Fhara. A teammate stopped and needs a decision before it continues.",
    "You decide technical and architecture questions only: dependencies, schema and data model, file scope, API shape, libraries, patterns.",
    'Reply "escalate" instead of answering when the question involves secrets or credentials, pushing, merging or deploying, deleting or other destructive actions, security trade-offs, product or business choices, spending, or anything you are not sure of. The user answers those.',
    "Prefer the smallest change that keeps the code consistent. Do not widen the work beyond what the question needs.",
    "",
    `Question${input.kind ? ` (${input.kind.replace(/_/g, " ")})` : ""}: ${input.question}`,
    ...(input.context ? ["", `Context: ${input.context}`] : []),
    "",
    "Options:",
    options,
    "",
    'Reply with JSON only: {"verdict":"answer"|"escalate","option":"<one option, copied exactly, when options are given>","answer":"<the decision in one or two sentences>","rationale":"<why, one sentence>"}',
  ].join("\n");
}

const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

export function parseCtoVerdict(reply: string, input: CtoQuestion): DecisionVerdict {
  const parsed = extractJson(reply) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object") return { verdict: "escalate", rationale: "The CTO's reply did not parse" };
  const rationale = text(parsed.rationale, 500) || "No reason given";
  if (text(parsed.verdict, 20).toLowerCase() !== "answer") return { verdict: "escalate", rationale };
  let option = text(parsed.option, 200);
  if (input.options.length > 0) {
    const match = input.options.find((candidate) => candidate.toLowerCase() === option.toLowerCase());
    if (!match) return { verdict: "escalate", rationale: `The CTO picked no offered option (${option || "none"})` };
    option = match;
  } else {
    option = "";
  }
  const answer = text(parsed.answer, ANSWER_MAX) || option;
  if (!answer) return { verdict: "escalate", rationale: "The CTO gave no answer" };
  if (answerCrossesCeiling(answer, option)) return { verdict: "escalate", rationale: "The answer touches secrets, push or a destructive action" };
  return { verdict: "answer", answer, ...(option ? { chosenOption: option } : {}), rationale };
}

export const CTO_QUESTION_SPEC: DecisionTurnSpec<CtoQuestion> = {
  role: "cto",
  buildPrompt: ctoQuestionPrompt,
  parse: parseCtoVerdict,
};
