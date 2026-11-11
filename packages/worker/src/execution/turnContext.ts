/**
 * DeepSeek Harness D4 (pattern only, MIT, Copyright (c) 2026 DeepSeek): the
 * user turn of an API-path worker call. Stable part first (the project
 * instruction chain for this subtask's allowedPaths), then the call's own
 * content, then the volatile tail (the time line, stamped at most once per
 * 10 minutes per workspace). The OpenCode runtime never comes through here:
 * it reads AGENTS.md itself, so it gets no duplicate.
 */
import path from "node:path";
import { projectInstructionsBlock } from "@/context/projectInstructions";
import { timeContextLine } from "@/context/timeContext";

export function turnUserContent(workspacePath: string, allowedPaths: readonly string[] | undefined, parts: string[], now: number = Date.now()): string {
  const instructions = projectInstructionsBlock(workspacePath, allowedPaths);
  const timeLine = timeContextLine(path.resolve(workspacePath), now);
  return [instructions, ...parts, timeLine].filter(Boolean).join("\n\n");
}
