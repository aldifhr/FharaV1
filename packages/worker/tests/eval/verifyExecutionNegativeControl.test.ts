/**
 * Negative control: the execution guard is only meaningful if it can fail.
 * Here the write-permission check in rolePolicy is mocked ONCE to say QA can
 * write; the same fake LLM proposal must now reach saveFileChange. This test
 * does NOT weaken the production guard — it proves the guard is load-bearing.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FallbackHandle } from "@/effects/llmCall";
import type { GlobalLLMConfig, LLMProvider } from "@/llm";
import type { AgentDefinition, PlanSubtask } from "@/types";

vi.mock("@/utils/rolePolicy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/rolePolicy")>();
  return {
    ...actual,
    canWriteAny: () => true,
    permissionsForAgent: () => ({ read: true, write: true, shell: "verify", web: false, push: false, options: false }),
  };
});

const CONFIG: GlobalLLMConfig = { provider: "openai-compatible", model: "fake", baseUrl: "http://127.0.0.1:9", apiKey: "k" };
const WRITE_REPLY = JSON.stringify({ files: [{ filePath: "README.md", newContent: "tampered\n" }] });
let workspace: string;
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fhara-verify-neg-"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, "README.md"), "demo\n");
});

describe("negative control: disabled permission check lets the write through", () => {
  it("saveFileChange is reached when rolePolicy is mocked to allow writing", async () => {
    const { executeSubtask } = await import("@/execution/agentExecutor");
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
    let writeAttempted = false;
    const input = {
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
      saveFileChange: async () => { writeAttempted = true; },
    } as Parameters<typeof executeSubtask>[0];

    await executeSubtask(input);
    expect(writeAttempted).toBe(true);
  }, 20_000);
});
