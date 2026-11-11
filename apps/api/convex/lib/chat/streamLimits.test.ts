import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatStreamError,
  chatStreamLimits,
  idleStopMessage,
  partialReplyOf,
  readWithLimits,
  withPartial,
} from "./streamLimits";

afterEach(() => {
  vi.useRealTimers();
});

describe("chatStreamLimits (CHAT_LLM_IDLE_TIMEOUT_MS / CHAT_LLM_STREAM_MAX_MS)", () => {
  it("defaults to a 180 s idle window and a 540 s total cap (under the 10 min action limit)", () => {
    expect(chatStreamLimits({ idle: undefined, total: undefined })).toEqual({ idleMs: 180_000, totalMs: 540_000 });
    expect(chatStreamLimits({ idle: "", total: "0" })).toEqual({ idleMs: 180_000, totalMs: 540_000 });
  });

  it("clamps to the schema bounds and never lets total sit below idle", () => {
    expect(chatStreamLimits({ idle: "500", total: "999999999" })).toEqual({ idleMs: 10_000, totalMs: 570_000 });
    expect(chatStreamLimits({ idle: "300000", total: "60000" })).toEqual({ idleMs: 300_000, totalMs: 300_000 });
  });
});

describe("readWithLimits", () => {
  const limits = { idleMs: 1_000, totalMs: 10_000 };

  it("fails with an idle stop when no chunk arrives within the idle window", async () => {
    vi.useFakeTimers();
    const pending = readWithLimits(() => new Promise<never>(() => {}), limits, Date.now() + limits.totalMs);
    const assertion = expect(pending).rejects.toMatchObject({ kind: "idle", message: idleStopMessage(1_000) });
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
  });

  it("never cuts a stream that keeps sending, however long it runs below the total cap", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const deadline = start + limits.totalMs;
    // 9 chunks, 900 ms apart: 8.1 s in all, well past the idle window.
    for (let i = 0; i < 9; i += 1) {
      const read = readWithLimits(() => new Promise<number>((resolve) => setTimeout(() => resolve(i), 900)), limits, deadline);
      await vi.advanceTimersByTimeAsync(900);
      await expect(read).resolves.toBe(i);
    }
    expect(Date.now() - start).toBe(8_100);
  });

  it("fails with a total stop once the cap is reached, even while chunks flow", async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 1_500;
    const first = readWithLimits(() => new Promise<string>((resolve) => setTimeout(() => resolve("a"), 900)), limits, deadline);
    await vi.advanceTimersByTimeAsync(900);
    await expect(first).resolves.toBe("a");
    const second = readWithLimits(() => new Promise<string>((resolve) => setTimeout(() => resolve("b"), 900)), limits, deadline);
    const assertion = expect(second).rejects.toMatchObject({ kind: "total" });
    await vi.advanceTimersByTimeAsync(700);
    await assertion;
  });
});

describe("partial text on a stopped stream", () => {
  it("keeps the text so far on a cut stream and on a wrapped network error", () => {
    const cut = withPartial(new ChatStreamError("idle", idleStopMessage(180_000)), { content: "Each is always", reasoning: "r" });
    expect(partialReplyOf(cut)).toEqual({ content: "Each is always", reasoning: "r" });
    const network = withPartial(new Error("socket hang up"), { content: "half", reasoning: "" });
    expect(network).toBeInstanceOf(ChatStreamError);
    expect(network.message).toBe("Reply stopped: the connection to the model failed (socket hang up)");
    expect(partialReplyOf(network)?.content).toBe("half");
    expect(partialReplyOf(new Error("plain"))).toBeNull();
  });
});
