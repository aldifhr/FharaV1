import { promises as fs, readFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnImpl } from "@/execution/nativeProvider";
import { executeSubtask, type SubtaskExecutionInput } from "@/execution/agentExecutor";
import { INSTRUCTION_BLOCK_HEADER } from "@/context/projectInstructions";
import type { AgentDefinition, ExecutionPlan, PlanSubtask } from "@/orchestrator/types";
import { createTempGitRepo } from "./helpers/tempRepo";

/**
 * D4: OpenCode reads AGENTS.md on its own, so the native prompt Fhara
 * writes for it carries no instruction-chain block (no duplicate).
 */
const LLM = { provider: "openai-compatible", model: "nous", baseUrl: "http://llm.local:20128/v1", apiKey: "sk-test-key-0000000000" };
const PLAN: ExecutionPlan = { version: 1, goal: "g", strategy: "single", requiresApproval: false, maxConcurrency: 1, subtasks: [] };
const SUBTASK: PlanSubtask = {
  key: "impl",
  title: "Implement",
  description: "Update src/a.ts",
  kind: "code_change",
  capability: "frontend-development",
  dependencies: [],
  order: 0,
  allowedPaths: ["src/**"],
};
const DONE = [
  JSON.stringify({ type: "text", sessionID: "s", part: { type: "text", text: "done" } }),
  JSON.stringify({ type: "step_finish", sessionID: "s", part: { type: "step-finish", reason: "stop", tokens: { total: 3, input: 2, output: 1, reasoning: 0 } } }),
].join("\n");

describe("OpenCode runtime gets no duplicate AGENTS.md chain (D4)", () => {
  let ws: string;
  beforeEach(() => {
    ws = createTempGitRepo({
      prefix: "fhara-d4-oc-",
      files: { "src/a.ts": "export const a = 1;\n", "AGENTS.md": "ROOT-RULE-OC\n", "src/AGENTS.md": "SRC-RULE-OC\n" },
    }).dir;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("the native prompt has no instruction block", async () => {
    let prompt = "";
    const spawnImpl: SpawnImpl = async (_cmd, args) => {
      const file = args[args.indexOf("-f") + 1];
      prompt = readFileSync(file, "utf-8");
      return { stdout: DONE, stderr: "", code: 0 };
    };
    const agent: AgentDefinition = { _id: "a1", name: "FE", role: "frontend", executionRuntime: "opencode" };
    const input: SubtaskExecutionInput = {
      workspacePath: ws,
      command: "Update src/a.ts",
      plan: PLAN,
      subtask: SUBTASK,
      agent,
      llmConfig: LLM,
      runtime: "native-provider",
      nativeProviderCommand: process.execPath,
      nativeSpawnImpl: spawnImpl,
      priorOutputs: new Map(),
      fileChanges: [],
      signal: new AbortController().signal,
      onEvent: async () => undefined,
      onMessage: async () => undefined,
      onChunk: async () => undefined,
      saveFileChange: async () => undefined,
    };
    await executeSubtask(input);
    expect(prompt).not.toBe("");
    expect(prompt).not.toContain(INSTRUCTION_BLOCK_HEADER);
    expect(prompt.split("SRC-RULE-OC").length - 1).toBeLessThanOrEqual(1);
    expect(path.isAbsolute(ws)).toBe(true);
  });
});
