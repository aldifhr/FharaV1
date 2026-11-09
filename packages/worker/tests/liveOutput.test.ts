import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveOutputCoalescer, liveDisplayText, type LiveOutputSink } from "../src/services/runner/liveOutput";
import { OpenAICompatibleProvider } from "../src/llm";

function recordingSink(delayMs = 0) {
  const calls: string[] = [];
  const sink: LiveOutputSink = {
    write: async (text) => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      calls.push(`write:${text}`);
    },
    clear: async () => {
      calls.push("clear");
    },
  };
  return { sink, calls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LiveOutputCoalescer", () => {
  it("coalesces pushes into one write per flush window", async () => {
    vi.useFakeTimers();
    const { sink, calls } = recordingSink();
    const live = new LiveOutputCoalescer(sink, { flushMs: 400 });
    live.push("Hello ");
    live.push("world");
    await vi.advanceTimersByTimeAsync(399);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(["write:Hello world"]);
    live.push("!");
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toEqual(["write:Hello world", "write:Hello world!"]);
  });

  it("flushes early once enough new text piled up", async () => {
    vi.useFakeTimers();
    const { sink, calls } = recordingSink();
    const live = new LiveOutputCoalescer(sink, { flushMs: 400, flushChars: 10 });
    live.push("abcde");
    await Promise.resolve();
    expect(calls).toEqual([]);
    live.push("fghij");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["write:abcdefghij"]);
    // The early flush cancelled the pending timer: no duplicate write.
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
  });

  it("keeps only the tail", async () => {
    const { sink, calls } = recordingSink();
    const live = new LiveOutputCoalescer(sink, { tailChars: 20, flushChars: 1_000_000 });
    for (let i = 0; i < 50; i++) live.push(`line ${i}\n`);
    expect(live.snapshot().length).toBeLessThanOrEqual(20);
    expect(live.snapshot().endsWith("line 49")).toBe(true);
    await live.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].length).toBeLessThanOrEqual("write:".length + 20);
    await live.close();
  });

  it("strips tool-call markup, including blocks cut by the tail and tags still streaming", () => {
    expect(
      liveDisplayText("Reading files\n<longcat_tool_call>read_file\n<longcat_arg_key>path</longcat_arg_key><longcat_arg_value>a.ts</longcat_arg_value></longcat_tool_call>\nDone")
    ).toBe("Reading files\n\nDone");
    // Opening tag fell outside the tail window.
    expect(liveDisplayText('path</arg_key><arg_value>a.ts</arg_value></longcat_tool_call>\nNext step')).toBe("Next step");
    // Unclosed block at the end (still streaming) and a half-written tag.
    expect(liveDisplayText("Working\n<tool_call>{\"name\":\"read")).toBe("Working");
    expect(liveDisplayText("Working\n<longcat_too")).toBe("Working");
    // Ordinary angle brackets in prose survive.
    expect(liveDisplayText("if a < b then <div> ok")).toBe("if a < b then <div> ok");
    expect(liveDisplayText("x = a < b")).toBe("x = a < b");
  });

  it("separates whole lines from streamed text", async () => {
    const { sink } = recordingSink();
    const live = new LiveOutputCoalescer(sink);
    live.push("thinking");
    live.line("› read src/a.ts");
    live.push("more");
    expect(live.snapshot()).toBe("thinking\n› read src/a.ts\nmore");
    await live.close();
  });

  it("serializes writes and clears after the last write on close", async () => {
    const { sink, calls } = recordingSink(20);
    const live = new LiveOutputCoalescer(sink, { flushChars: 1 });
    live.push("a");
    live.push("b");
    const closed = live.close();
    live.push("ignored after close");
    await closed;
    expect(calls).toEqual(["write:a", "write:ab", "clear"]);
  });

  it("does not clear when nothing was ever written, and swallows sink errors", async () => {
    const calls: string[] = [];
    const live = new LiveOutputCoalescer({
      write: async () => {
        calls.push("write");
        throw new Error("lease lost");
      },
      clear: async () => {
        calls.push("clear");
      },
    }, { flushChars: 1 });
    await new LiveOutputCoalescer({ write: async () => calls.push("x"), clear: async () => calls.push("y") }).close();
    expect(calls).toEqual([]);
    live.push("a");
    await expect(live.close()).resolves.toBeUndefined();
    expect(calls).toEqual(["write", "clear"]);
  });
});

describe("OpenAICompatibleProvider.stream", () => {
  function sse(lines: string[], split = 7): Response {
    const body = lines.map((l) => `${l}\n\n`).join("");
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split mid-line to prove the line buffer.
        for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  it("streams SSE deltas as they arrive and reads usage", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return sse([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}',
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        ": keep-alive",
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}',
        "data: [DONE]",
      ]);
    });
    const chunks: string[] = [];
    const provider = new OpenAICompatibleProvider("k", "m", "http://127.0.0.1:9/v1");
    const result = await provider.stream([{ role: "user", content: "hi" }], (d) => chunks.push(d));
    expect(bodies[0].stream).toBe(true);
    expect(bodies[0].stream_options).toBeUndefined();
    expect(chunks).toEqual(["Hel", "lo"]);
    expect(result).toEqual({ content: "Hello", inputTokens: 12, outputTokens: 3 });
  });

  it("falls back to one chunk when the server ignores stream", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "whole" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const chunks: string[] = [];
    const provider = new OpenAICompatibleProvider("k", "m", "http://127.0.0.1:9/v1");
    const result = await provider.stream([{ role: "user", content: "hi" }], (d) => chunks.push(d));
    expect(chunks).toEqual(["whole"]);
    expect(result.content).toBe("whole");
  });

  it("keeps the complete() error shape and surfaces in-stream errors", async () => {
    vi.stubGlobal("fetch", async () => new Response("rate limited", { status: 429 }));
    const provider = new OpenAICompatibleProvider("k", "m", "http://127.0.0.1:9/v1");
    await expect(provider.stream([{ role: "user", content: "hi" }], () => {})).rejects.toThrow(/LLM request failed \(429\).*rate limited/);
    vi.stubGlobal("fetch", async () => sse(['data: {"error":{"message":"overloaded"}}']));
    await expect(provider.stream([{ role: "user", content: "hi" }], () => {})).rejects.toThrow(/overloaded/);
  });

  it("a per-call timeout aborts a stalled stream", async () => {
    vi.stubGlobal("fetch", (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })
    );
    const provider = new OpenAICompatibleProvider("k", "m", "http://127.0.0.1:9/v1");
    await expect(provider.stream([{ role: "user", content: "hi" }], () => {}, undefined, { timeoutMs: 50 })).rejects.toThrow(/timed out/);
  });
});
