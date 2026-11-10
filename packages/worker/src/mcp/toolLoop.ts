/**
 * Plan 009: bounded LLM tool loop over MCP tools.
 *
 * The loop itself lives in `tools/toolLoop.ts` (generic); this module keeps
 * the MCP-flavoured API and the MCP prompt wording.
 *
 * Budget note: `runLlm` is called once per iteration and must run the
 * pre-call budget gate before every call (the executor wires this). A
 * tool loop that bypassed the budget gate would be a defect.
 */

import type { LLMMessage } from "@/llm";
import type { McpToolDefinition } from "./types";
import {
  mcpToolLoopPrompt,
  mcpToolResultMessage,
  mcpToolUnavailable,
  MCP_TOOL_LOOP_NUDGE,
} from "@/prompts/mcpToolLoop";
import {
  runToolLoop,
  type ToolLoopCallTool,
  type ToolLoopResult,
} from "@/tools/toolLoop";

// Prompt text lives in `@/prompts/mcpToolLoop`; re-exported for existing importers.
export { mcpToolLoopInstruction } from "@/prompts/mcpToolLoop";

export interface ToolLoopOptions {
  tools: McpToolDefinition[];
  callTool: ToolLoopCallTool;
  /** One LLM step. The executor binds the budget gate + fallback handles. */
  runLlm: (messages: LLMMessage[]) => Promise<string>;
  messages: LLMMessage[];
  maxIterations?: number;
  signal?: AbortSignal;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
}

export async function runMcpToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  return runToolLoop({
    tools: options.tools,
    callTool: options.callTool,
    runLlm: options.runLlm,
    messages: options.messages,
    maxIterations: options.maxIterations,
    signal: options.signal,
    onEvent: options.onEvent,
    prompt: {
      instruction: mcpToolLoopPrompt,
      nudge: MCP_TOOL_LOOP_NUDGE,
      unavailable: mcpToolUnavailable,
      result: mcpToolResultMessage,
    },
  });
}
