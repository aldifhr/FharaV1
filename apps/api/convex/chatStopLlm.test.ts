// @vitest-environment node
/**
 * Chat Stop against the mock LLM (scripts/mock-llm) over loopback: the
 * user's Stop aborts the real streamed fetch, and never fails over to the
 * next model in the chain.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startMockLlm } from "../../../scripts/mock-llm/server";
import { completeWithAgent, resetChatRouting } from "./lib/chat/llm";
import { ChatStoppedError, replyStopRequested, watchReplyStop } from "./lib/chat/replyStop";

const REPLY = "A slow answer that keeps streaming for a while so Stop lands mid-reply. ".repeat(4);
const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  resetChatRouting();
});

async function mock(speed: number) {
  const server = await startMockLlm({ speed, quiet: true, token: "t", script: { rules: [], fallback: REPLY } });
  servers.push(server);
  return { provider: "openai-compatible", model: "mock/default", baseUrl: server.url, apiKey: "t" };
}
const ask = [{ role: "user", content: "Explain" }];

describe("Stop aborts the chat LLM call", () => {
  it("aborts a reply mid-stream at once, with no fallback attempt", async () => {
    const config = await mock(0.1); // ~333 ms between deltas: seconds in all
    // A fallback that would answer: reaching it would resolve, not reject.
    const fallback = await mock(50);
    const stop = new AbortController();
    const chunks: string[] = [];
    const startedAt = Date.now();
    setTimeout(() => stop.abort(), 500);
    const error = await completeWithAgent("s", ask, { ...config, fallbacks: [fallback] }, (c) => chunks.push(c.content), {
      signal: stop.signal,
      limits: { idleMs: 10_000, totalMs: 60_000 },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ChatStoppedError);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(chunks.length).toBeGreaterThan(0); // it was streaming when stopped
  });

  it("a stop that already fired never calls the model", async () => {
    const config = await mock(50);
    const stop = new AbortController();
    stop.abort();
    await expect(completeWithAgent("s", ask, config, undefined, { signal: stop.signal })).rejects.toBeInstanceOf(ChatStoppedError);
  });

  it("without a stop the same call finishes", async () => {
    const config = await mock(50);
    const result = await completeWithAgent("s", ask, config, undefined, { signal: new AbortController().signal });
    expect(result.content).toBe(REPLY);
  });
});

describe("reply stop flag", () => {
  it("polls only while a call is in flight, aborts the signal once stopped; dispose waits for the last poll", async () => {
    let polls = 0;
    const watch = watchReplyStop(async () => ++polls >= 3, 20);
    // No call in flight: no polling.
    await new Promise((r) => setTimeout(r, 60));
    expect(polls).toBe(0);
    await expect(watch.during(async () => "quick")).resolves.toBe("quick");
    const hung = watch.during(
      () => new Promise((_, reject) => watch.signal.addEventListener("abort", () => reject(watch.signal.reason), { once: true }))
    );
    await expect(hung).rejects.toBeInstanceOf(ChatStoppedError);
    expect(watch.signal.aborted).toBe(true);
    await watch.dispose();
    const after = polls;
    await new Promise((r) => setTimeout(r, 60));
    expect(polls).toBe(after);
  });

  it("a failing poll is not a stop", async () => {
    const watch = watchReplyStop(async () => {
      throw new Error("offline");
    }, 10);
    expect(await watch.check()).toBe(false);
    expect(watch.signal.aborted).toBe(false);
    await watch.dispose();
  });

  it("stop requested: stopped, another run took over, or the message is gone", () => {
    expect(replyStopRequested({ replyStatus: "replying", replyRunId: "r1" }, "r1")).toBe(false);
    expect(replyStopRequested({ replyStatus: "stopped", replyRunId: "r1" }, "r1")).toBe(true);
    expect(replyStopRequested({ replyStatus: "replying", replyRunId: "r2" }, "r1")).toBe(true);
    expect(replyStopRequested(null, "r1")).toBe(true);
  });
});
