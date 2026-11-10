import type { PlanSubtask } from "@/types";

/** Max characters of an invalid answer handed to the cheap repair retry. */
export const REPAIR_MAX_ANSWER_CHARS = 120_000;

/**
 * No-target rule: a fix or investigation for a feature/bug the repository
 * does not have must report "not found", never build the feature (live
 * sandbox run: "search bug" in an app with no search created
 * src/app/search/page.tsx and src/components/search-form.tsx).
 */
export const NO_TARGET_RULE =
  '- Fix / bug / investigation tasks: first find the code the task refers to. If that feature, bug or code does not exist in the repository, do NOT create it: return {"files":[],"findings":["Not found: <what the task refers to>. Checked: <files and paths you looked at>"]}. Never add new feature files to "fix" something that is not there.';

/**
 * Implementation quality rules shared by every implement/fix prompt
 * (code_change, native runtime). Each one closes a failure seen in a real
 * run: an unwired component, guessed library props, a hydration warning
 * "fixed" by hiding it, stray placeholder comments.
 */
export const IMPLEMENTATION_RULES: readonly string[] = [
  "- If you create a component, also edit the file that renders it (the existing page / layout / entry point that should use it); an unused component is not done.",
  "- When a typecheck error involves a library API, read the library's installed type definitions (node_modules/<pkg>/package.json \"types\" entry, node_modules/<pkg>/dist/*.d.ts) before retrying. Do not guess props or signatures.",
  "- Never fix a hydration warning by gating render on a mounted flag, calling setState in an effect to defer rendering, or putting suppressHydrationWarning on wrappers. Find the real server/client mismatch (time, randomness, locale, window/localStorage reads during render, invalid HTML nesting) and fix it; if it is not caused by this change, report it as pre-existing in findings instead.",
  "- Do not leave placeholder comments (\"TODO: implement\", \"... existing code ...\", \"rest unchanged\") in the files you return.",
  NO_TARGET_RULE,
];

/** System message of the cheap repair retry. */
export const REPAIR_SYSTEM_PROMPT = "You reformat answers into the requested file-block format. Never change code.";

/**
 * The code_change prompt: task, role, repository context, staged edits of
 * earlier subtasks, the two accepted answer formats and the rules.
 */
/**
 * Plan 022: the subtask's contract as prompt lines (empty when the plan
 * carries none). Shared by the code_change and native prompts.
 */
export function contractLines(
  subtask: Pick<PlanSubtask, "objective" | "constraints" | "deliverable" | "acceptance">
): string[] {
  const lines: string[] = [];
  if (subtask.objective) lines.push(`Objective: ${subtask.objective}`);
  if (subtask.constraints && subtask.constraints.length > 0) {
    lines.push(`Must not change: ${subtask.constraints.join("; ")}`);
  }
  if (subtask.deliverable) lines.push(`Deliverable: ${subtask.deliverable}`);
  if (subtask.acceptance && subtask.acceptance.length > 0) {
    lines.push(
      `Acceptance (checked after you deliver): ${subtask.acceptance
        .map((gate) => `${gate.criterion} [${gate.check}${gate.target ? `: ${gate.target}` : ""}]`)
        .join("; ")}`
    );
  }
  return lines.length > 0 ? ["Contract for this subtask:", ...lines] : [];
}

/** Escalation rules shared by every implement prompt (plan 022). */
export const ESCALATION_RULES: readonly string[] = [
  "- STOP and escalate instead of expanding scope when the change needs: a schema/migration change, a new dependency, a security-sensitive choice (auth, secrets, permissions, crypto), a file outside your declared ownership, or a decision on an ambiguous requirement with materially different outcomes.",
  '  To escalate, return {"files":[],"escalation":{"kind":"schema_change"|"new_dependency"|"security"|"out_of_scope"|"ambiguous","reason":"one sentence","detail":"the file or package","options":["outcome A","outcome B"]}} and nothing else. Do not stage a partial change.',
];

