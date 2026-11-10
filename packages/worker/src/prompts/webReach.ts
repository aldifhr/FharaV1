import { genericToolLoopPrompt, type ToolLoopPromptSet } from "@/prompts/toolLoop";

/**
 * The tool-loop wording for the Agent Reach web tool (plan 036).
 *
 * The model is told the tool is read-only and that a failed call carries a
 * reason it can act on (wrong channel, blocked URL, tool not installed).
 */
function webReachToolLoopPrompt(toolCount: number, catalog: string): string {
  return [
    `You have ${toolCount} web tool available (Agent Reach, read-only).`,
    "Use it when the answer needs public web or public platform content.",
    "To use it, reply with JSON only:",
    '{"tool":"web_reach","arguments":{"channel":"web","action":"search","query":"...","limit":5}}',
    "or reply with JSON only to finish:",
    '{"answer":"<your final answer>"}',
    "Return only one JSON object per reply.",
    "",
    "Available tools:",
    catalog,
  ].join("\n");
}

/** The prompt set the web tool loop runs with. */
export const webReachToolLoopPromptSet: ToolLoopPromptSet = {
  instruction: webReachToolLoopPrompt,
  nudge: genericToolLoopPrompt.nudge,
  unavailable: genericToolLoopPrompt.unavailable,
  result: genericToolLoopPrompt.result,
};
