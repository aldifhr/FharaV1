/** The loop instruction appended when a server is available. */
export function mcpToolLoopInstruction(toolCount: number): string {
  return [
    `You have ${toolCount} workspace file tools available (MCP filesystem).`,
    "To use one, reply with JSON only:",
    '{"tool":"<tool-name>","arguments":{...}}',
    "or reply with JSON only to finish:",
    '{"answer":"<your final answer>"}',
    "Tool paths are absolute. Return only one JSON object per reply.",
  ].join("\n");
}

/** First tool-loop message: the protocol plus the tool catalog. */
export function mcpToolLoopPrompt(toolCount: number, catalog: string): string {
  return `${mcpToolLoopInstruction(toolCount)}\n\nAvailable tools:\n${catalog}`;
}

/** Nudge after a reply that was neither a tool call nor a final answer. */
export const MCP_TOOL_LOOP_NUDGE =
  "Reply with JSON only: {\"tool\":\"<name>\",\"arguments\":{...}} or {\"answer\":\"...\"}.";

/** Reply to a call of a tool that is not in the agent's permitted list. */
export function mcpToolUnavailable(toolName: string): string {
  return `Tool "${toolName}" is not available to you. Use one of the listed tools.`;
}

/** A tool result (or failure) handed back to the model. */
export function mcpToolResultMessage(toolName: string, text: string, isError: boolean | undefined): string {
  return isError
    ? `Tool "${toolName}" failed: ${text}`
    : `Tool "${toolName}" result:\n${text}`;
}