export function codeChangePrompt(input: {
  command: string;
  subtask: Pick<PlanSubtask, "title" | "description" | "allowedPaths" | "objective" | "constraints" | "deliverable" | "acceptance">;
  context: string;
  staged: string;
  qaMode?: string;
  mcpFindings: string;
}): string {
  const { command, subtask, context, staged, mcpFindings } = input;
  return (
    [
      `Task: ${command}`,
      `Your role in the plan: ${subtask.title} — ${subtask.description}`,
      ...contractLines(subtask),
      `Repository context:\n${context}`,
      ...(staged ? ["", staged] : []),
      "",
      "You cannot call tools or read more files: everything available is above. Do not emit tool calls.",
      "Return the files you want to change in ONE of these two formats.",
      "",
      "Format A (JSON):",
      '{"files":[{"filePath":"relative/path","newContent":"FULL file content"}]}',
      "",
      "Format B (file blocks) — RECOMMENDED for large files or code with many quotes/backslashes, since nothing needs JSON escaping:",
      "FILE: relative/path/to/file.ext",
      "````",
      "<complete file content, verbatim>",
      "````",
      "(one FILE block per file; use a four-backtick fence so ``` inside the file is safe; no other text.)",
      "",
      "With Format A you may add these optional top-level fields to the same JSON object (with Format B, append them as one JSON object after the last block):",
      input.qaMode === "never"
        ? '- "delegationRecommendation":{"targetCapability":"...","reason":"..."} when another capability should take over after you (never browser-testing: browser QA is disabled by policy).'
        : '- "delegationRecommendation":{"targetCapability":"...","reason":"..."} when another capability should take over after you (e.g. browser-testing for QA).',
      '- "findings":["short description", ...] for concrete problems you noticed but did not fix.',
      '- "escalation":{...} when you must stop for a decision (see the escalation rule below).',
      "",
      "STRICT FORMAT RULES:",
      "- Format A: use exactly the keys \"filePath\" and \"newContent\" (camelCase) on every entry; not \"path\", \"filename\", \"newText\", or \"content\".",
      "- Format A: return the raw JSON object only. No explanation, no markdown fences, no commentary.",
      "- Either format: give the complete file after your change, not a diff or patch.",
      "- If no files need changing, return exactly {\"files\":[]}.",
      "",
      "Rules:",
      ...(subtask.allowedPaths && subtask.allowedPaths.length > 0
        ? [`- Declared ownership for this subtask: ${subtask.allowedPaths.join(", ")}. Only modify files inside it.`]
        : []),
      "- Only relative paths inside the workspace.",
      "- Preserve unrelated behavior and code.",
      "- Do not touch lockfiles, secrets, .env files, or node_modules.",
      "- Keep the change minimal and focused on the task.",
      ...IMPLEMENTATION_RULES,
      ...ESCALATION_RULES,
      "- Type definitions you need but do not see above: reply with only their paths (e.g. node_modules/<pkg>/dist/index.d.ts) and they will be provided; do not guess the API.",
    ].join("\n") + mcpFindings
  );
}

/**
 * Prompt for the cheap "repair" retry: only the previous invalid answer,
 * no repository context, asking for the file-block format (no escaping).
 */
export function buildRepairPrompt(previousAnswer: string): string {
  return [
    "The answer below was meant to list complete file contents, but it could not be parsed.",
    "Reformat it WITHOUT changing any code into this exact format, one block per file:",
    "",
    "FILE: relative/path/to/file.ext",
    "````",
    "<the complete file content, verbatim, no escaping>",
    "````",
    "",
    "Rules: use a four-backtick fence; one FILE block per file; no JSON; no commentary.",
    "If a file's content is cut off in the answer, omit that file.",
    "",
    "Answer to reformat:",
    "<<<ANSWER",
    previousAnswer.slice(0, REPAIR_MAX_ANSWER_CHARS),
    "ANSWER>>>",
  ].join("\n");
}

/**
 * The full retry after an unparseable code_change answer: the original
 * payload, any files the model asked for, a note on what went wrong and
 * (for reference) the head of the previous answer.
 */
export function codeChangeRetryPrompt(input: {
  basePayload: string;
  requested: string;
  hadMarkup: boolean;
  previous: string;
}): string {
  const { basePayload, requested, previous } = input;
  const retryNote = input.hadMarkup
    ? "Your previous response was a tool call. Tools are NOT available here: the files you asked for are included above. Return ONLY the file changes now (Format A JSON or Format B file blocks)."
    : "Your previous response could not be parsed. Return the files again, preferably in Format B (FILE: path + four-backtick fenced full content, no JSON escaping), with no other text.";
  return `${basePayload}${requested ? `\n\n${requested}` : ""}\n\n${retryNote}${previous ? `\n\nPrevious response (for reference):\n${previous}` : ""}`;
}

/** Instruction for the read-only MCP exploration before the diff call. */
export function codeChangeExplorationInstruction(subtask: Pick<PlanSubtask, "title" | "description">): string {
  return `Explore the workspace with the available tools to gather context for this task: ${subtask.title} — ${subtask.description}`;
}

/** The MCP exploration answer, appended to the code_change payload. */
export function mcpFindingsBlock(answer: string): string {
  return `\n\nWorkspace tool findings:\n${answer.slice(0, 4000)}`;
}

/**
 * The one follow-up after the model answered with only file paths (asking
 * to read them): the original payload plus those files, asking for the edit.
 */
export function codeChangeFileRequestPrompt(input: { basePayload: string; requested: string; asked: string[] }): string {
  const { basePayload, requested, asked } = input;
  const found = requested
    ? requested
    : `None of the files you listed exist in the workspace: ${asked.join(", ")}.`;
  return [
    basePayload,
    "",
    found,
    "",
    "You listed files to read before editing; their current content is above. Do NOT list files again.",
    "Return ONLY the file changes now (Format A JSON or Format B file blocks). If the code the task refers to is not there, follow the no-target rule: {\"files\":[],\"findings\":[\"Not found: … Checked: …\"]}.",
  ].join("\n");
}

