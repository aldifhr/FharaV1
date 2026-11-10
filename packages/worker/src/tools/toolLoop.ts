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
 *
 * R10: old tool output is pruned by token budget (`pruneToolOutputs`,
 * ported from opencode v1.0.0 session/compaction.ts `prune()`, MIT,
 * Copyright (c) 2025 opencode; modified by Fhara: operates on the loop's
 * tool-result messages instead of session parts), and the loop stops when
 * the stuck detector (`utils/stuckDetector.ts`, from the OpenHands SDK)
 * sees a repeating pattern.
 */

import type { LLMMessage } from "@/llm";
import { extractJson } from "@/utils/json";
import { genericToolLoopPrompt, type ToolLoopPromptSet } from "@/prompts/toolLoop";
import { StuckDetector, type StuckDetectionThresholds, type StuckEvent, type StuckPattern } from "@/utils/stuckDetector";
import { redactText } from "@/utils/redact";

/** opencode PRUNE_PROTECT: newest tool output (tokens) that is never pruned. */
export const PRUNE_PROTECT_TOKENS = 40_000;
/** opencode PRUNE_MINIMUM: prune only when it frees more than this (tokens). */
export const PRUNE_MINIMUM_TOKENS = 20_000;
/** What a pruned tool result is replaced with. */
export const PRUNED_TOOL_OUTPUT = "[pruned]";
/** Final "Tool findings" answer: total and per-result character budget, newest first. */
export const TOOL_SUMMARY_MAX_CHARS = 12_000;
export const TOOL_SUMMARY_RESULT_CHARS = 2_000;

/** opencode Token.estimate: chars / 4. */
export function estimateTokens(text: string): number {
  return Math.max(0, Math.round((text || "").length / 4));
}

/**
 * opencode `prune()`: walk back from the newest tool output, skip the newest
 * `protectNewest` results, keep `protect` tokens, and mark everything older
 * for pruning, but only when that frees more than `minimum` tokens. An
 * already-pruned result ends the walk (everything before it is pruned too).
 * Returns the indexes (into `outputs`) to prune.
 */
export function pruneToolOutputs(
  outputs: ReadonlyArray<{ text: string; pruned?: boolean }>,
  options: { protect?: number; minimum?: number; protectNewest?: number } = {}
): { prune: number[]; pruned: number; total: number } {
  const protect = options.protect ?? PRUNE_PROTECT_TOKENS;
  const minimum = options.minimum ?? PRUNE_MINIMUM_TOKENS;
  const protectNewest = options.protectNewest ?? 2;
  let total = 0;
  let pruned = 0;
  const toPrune: number[] = [];
  for (let index = outputs.length - 1 - protectNewest; index >= 0; index -= 1) {
    const output = outputs[index];
    if (output.pruned) break;
    const estimate = estimateTokens(output.text);
    total += estimate;
    if (total > protect) {
      pruned += estimate;
      toPrune.push(index);
    }
  }
  return { prune: pruned > minimum ? toPrune : [], pruned, total };
}

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
  /** Stuck detector thresholds; `false` turns detection off. */
  stuckDetection?: Partial<StuckDetectionThresholds> | false;
  /** Pruning budget overrides (tokens); defaults are opencode's 40k / 20k. */
  prune?: { protect?: number; minimum?: number };
}

export interface ToolLoopResult {
  answer: string;
  /** How many tool calls were executed (0 = model answered directly). */
  toolCalls: number;
  /** All tool results, in order (for the final prompt). */
  toolResults: Array<{ tool: string; text: string }>;
  /** Set when the stuck detector ended the loop. */
  stuck?: { pattern: StuckPattern; description: string };
  /** Tool results whose output was pruned from the conversation. */
  prunedResults?: number;
}

