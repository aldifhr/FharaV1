/**
 * Research may end with suggested follow-up tasks: plain text the user can
 * start as new tasks. They are never created or executed automatically.
 */
export const SUGGESTED_FOLLOW_UPS =
  'If code changes would help, end with a short "Suggested follow-up tasks" list (plain text, one task per line). Do not make those changes and do not start them; the user decides.';

/**
 * Instruction for a read-only subtask (audit / research / analysis),
 * including the optional delegation/findings JSON footer.
 *
 * `webTool` (plan 036) adds the read-only web tool to the scope: the agent
 * may read public web content, so "only the repository context" is no
 * longer the whole truth.
 */
export function readOnlyInstruction(
  mode: "audit" | "research" | "analysis",
  options: { webTool?: boolean } = {}
): string {
  const webTool = options.webTool === true;
  let instruction: string;
  if (mode === "audit") {
    instruction = [
      "Perform a read-only repository audit.",
      "Do not modify files and do not return file-change JSON.",
      "Report concrete findings with severity, file path, impact and a concise recommendation.",
      "If no issues are found, say so and summarize what you checked.",
      webTool
        ? "Never claim a check passed unless the evidence is in the repository context or in a web source you read."
        : "Never claim a check passed unless the evidence is in the repository context.",
    ].join("\n");
  } else if (mode === "research") {
    instruction = [
      webTool
        ? "Answer the user's question using the repository context and, when it helps, the public web tool."
        : "Answer the user's question using only the repository context.",
      "Cite file paths for every claim.",
      "Do not modify files.",
      webTool ? "Say which claims come from the web and name the source." : "If the context is insufficient, say exactly what is missing.",
      SUGGESTED_FOLLOW_UPS,
    ].join("\n");
  } else {
    instruction = [
      "Respond to the user's message concisely.",
      "Do not modify files.",
      "If the user is greeting you, greet them and ask what change they want.",
    ].join("\n");
  }
  instruction +=
    '\nOptionally, end your reply with one single-line JSON object {"delegationRecommendation":{"targetCapability":"...","reason":"..."},"findings":["..."]} when another capability should follow up or you noticed concrete issues; omit it otherwise.';
  return instruction;
}

/** Tool-loop section listing the governed tools in the agent's scope. */
export function toolLoopSectionFor(toolNames: string[]): string {
  return `\n\nAvailable tools (search scope is your supportedTools): ${toolNames.join(", ")}`;
}

/** User content of a read-only call: instruction, repo/web context, request. */
export function readOnlyUserContent(input: {
  instruction: string;
  context: string;
  webBlock?: string;
  command: string;
}): string {
  const { instruction, context, command } = input;
  return `${instruction}\n\nRepository context:\n${context}${input.webBlock ? `\n\n${input.webBlock}` : ""}\n\nUser request: ${command}`;
}

/** User content of an MCP exploration loop (no web context). */
export function explorationUserContent(instruction: string, context: string, command: string): string {
  return `${instruction}\n\nRepository context:\n${context}\n\nUser request: ${command}`;
}
