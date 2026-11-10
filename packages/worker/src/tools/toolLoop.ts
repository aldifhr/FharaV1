/**
 * Bounded LLM tool loop (generic).
 *
 * The worker has no native function-calling: the model replies
 * `{"tool":"…","arguments":{…}}` or `{"answer":"…"}`, the loop executes the
 * tool and feeds the result back as the next user message. Bounded by
 * `maxIterations`.
 *
 * The loop is provider-agnostic: the caller binds the tools, the executor
 * and the prompt wording (see `prompts/toolLoop.ts`). The MCP tool loop
 * (`mcp/toolLoop.ts`) is a thin wrapper around this one.
 *
 * Budget note: `runLlm` is called once per iteration and must run the
 * pre-call budget gate before every call (the executor wires this). A tool
 * loop that bypassed the budget gate would be a defect.
 */

import type { LLMMessage } from "@/llm";
import { extractJson } from "@/utils/json";
import { genericToolLoopPrompt, type ToolLoopPromptSet } from "@/prompts/toolLoop";

export interface ToolLoopTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ToolLoopCallToolArgs {
  tool: string;
  args: Record<string, unknown>;
}

/** Bound to one provider session: returns a tool result; never throws. */
export type ToolLoopCallTool = (call: ToolLoopCallToolArgs) => Promise<{
  ok: boolean;
  text: string;
  isError: boolean;
  error?: string;
}>;

export interface ToolLoopOptions {
  tools: ToolLoopTool[];
  callTool: ToolLoopCallTool;
  /** One LLM step. The executor binds the budget gate + fallback handles. */
  runLlm: (messages: LLMMessage[]) => Promise<string>;
  messages: LLMMessage[];
  maxIterations?: number;
  signal?: AbortSignal;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
  /** Prompt wording; defaults to the generic protocol. */
  prompt?: ToolLoopPromptSet;
}

export interface ToolLoopResult {
  answer: string;
  /** How many tool calls were executed (0 = model answered directly). */
  toolCalls: number;
  /** All tool results, in order (for the final prompt). */
  toolResults: Array<{ tool: string; text: string }>;
}

function toolCatalog(tools: ToolLoopTool[]): string {
  return tools
    .map((tool) => {
      const schema = JSON.stringify(tool.inputSchema ?? {}).slice(0, 400);
      return `tool "${tool.name}"${tool.description ? `: ${tool.description}` : ""} (arguments JSON schema: ${schema})`;
    })
    .join("\n");
}

export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const maxIterations = options.maxIterations ?? 6;
  const prompt = options.prompt ?? genericToolLoopPrompt;
  const messages: LLMMessage[] = [...options.messages];
  const toolResults: ToolLoopResult["toolResults"] = [];
  let toolCalls = 0;

  if (options.tools.length > 0) {
    messages.push({
      role: "user",
      content: prompt.instruction(options.tools.length, toolCatalog(options.tools)),
    });
  }

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (options.signal?.aborted) break;
    const raw = await options.runLlm(messages);
    const parsed = extractJson(raw) as Record<string, unknown> | null;
    if (parsed && typeof parsed.answer === "string" && parsed.answer.trim()) {
      return { answer: parsed.answer, toolCalls, toolResults };
    }

    const toolName = typeof parsed?.tool === "string" ? parsed.tool : null;
    const toolArgs =
      parsed?.arguments && typeof parsed.arguments === "object" && !Array.isArray(parsed.arguments)
        ? (parsed.arguments as Record<string, unknown>)
        : null;

    if (!toolName || !toolArgs) {
      // Not a tool call and not a final answer: nudge once and continue the
      // bounded loop. Never emit free-form prose as the answer.
      messages.push({
        role: "user",
        content: prompt.nudge,
      });
      continue;
    }

    if (!options.tools.some((t) => t.name === toolName)) {
      // The model hallucinated a filtered-out tool: treat as a denial, not
      // a crash, and let it pick a listed tool.
      messages.push({
        role: "user",
        content: prompt.unavailable(toolName),
      });
      continue;
    }

    toolCalls += 1;
    const result = await options.callTool({ tool: toolName, args: toolArgs });
    toolResults.push({ tool: toolName, text: result.text });
    messages.push({
      role: "user",
      content: prompt.result(toolName, result.text, result.isError),
    });
    options.onEvent?.("tool.loop_iteration", { tool: toolName, iteration, isError: result.isError });
  }

  const toolSummary = toolResults
    .map((r) => `### ${r.tool}\n${r.text.slice(0, 2_000)}`)
    .join("\n\n")
    .slice(0, 12_000);
  return {
    answer: toolSummary ? `Tool findings:\n\n${toolSummary}` : "No tool results.",
    toolCalls,
    toolResults,
  };
}
