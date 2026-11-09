/**
 * Instruction for a read-only subtask (audit / research / analysis),
 * including the optional delegation/findings JSON footer.
 */
export function readOnlyInstruction(mode: "audit" | "research" | "analysis"): string {
  let instruction: string;
  if (mode === "audit") {
    instruction = [
      "Perform a read-only repository audit.",
      "Do not modify files and do not return file-change JSON.",
      "Report concrete findings with severity, file path, impact and a concise recommendation.",
      "If no issues are found, say so and summarize what you checked.",
      "Never claim a check passed unless the evidence is in the repository context.",
    ].join("\n");
  } else if (mode === "research") {
    instruction = [
      "Answer the user's question using only the repository context.",
      "Cite file paths for every claim.",
      "Do not modify files.",
      "If the context is insufficient, say exactly what is missing.",
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