/** Newest-first budget for the final findings; older results show as pruned. */
export function summarizeToolResults(
  results: ReadonlyArray<{ tool: string; text: string }>,
  maxChars = TOOL_SUMMARY_MAX_CHARS,
  perResult = TOOL_SUMMARY_RESULT_CHARS
): string {
  const sections: string[] = [];
  let used = 0;
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const { tool, text } = results[index];
    const room = maxChars - used;
    const body = room > 0 ? text.slice(0, Math.min(perResult, room)) : PRUNED_TOOL_OUTPUT;
    used += room > 0 ? body.length : 0;
    sections.unshift(`### ${tool}\n${body}`);
  }
  return sections.join("\n\n");
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
  const detector = options.stuckDetection === false ? null : new StuckDetector(options.stuckDetection);
  const events: StuckEvent[] = [{ kind: "user_message", text: "task" }];
  // Tool-result messages in the conversation, for budget pruning.
  const outputs: Array<{ messageIndex: number; tool: string; text: string; isError: boolean; pruned?: boolean }> = [];
  let prunedResults = 0;
  let stuck: ToolLoopResult["stuck"];
  const checkStuck = (): boolean => {
    if (!detector) return false;
    const verdict = detector.isStuck(events);
    if (!verdict.isStuck || !verdict.pattern) return false;
    stuck = { pattern: verdict.pattern, description: verdict.description ?? verdict.pattern };
    options.onEvent?.("tool.loop_stuck", { pattern: verdict.pattern, repetitions: verdict.repetitions ?? null, description: stuck.description, toolCalls });
    return true;
  };
  const pruneOld = () => {
    const { prune, pruned } = pruneToolOutputs(outputs, options.prune);
    if (prune.length === 0) return;
    for (const index of prune) {
      const output = outputs[index];
      output.pruned = true;
      messages[output.messageIndex] = { role: "user", content: prompt.result(output.tool, PRUNED_TOOL_OUTPUT, output.isError) };
    }
    prunedResults += prune.length;
    options.onEvent?.("tool.loop_pruned", { results: prune.length, tokens: pruned });
  };

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
      events.push({ kind: "agent_message", text: raw });
      if (checkStuck()) break;
      messages.push({
        role: "user",
        content: prompt.nudge,
      });
      continue;
    }

    if (!options.tools.some((t) => t.name === toolName)) {
      // The model hallucinated a filtered-out tool: treat as a denial, not
      // a crash, and let it pick a listed tool.
      events.push({ kind: "action", tool: toolName, args: JSON.stringify(toolArgs) });
      events.push({ kind: "error", tool: toolName, error: "unavailable" });
      if (checkStuck()) break;
      messages.push({
        role: "user",
        content: prompt.unavailable(toolName),
      });
      continue;
    }

    toolCalls += 1;
    // L2: a tool result goes back to the LLM, into events and the final
    // findings: mask secrets (known values + shapes) before any of them.
    const rawResult = await options.callTool({ tool: toolName, args: toolArgs });
    const result = { ...rawResult, text: redactText(rawResult.text) };
    toolResults.push({ tool: toolName, text: result.text });
    outputs.push({ messageIndex: messages.length, tool: toolName, text: result.text, isError: result.isError });
    messages.push({
      role: "user",
      content: prompt.result(toolName, result.text, result.isError),
    });
    options.onEvent?.("tool.loop_iteration", { tool: toolName, iteration, isError: result.isError });
    events.push({ kind: "action", tool: toolName, args: JSON.stringify(toolArgs) });
    events.push(
      result.isError
        ? { kind: "error", tool: toolName, error: result.text }
        : { kind: "observation", tool: toolName, text: result.text }
    );
    pruneOld();
    if (checkStuck()) break;
  }

  const toolSummary = summarizeToolResults(toolResults);
  const stuckLine = stuck ? `Stopped early: ${stuck.description}.` : "";
  return {
    answer: toolSummary
      ? `${stuckLine ? `${stuckLine}\n\n` : ""}Tool findings:\n\n${toolSummary}`
      : stuckLine || "No tool results.",
    toolCalls,
    toolResults,
    ...(stuck ? { stuck } : {}),
    ...(prunedResults > 0 ? { prunedResults } : {}),
  };
}
