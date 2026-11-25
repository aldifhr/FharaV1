/**
 * Execution guard: even if a verification-role agent is handed a code_change
 * node and a fake LLM proposes writing a file, the executor refuses before
 * any tool runs. The real git working tree stays untouched.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeSubtask, type SubtaskExecutionInput } from "@/execution/agentExecutor";
import type { FallbackHandle } from "@/effects/llmCall";
import type { GlobalLLMConfig, LLMProvider } from "@/llm";
import type { AgentDefinition, PlanSubtask } from "@/types";

const CONFIG: GlobalLLMConfig = { provider: "openai-compatible", model: "fake", baseUrl: "http://127.0.0.1:9", apiKey: "k" };
const WRITE_REPLY = JSON.stringify({ files: [{ filePath: "README.md", newContent: "tampered\n" }] });

let workspace: string;
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fhara-verify-exec-"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, "README.md"), "demo\n");
  execFileSync("git", ["add", "-A"], { cwd: workspace });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: workspace });
});
afterEach(() => fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe("verification execution cannot write", () => {
  it("executor refuses a write node for a QA agent; git status stays clean", async () => {
    const subtask: PlanSubtask = {
      key: "qa",
      title: "Verify the preview URL",
      description: "Verify that the preview URL loads. Do not change any file.",
      kind: "code_change",
      capability: "browser-testing",
      dependencies: [],
      order: 0,
    };
    const agent: AgentDefinition = {
      _id: "agent-qa",
      name: "QA",
      role: "qa",
      capabilities: ["browser-testing"],
      isEnabled: true,
      priority: 7,
    };
    const provider: LLMProvider = { complete: async () => ({ content: WRITE_REPLY, inputTokens: 1, outputTokens: 1 }) };
    const handle: FallbackHandle = { connectionId: "c", connectionName: "fake", config: CONFIG, provider };
    const input: SubtaskExecutionInput = {
      workspacePath: workspace,
      command: "Verify that the preview URL loads. Do not change any file.",
      plan: { version: 1, goal: "verify", strategy: "single", requiresApproval: false, maxConcurrency: 1, subtasks: [subtask] },
      subtask,
      agent,
      llmHandles: [handle],
      priorOutputs: new Map(),
      fileChanges: [],
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 60_000,
      onEvent: async () => undefined,
      onMessage: async () => undefined,
      onChunk: async () => undefined,
      saveFileChange: async () => { throw new Error("write attempted"); },
    } as SubtaskExecutionInput;

    const result = await executeSubtask(input);
    expect(result).toMatchObject({ status: "failed", error: expect.stringMatching(/Refused/) });
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" })).toBe("");
    expect(fs.readFileSync(path.join(workspace, "README.md"), "utf8")).toBe("demo\n");
  });
});
