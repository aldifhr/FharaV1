/**
 * Prompt text for the bounded tool loop.
 *
 * The loop is generic: it asks the model for one JSON object per reply
 * (`{"tool":…,"arguments":{…}}` or `{"answer":…}`) and hands the tool result
 * back as the next user message. The wording lives here so the loop itself
 * stays free of prompt text.
 */

export interface ToolLoopPromptSet {
  /** The first message of the loop: the protocol plus the tool catalog. */
  instruction: (toolCount: number, catalog: string) => string;
  /** Nudge after a reply that was neither a tool call nor a final answer. */
  nudge: string;
  /** Reply to a call of a tool that is not in the agent's list. */
  unavailable: (toolName: string) => string;
  /** A tool result (or failure) handed back to the model. */
  result: (toolName: string, text: string, isError: boolean | undefined) => string;
}

/** The default wording, used by every tool provider that has no own text. */
export const genericToolLoopPrompt: ToolLoopPromptSet = {
  instruction: (toolCount, catalog) =>
    [
      `You have ${toolCount} tool${toolCount === 1 ? "" : "s"} available.`,
      "To use one, reply with JSON only:",
      '{"tool":"<tool-name>","arguments":{...}}',
      "or reply with JSON only to finish:",
      '{"answer":"<your final answer>"}',
      "Return only one JSON object per reply.",
      "",
      "Available tools:",
      catalog,
    ].join("\n"),
  nudge: 'Reply with JSON only: {"tool":"<name>","arguments":{...}} or {"answer":"..."}.',
  unavailable: (toolName) => `Tool "${toolName}" is not available to you. Use one of the listed tools.`,
  result: (toolName, text, isError) =>
    isError ? `Tool "${toolName}" failed: ${text}` : `Tool "${toolName}" result:\n${text}`,
};
