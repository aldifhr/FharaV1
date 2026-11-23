/**
 * The Reviewer's read-only review loop (pure; the LLM call and the tool
 * runner are injected). Only the read-only repo tools can run: any other
 * tool the model asks for (write_file, run_command, apply_changes, …) is
 * answered "not available" by runRepoToolLoop and never reaches
 * `callTool`. A token gate runs BEFORE every LLM call (estimated chars/4).
 */
import { runRepoToolLoop, isRepoToolName, type RepoToolCall, type RepoToolResult } from "../chat/repoTools";
import { estimateTokens } from "./opinion";

export class ReviewerBudgetError extends Error {
  constructor(public readonly used: number, public readonly cap: number) {
    super(`Reviewer token cap reached (${used} of ${cap} tokens)`);
  }
}

export interface ReviewerLoopOptions {
  system: string;
  material: string;
  step: (system: string, messages: Array<{ role: string; content: string }>) => Promise<string>;
  callTool?: (call: RepoToolCall) => Promise<RepoToolResult>;
  maxToolCalls: number;
  tokenCap: number;
  /** Live counters, updated as calls happen (survive a thrown error). */
  usage?: { inputTokens: number; outputTokens: number; toolCalls: number };
}

export interface ReviewerLoopResult {
  answer: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  calls: RepoToolCall[];
}

export async function runReviewerLoop(opts: ReviewerLoopOptions): Promise<ReviewerLoopResult> {
  const usage = opts.usage ?? { inputTokens: 0, outputTokens: 0, toolCalls: 0 };
  const executed: RepoToolCall[] = [];
  const systemTokens = estimateTokens(opts.system);
  const step = async (messages: Array<{ role: string; content: string }>) => {
    const promptTokens = systemTokens + messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    // Pre-call gate: refuse the call when it would pass the cap.
    if (usage.inputTokens + usage.outputTokens + promptTokens > opts.tokenCap) {
      throw new ReviewerBudgetError(usage.inputTokens + usage.outputTokens + promptTokens, opts.tokenCap);
    }
    const content = await opts.step(opts.system, messages);
    usage.inputTokens += promptTokens;
    usage.outputTokens += estimateTokens(content);
    return { content };
  };
  const messages = [{ role: "user", content: opts.material }];
  if (!opts.callTool || opts.maxToolCalls <= 0) {
    const { content } = await step(messages);
    return { answer: content, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, toolCalls: 0, calls: [] };
  }
  const callTool = opts.callTool;
  const loop = await runRepoToolLoop({
    messages,
    maxCalls: opts.maxToolCalls,
    step,
    callTool: async (call) => {
      // Defence in depth: runRepoToolLoop already filters to read tools.
      if (!isRepoToolName(call.tool)) return { ok: false, text: `Tool "${call.tool}" is not available to the Reviewer.` };
      executed.push(call);
      usage.toolCalls += 1;
      return callTool(call);
    },
  });
  return { answer: loop.answer, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, toolCalls: loop.calls.length, calls: executed };
}
