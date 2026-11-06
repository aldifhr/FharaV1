import { describe, it, expect, vi } from "vitest";
import { runLlmCall } from "../src/effects/llmCall";
import type { LLMProvider } from "../src/llm";

describe("llmCall (Effect)", () => {
  it("succeeds first try", async () => {
    const provider: LLMProvider = { complete: async () => ({ content: "hi", inputTokens: 1, outputTokens: 2 }) };
    const res = await runLlmCall(provider, [{ role: "user", content: "hi" }]);
    expect(res.content).toBe("hi");
  });

  it("retries then succeeds", async () => {
    let n = 0;
    const provider: LLMProvider = {
      complete: async () => {
        n++;
        if (n < 3) throw new Error("flaky");
        return { content: "ok" };
      },
    };
    const res = await runLlmCall(provider, [{ role: "user", content: "hi" }], undefined, { retries: 2, timeoutMs: 5000 });
    expect(res.content).toBe("ok");
    expect(n).toBe(3);
  });

  it("fails after retries exhausted", async () => {
    const provider: LLMProvider = { complete: async () => { throw new Error("always"); } };
    await expect(
      runLlmCall(provider, [{ role: "user", content: "hi" }], undefined, { retries: 1, timeoutMs: 5000 })
    ).rejects.toThrowError();
  });

  it("times out", async () => {
    const provider: LLMProvider = {
      complete: () => new Promise(() => {}), // never resolves
    };
    await expect(
      runLlmCall(provider, [{ role: "user", content: "hi" }], undefined, { retries: 0, timeoutMs: 50 })
    ).rejects.toThrowError();
    vi.restoreAllMocks();
  });
});
