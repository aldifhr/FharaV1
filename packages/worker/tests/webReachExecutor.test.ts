import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeSubtask, type SubtaskExecutionInput } from "@/execution/agentExecutor";
import type { FallbackHandle } from "@/effects/llmCall";
import type { AgentDefinition, ExecutionPlan, PlanSubtask } from "@/types";

/**
 * The read-only web path (plan 036): a research subtask whose agent declares
 * `web_reach` gets the Agent Reach tool, calls it through the bounded loop
 * and answers with what the tool returned.
 */

const PLAN: ExecutionPlan = {
  version: 1,
  goal: "research",
  strategy: "single",
  requiresApproval: false,
  maxConcurrency: 1,
  subtasks: [],
};

const SUBTASK: PlanSubtask = {
  key: "research",
  title: "Research",
  description: "Find public information about Convex",
  kind: "research",
  capability: "research",
  dependencies: [],
  order: 0,
  allowedPaths: [],
};

const ENVELOPE = JSON.stringify({
  schema_version: 1,
  ok: true,
  channel: "web",
  action: "search",
  items: [{ title: "Convex docs", url: "https://docs.convex.dev", text: "The reactive backend." }],
  error: null,
});

describe("executeSubtask with the web_reach tool", () => {
  let ws: string;

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-web-reach-"));
    await fs.writeFile(path.join(ws, "README.md"), "readme\n");
  });

  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  function fakeHandle(replies: string[]): { handle: FallbackHandle; calls: number } {
    const state = { calls: 0 };
    const provider = {
      complete: async () => {
        const content = replies[Math.min(state.calls, replies.length - 1)];
        state.calls += 1;
        return {
          content,
          inputTokens: 10,
          outputTokens: 5,
          model: "fake",
          provider: "fake",
        };
      },
    };
    return {
      handle: {
        connectionId: "c1",
        connectionName: "fake",
        config: { provider: "openai-compatible", model: "fake", baseUrl: "http://llm.local", apiKey: "k" },
        provider,
      } as unknown as FallbackHandle,
      get calls() {
        return state.calls;
      },
    } as { handle: FallbackHandle; calls: number };
  }

  function input(agent: AgentDefinition, extra: Partial<SubtaskExecutionInput> = {}): SubtaskExecutionInput {
    return {
      workspacePath: ws,
      command: "What does Convex do?",
      plan: PLAN,
      subtask: SUBTASK,
      agent,
      priorOutputs: new Map(),
      fileChanges: [],
      signal: new AbortController().signal,
      onEvent: async () => undefined,
      onMessage: async () => undefined,
      onChunk: async () => undefined,
      saveFileChange: async () => undefined,
      ...extra,
    };
  }

  it("runs the web tool and answers with what it returned", async () => {
    const argv: string[][] = [];
    const agent: AgentDefinition = {
      _id: "a1",
      name: "Researcher",
      role: "researcher",
      supportedTools: ["read_file", "web_reach"],
    };
    const { handle } = fakeHandle([
      JSON.stringify({ tool: "web_reach", arguments: { channel: "web", action: "search", query: "convex", limit: 3 } }),
      JSON.stringify({ answer: "Convex is a reactive backend." }),
    ]);
    const events: string[] = [];

    const result = await executeSubtask(
      input(agent, {
        llmHandles: [handle],
        webReach: {
          command: "agent-reach",
          timeoutMs: 5_000,
          maxItems: 3,
          maxIterations: 3,
          execFile: async (_file, args) => {
            argv.push(args);
            return { stdout: ENVELOPE, stderr: "" };
          },
        },
        onEvent: async (type) => void events.push(type),
      })
    );

    expect(result.status).toBe("completed");
    expect(argv).toEqual([["web", "search", "convex", "--limit", "3"]]);
    expect(result.status === "completed" ? result.output : "").toContain("Convex is a reactive backend");
    expect(events).toContain("tool.web_reach");
  });

  // Fixall: a web loop that ends without a JSON answer was marked complete
  // with a "Stopped early" / "Tool findings" dump as its result.
  const RESEARCHER: AgentDefinition = { _id: "a3", name: "Researcher", role: "researcher", supportedTools: ["read_file", "web_reach"] };
  const SEARCH = JSON.stringify({ tool: "web_reach", arguments: { channel: "web", action: "search", query: "convex", limit: 3 } });
  const webReach = (maxIterations: number) => ({
    command: "agent-reach",
    timeoutMs: 5_000,
    maxItems: 3,
    maxIterations,
    execFile: async () => ({ stdout: ENVELOPE, stderr: "" }),
  });

  it("uses the plain-text answer when the loop ends without JSON", async () => {
    const { handle } = fakeHandle([SEARCH, "Convex is a reactive backend with live queries."]);
    const result = await executeSubtask(input(RESEARCHER, { llmHandles: [handle], webReach: webReach(2) }));
    expect(result.status).toBe("completed");
    const output = result.status === "completed" ? result.output ?? "" : "";
    expect(output).toBe("Convex is a reactive backend with live queries.");
    expect(output).not.toMatch(/Stopped early|Tool findings/);
  });

  it("fails clearly when the loop ends with no answer and no plain text", async () => {
    const { handle } = fakeHandle([SEARCH]);
    const result = await executeSubtask(input(RESEARCHER, { llmHandles: [handle], webReach: webReach(2) }));
    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? result.error : "").toMatch(/^Web research ended without an answer \(.+, 2 tool call\(s\)\)$/);
  });

  it("does not offer the tool to an agent that does not declare it", async () => {
    const agent: AgentDefinition = { _id: "a2", name: "Researcher", role: "researcher", supportedTools: ["read_file"] };
    const { handle } = fakeHandle([JSON.stringify({ answer: "From the repository only." })]);
    let called = false;

    const result = await executeSubtask(
      input(agent, {
        llmHandles: [handle],
        webReach: {
          command: "agent-reach",
          timeoutMs: 5_000,
          maxItems: 3,
          maxIterations: 3,
          execFile: async () => {
            called = true;
            return { stdout: ENVELOPE, stderr: "" };
          },
        },
      })
    );

    expect(called).toBe(false);
    expect(result.status).toBe("completed");
  });
});
