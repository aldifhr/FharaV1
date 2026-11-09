import type { PlanSubtask } from "@/types";

/** Max characters of an invalid answer handed to the cheap repair retry. */
export const REPAIR_MAX_ANSWER_CHARS = 120_000;

/** System message of the cheap repair retry. */
export const REPAIR_SYSTEM_PROMPT = "You reformat answers into the requested file-block format. Never change code.";

/**
 * The code_change prompt: task, role, repository context, staged edits of
 * earlier subtasks, the two accepted answer formats and the rules.
 */
export function codeChangePrompt(input: {
  command: string;
  subtask: Pick<PlanSubtask, "title" | "description" | "allowedPaths">;
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
