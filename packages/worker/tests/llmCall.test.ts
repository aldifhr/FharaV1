import { describe, it, expect, vi } from "vitest";
import { LlmConcurrencyGate, runLlmCall } from "@/effects/llmCall";
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

describe("llmCall concurrency gate (Phase 4)", () => {
  const delay = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it("never runs more calls at once than policy.maxConcurrentLLMCalls allows", async () => {
    const gate = new LlmConcurrencyGate(2);
    let active = 0;
    let peak = 0;
    const provider: LLMProvider = {
      complete: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await delay(30);
        active -= 1;
        return { content: "ok" };
      },
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        runLlmCall(provider, [{ role: "user", content: "hi" }], undefined, {
          gate,
          retries: 0,
          timeoutMs: 5000,
        })
      )
    );
    expect(results).toHaveLength(6);
    expect(peak).toBe(2);
    expect(gate.getActiveCount()).toBe(0);
    expect(gate.getQueuedCount()).toBe(0);
  });

  it("a queued call whose signal aborts leaves the queue and never reaches the provider", async () => {
    const gate = new LlmConcurrencyGate(1);
    let calls = 0;
    const provider: LLMProvider = {
      complete: async () => {
        calls += 1;
        await delay(60);
        return { content: "ok" };
      },
    };
    const first = runLlmCall(provider, [{ role: "user", content: "hi" }], undefined, {
      gate,
      retries: 0,
      timeoutMs: 5000,
    });
    const controller = new AbortController();
    const second = runLlmCall(provider, [{ role: "user", content: "hi" }], undefined, {
      gate,
      retries: 0,
      timeoutMs: 5000,
      signal: controller.signal,
    });
    // The second call is queued behind the first; aborting it must drop
    // it from the queue instead of letting it fire later.
    controller.abort();
    await expect(second).rejects.toThrowError(/aborted/);
    await first;
    expect(calls).toBe(1);
    expect(gate.getQueuedCount()).toBe(0);
  });

  it("an aborted in-flight call rejects promptly and is never retried", async () => {
    const gate = new LlmConcurrencyGate(1);
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
    const controller = new AbortController();
    const pending = runLlmCall(provider, [{ role: "user", content: "hi" }], undefined, {
      gate,
      retries: 3,
      timeoutMs: 5000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrowError(/aborted/);
    expect(calls).toBe(1);
  });
});
