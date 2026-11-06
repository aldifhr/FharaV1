import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentDefinition,
  ExecutionPlan,
  PlanSubtask,
} from "@/orchestrator/types";
import type { GlobalLLMConfig, LLMProvider } from "@/llm";
import type { FallbackHandle } from "@/effects/llmCall";
import {
  executeSubtask,
  type SubtaskExecutionInput,
} from "@/execution/agentExecutor";
import { buildStateFromDb } from "@/services/taskRunner";
import type { WorkerFileChange, WorkerSubtask } from "@/workerApi";

/**
 * Phase 4 cancellation at the executor level: the REAL executeSubtask
 * with an injected provider chain (llmHandles). The measurable target
 * from the spec: an abort mid-call stops the LLM call promptly, and no
 * file change is staged by a response that lost the race.
 */

const AGENT: AgentDefinition = {
  _id: "agent-implementer",
  name: "Implementer",
  role: "frontend",
  capabilities: ["frontend-development"],
  isEnabled: true,
  priority: 0,
};

const PLAN: ExecutionPlan = {
  version: 1,
  goal: "Change hello.ts",
  strategy: "single",
  requiresApproval: false,
  maxConcurrency: 1,
  subtasks: [],
};

const SUBTASK: PlanSubtask = {
  key: "implement",
  title: "Implement",
  description: "Update src/hello.ts",
  kind: "code_change",
  capability: "frontend-development",
  dependencies: [],
  order: 0,
};

const CONFIG: GlobalLLMConfig = {
  provider: "openai-compatible",
  model: "test-model",
  baseUrl: "http://127.0.0.1:9",
  apiKey: "test-key",
};

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-p4-exec-"));
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, "src", "hello.ts"),
    "export const hello = () => 'hello';\n"
  );
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function makeInput(
  provider: LLMProvider,
  signal: AbortSignal,
  saveFileChange: (change: unknown) => Promise<void>
): SubtaskExecutionInput {
  const handle: FallbackHandle = {
    connectionId: "conn-1",
    connectionName: "test",
    config: CONFIG,
    provider,
  };
  return {
    workspacePath: workspace,
    command: "Update src/hello.ts",
    plan: PLAN,
    subtask: SUBTASK,
    agent: AGENT,
    llmHandles: [handle],
    priorOutputs: new Map(),
    fileChanges: [],
    signal,
    onEvent: async () => undefined,
    onMessage: async () => undefined,
    onChunk: async () => undefined,
    saveFileChange: saveFileChange as SubtaskExecutionInput["saveFileChange"],
  };
}

describe("executeSubtask cancellation (Phase 4)", () => {
  it("aborting mid-LLM-call rejects promptly, does not retry, and stages nothing", async () => {
    let calls = 0;
    const provider: LLMProvider = {
      complete: (_messages, _model, opts) => {
        calls += 1;
        // Hangs until the caller's signal fires, like a real fetch.
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener(
            "abort",
            () => reject(new Error("LLM request aborted by caller")),
            { once: true }
          );
        });
      },
    };
    const saveFileChange = vi.fn(async () => undefined);
    const controller = new AbortController();
    const started = Date.now();
    const pending = executeSubtask(
      makeInput(provider, controller.signal, saveFileChange)
    );
    setTimeout(() => controller.abort(), 30);

    await expect(pending).rejects.toThrowError(/aborted/);
    expect(Date.now() - started).toBeLessThan(3000);
    // The abort error carries no HTTP status; without the signal check
    // in the retry predicate it would have been replayed as "transient".
    expect(calls).toBe(1);
    expect(saveFileChange).not.toHaveBeenCalled();
  });

  it("a provider that ignores the signal and resolves late stages no file changes", async () => {
    const provider: LLMProvider = {
      complete: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          content:
            '{"files":[{"filePath":"late.txt","newContent":"late\\n"}]}',
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };
    const saveFileChange = vi.fn(async () => undefined);
    const controller = new AbortController();
    const pending = executeSubtask(
      makeInput(provider, controller.signal, saveFileChange)
    );
    // Abort lands while the model is still answering; its late answer
    // loses the race and must not write anything.
    setTimeout(() => controller.abort(), 20);

    const result = await pending;
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toBe("Execution cancelled");
    }
    expect(saveFileChange).not.toHaveBeenCalled();
  });
});

describe("buildStateFromDb (Phase 4)", () => {
  it("returns completedKeys, prior outputs and staged changes from DB rows", () => {
    const subtasks = [
      { key: "a", status: "completed", output: "A output" },
      { key: "b", status: "pending" },
      { key: "c", status: "completed" },
      { key: "d", status: "failed", output: "partial" },
    ] as unknown as WorkerSubtask[];
    const fileChanges = [
      {
        filePath: "src/x.ts",
        changeType: "modified",
        newContent: "export {};\n",
        diff: "",
      },
    ] as unknown as WorkerFileChange[];

    const { state, completedKeys } = buildStateFromDb({
      subtasks,
      fileChanges,
    });

    expect(Array.from(completedKeys).sort()).toEqual(["a", "c"]);
    expect(state.priorOutputs.get("a")).toBe("A output");
    // Completed without a recorded output contributes no prior output.
    expect(state.priorOutputs.has("c")).toBe(false);
    // Failed subtasks are NOT pre-completed: they will re-execute.
    expect(completedKeys.has("d")).toBe(false);
    expect(state.fileChanges.get("src/x.ts")?.newContent).toBe("export {};\n");
    expect(state.feedback).toEqual([]);
  });
});
