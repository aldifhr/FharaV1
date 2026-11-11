/**
 * DeepSeek Harness D4 (pattern only, MIT, Copyright (c) 2026 DeepSeek): the
 * user turn of an API-path worker call. Stable part first (the project
 * instruction chain for this subtask's allowedPaths), then the call's own
 * content, then the volatile tail (the time line, stamped at most once per
 * 10 minutes per workspace). The OpenCode runtime never comes through here:
 * it reads AGENTS.md itself, so it gets no duplicate.
 *
 * D5: the parts feed the shared assemblePrompt (lib/assemblePrompt.ts), so
 * the executor's layout matches the planner's and chat's.
 */
import path from "node:path";
import { appendVolatile, assemblePrompt } from "@/api/convex/lib/assemblePrompt";
import { projectInstructionsBlock } from "@/context/projectInstructions";
import { timeContextLine } from "@/context/timeContext";
import type { LLMMessage } from "@/types/llm";

export interface TurnParts {
  /** Instruction chain + the call's content (stable within a subtask attempt). */
  body: string;
  /** The volatile tail (the time line). */
  volatile: string[];
}

export function turnParts(workspacePath: string, allowedPaths: readonly string[] | undefined, parts: string[], now: number = Date.now()): TurnParts {
  const instructions = projectInstructionsBlock(workspacePath, allowedPaths);
  const timeLine = timeContextLine(path.resolve(workspacePath), now);
  return { body: [instructions, ...parts].filter(Boolean).join("\n\n"), volatile: timeLine ? [timeLine] : [] };
}

export function turnUserContent(workspacePath: string, allowedPaths: readonly string[] | undefined, parts: string[], now: number = Date.now()): string {
  const turn = turnParts(workspacePath, allowedPaths, parts, now);
  if (!turn.body) return turn.volatile.join("\n\n");
  return appendVolatile([{ role: "user", content: turn.body }], turn.volatile.join("\n\n"))[0].content;
}

/** The executor's base messages: persona as the stable prefix, then the turn, then the volatile tail. */
export function turnMessages(systemPrompt: string | undefined, workspacePath: string, allowedPaths: readonly string[] | undefined, parts: string[], now: number = Date.now()): LLMMessage[] {
  const turn = turnParts(workspacePath, allowedPaths, parts, now);
  return assemblePrompt<LLMMessage>({ stable: systemPrompt ?? "", history: [{ role: "user", content: turn.body }], volatile: turn.volatile });
}
