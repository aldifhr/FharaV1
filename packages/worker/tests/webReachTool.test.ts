import { describe, expect, it } from "vitest";
import { agentAllowsWebReach, runWebReachTool, WEB_REACH_TOOL } from "@/execution/webReachTools";
import { loopAnswer, runToolLoop } from "@/tools/toolLoop";

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
    expect(result.ended).toBe("limit");
    expect(loopAnswer(result)).toEqual({ ok: false, error: "ended without an answer (step limit reached, 2 tool call(s))" });
  });

  it("loopAnswer: the JSON answer, else the newest plain-text reply", async () => {
    const replies = [
      "Let me think about this first.",
      JSON.stringify({ tool: "web_reach", arguments: { channel: "web", action: "search", query: "x" } }),
      "Convex is a reactive backend.",
    ];
    let step = 0;
    const base = {
      tools: [{ name: "web_reach", description: "read public web" }],
      messages: [{ role: "user" as const, content: "research" }],
      callTool: async () => ({ ok: true, text: "result", isError: false }),
    };
    const prose = await runToolLoop({ ...base, maxIterations: 3, runLlm: async () => replies[step++] });
    expect(prose.ended).toBe("limit");
    expect(prose.plainText).toBe("Convex is a reactive backend.");
    expect(loopAnswer(prose)).toEqual({ ok: true, content: "Convex is a reactive backend." });
    const answered = await runToolLoop({ ...base, maxIterations: 3, runLlm: async () => JSON.stringify({ answer: "done" }) });
    expect(answered.ended).toBe("answer");
    expect(loopAnswer(answered)).toEqual({ ok: true, content: "done" });
  });
});
