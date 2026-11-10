import { describe, expect, it } from "vitest";
import { agentAllowsWebReach, runWebReachTool, WEB_REACH_TOOL } from "@/execution/webReachTools";
import { runToolLoop } from "@/tools/toolLoop";

const config = {
  command: "agent-reach-does-not-exist",
  timeoutMs: 5_000,
  maxItems: 3,
  maxIterations: 2,
};

describe("web_reach tool scope", () => {
  it("is only offered to an agent that declares it", () => {
    expect(agentAllowsWebReach(["read_file", "web_reach"])).toBe(true);
    expect(agentAllowsWebReach(["read_file"])).toBe(false);
    expect(agentAllowsWebReach(undefined)).toBe(false);
  });

  it("describes the public channels it can reach", () => {
    expect(WEB_REACH_TOOL.name).toBe("web_reach");
    expect(WEB_REACH_TOOL.description).toContain("web");
    expect(WEB_REACH_TOOL.description).not.toContain("twitter");
  });

  it("refuses a call the model got wrong, without spawning anything", async () => {
    const outcome = await runWebReachTool({ channel: "twitter", action: "search", query: "convex" }, { config });
    expect(outcome.ok).toBe(false);
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/not allowed/);
  });

  it("reports a missing binary as a tool error, not a crash", async () => {
    const outcome = await runWebReachTool({ channel: "web", action: "search", query: "convex" }, { config });
    expect(outcome.ok).toBe(false);
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("not installed");
  });
});

describe("bounded tool loop", () => {
  it("runs a tool call and hands the result back to the model", async () => {
    const seen: string[] = [];
    const result = await runToolLoop({
      tools: [{ name: "web_reach", description: "read public web" }],
      messages: [{ role: "user", content: "research" }],
      maxIterations: 3,
      runLlm: async (messages) => {
        if (messages.length <= 2) {
          return JSON.stringify({ tool: "web_reach", arguments: { channel: "web", action: "search", query: "x" } });
        }
        return JSON.stringify({ answer: "done" });
      },
      callTool: async ({ tool, args }) => {
        seen.push(`${tool}:${String(args.query)}`);
        return { ok: true, text: "result text", isError: false };
      },
    });
    expect(seen).toEqual(["web_reach:x"]);
    expect(result.toolCalls).toBe(1);
    expect(result.answer).toBe("done");
  });

  it("refuses a tool the model hallucinated", async () => {
    let called = 0;
    const result = await runToolLoop({
      tools: [{ name: "web_reach", description: "read public web" }],
      messages: [{ role: "user", content: "research" }],
      maxIterations: 2,
      runLlm: async (messages) => {
        if (messages.length <= 2) return JSON.stringify({ tool: "write_file", arguments: { path: "a" } });
        return JSON.stringify({ answer: "done" });
      },
      callTool: async () => {
        called += 1;
        return { ok: true, text: "should not happen", isError: false };
      },
    });
    expect(called).toBe(0);
    expect(result.toolCalls).toBe(0);
  });

  it("stops at the iteration bound", async () => {
    let steps = 0;
    const result = await runToolLoop({
      tools: [{ name: "web_reach", description: "read public web" }],
      messages: [{ role: "user", content: "research" }],
      maxIterations: 2,
      runLlm: async () => {
        steps += 1;
        return JSON.stringify({ tool: "web_reach", arguments: { channel: "web", action: "search", query: "x" } });
      },
      callTool: async () => ({ ok: true, text: "result", isError: false }),
    });
    expect(steps).toBe(2);
    expect(result.toolCalls).toBe(2);
    expect(result.answer).toContain("Tool findings");
  });
});
