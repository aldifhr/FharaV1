import { describe, it, expect, vi } from "vitest";
import { runLlmCall } from "@/effects/llmCall";
import type { LLMProvider } from "@/llm";

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

  it("does not retry permanent 4xx errors", async () => {
    let n = 0;
    const provider: LLMProvider = {
      complete: async () => {
        n++;
        throw Object.assign(new Error("bad request"), { status: 400 });
      },
    };
    await expect(
      runLlmCall(provider, [{ role: "user", content: "hi" }], undefined, { retries: 2, timeoutMs: 5000 })
    ).rejects.toThrowError("bad request");
    expect(n).toBe(1);
  });

  it("does not retry 4xx embedded in the error message", async () => {
    let n = 0;
    const provider: LLMProvider = {
      complete: async () => {
        n++;
        throw new Error("LLM request failed (404): not found");
      },
    };
    await expect(
      runLlmCall(provider, [{ role: "user", content: "hi" }], undefined, { retries: 2, timeoutMs: 5000 })
    ).rejects.toThrowError("404");
    expect(n).toBe(1);
  });

  it("retries transient 5xx errors", async () => {
    let n = 0;
    const provider: LLMProvider = {
      complete: async () => {
        n++;
        if (n < 2) throw Object.assign(new Error("unavailable"), { status: 503 });
        return { content: "ok" };
      },
    };
    const res = await runLlmCall(provider, [{ role: "user", content: "hi" }], undefined, { retries: 2, timeoutMs: 5000 });
    expect(res.content).toBe("ok");
    expect(n).toBe(2);
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
