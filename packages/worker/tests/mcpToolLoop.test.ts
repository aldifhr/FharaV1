/**
 * Plan 009: bounded LLM tool loop over MCP tools.
 *
 * Invariants: every LLM step happens inside the loop (so the executor's
 * pre-call budget gate is what guards it); the loop is hard-bounded by
 * `maxIterations`; a hallucinated (filtered-out) tool is a denial, not a
 * crash; a non-tool/non-answer reply nudges; abort stops the loop.
 */
import { describe, expect, it } from "vitest";
import { mcpToolLoopInstruction, runMcpToolLoop } from "@/mcp/toolLoop";
import type { McpToolDefinition } from "@/mcp/types";

const TOOLS: McpToolDefinition[] = [
  { name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "list_directory", description: "List a directory", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
];

describe("mcpToolLoopInstruction", () => {
  it("states the tool count and the reply contract", () => {
    const instruction = mcpToolLoopInstruction(3);
    expect(instruction).toContain("3");
    expect(instruction).toContain('{"tool":"<tool-name>","arguments":{...}}');
    expect(instruction).toContain('{"answer":"<your final answer>"}');
  });
});

describe("runMcpToolLoop", () => {
  it("executes one tool call then returns the model's final answer", async () => {
    const replies = [
      '{"tool":"read_file","arguments":{"path":"/workspace/src/index.ts"}}',
      '{"answer":"The entry point exports x."}',
    ];
    let step = 0;
    const called: Array<{ tool: string; args: Record<string, unknown> }> = [];

    const result = await runMcpToolLoop({
      tools: TOOLS,
      messages: [{ role: "user", content: "What is in the workspace?" }],
      maxIterations: 4,
      runLlm: async () => replies[step++],
      callTool: async (call) => {
        called.push(call);
        return { ok: true, text: "export const x = 1;", isError: false };
      },
    });

    expect(called).toEqual([{ tool: "read_file", args: { path: "/workspace/src/index.ts" } }]);
    expect(result.toolCalls).toBe(1);
    expect(result.answer).toBe("The entry point exports x.");
    expect(result.toolResults).toEqual([{ tool: "read_file", text: "export const x = 1;" }]);
  });

  it("returns immediately when the model answers without any tool call", async () => {
    const result = await runMcpToolLoop({
      tools: TOOLS,
      messages: [{ role: "user", content: "Summarize." }],
      runLlm: async () => '{"answer":"Nothing to look up."}',
      callTool: async () => {
        throw new Error("must not be called");
      },
    });
    expect(result.toolCalls).toBe(0);
    expect(result.answer).toBe("Nothing to look up.");
  });

  it("treats a hallucinated (unlisted) tool as a denial, not a crash", async () => {
    const replies = ['{"tool":"write_file","arguments":{"path":"/workspace/x"}}', '{"answer":"ok"}'];
    let step = 0;
    let executed = 0;
    const result = await runMcpToolLoop({
      tools: TOOLS,
      messages: [{ role: "user", content: "Do it." }],
      runLlm: async () => replies[step++],
      callTool: async () => {
        executed += 1;
        return { ok: true, text: "never", isError: false };
      },
    });
    expect(executed).toBe(0);
    expect(result.answer).toBe("ok");
  });

  it("hard-bounds tool iterations when the model never finishes", async () => {
    let llmCalls = 0;
    const result = await runMcpToolLoop({
      tools: TOOLS,
      messages: [{ role: "user", content: "Keep reading." }],
      maxIterations: 3,
      runLlm: async () => {
        llmCalls += 1;
        return '{"tool":"read_file","arguments":{"path":"/workspace/src/index.ts"}}';
      },
      callTool: async () => ({ ok: true, text: "some file content", isError: false }),
    });
    expect(llmCalls).toBe(3);
    expect(result.toolCalls).toBe(3);
    expect(result.answer).toContain("Tool findings");
    expect(result.answer).toContain("read_file");
  });

  it("feeds tool errors back the loop instead of failing it", async () => {
    const replies = [
      '{"tool":"read_file","arguments":{"path":"/workspace/nope"}}',
      '{"answer":"The file is missing."}',
    ];
    let step = 0;
    const result = await runMcpToolLoop({
      tools: TOOLS,
      messages: [{ role: "user", content: "Read it." }],
      runLlm: async () => replies[step++],
      callTool: async () => ({
        ok: false,
        text: 'Tool call refused: mcp-path-outside-roots.',
        isError: true,
        error: "mcp-path-outside-roots",
      }),
    });
    expect(result.toolCalls).toBe(1);
    expect(result.answer).toBe("The file is missing.");
  });

  it("nudges on non-JSON prose instead of emitting it as the answer", async () => {
    const replies = ["Let me look around first.", '{"answer":"Files listed."}'];
    let step = 0;
    const result = await runMcpToolLoop({
      tools: TOOLS,
      messages: [{ role: "user", content: "Go." }],
      runLlm: async () => replies[step++],
      callTool: async () => ({ ok: true, text: "", isError: false }),
    });
    expect(result.answer).toBe("Files listed.");
    expect(result.toolCalls).toBe(0);
  });

  it("stops at once when the task signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    let llmCalls = 0;
    const result = await runMcpToolLoop({
      tools: TOOLS,
      messages: [{ role: "user", content: "Go." }],
      signal: controller.signal,
      runLlm: async () => {
        llmCalls += 1;
        return '{"answer":"never"}';
      },
      callTool: async () => ({ ok: true, text: "", isError: false }),
    });
    expect(llmCalls).toBe(0);
    expect(result.toolCalls).toBe(0);
    expect(result.answer).toBe("No tool results.");
  });
});
