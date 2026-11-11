import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contextOverflowBody, loadScript, MOCK_FAULTS, startMockLlm, type MockFault, type MockRule } from "../../../scripts/mock-llm/server";

/**
 * The mock LLM's wire faults, observed on the wire (raw HTTP, no provider
 * client in between): each one reproduces, and the call log names it.
 */
const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

const REPLY = "The quick brown fox jumps over the lazy dog, then naps in the sun all afternoon.";

async function mockWith(rule: Omit<MockRule, "id">) {
  const server = await startMockLlm({ speed: 0, quiet: true, script: { rules: [{ id: "r", reply: REPLY, ...rule }], fallback: "fallback" } });
  servers.push(server);
  return server;
}

type Wire = { status?: number; contentType?: string; body: string; error?: string; ended: boolean };

/** One raw POST /v1/chat/completions; resolves with what arrived before the end, an error or `waitMs`. */
function rawPost(port: number, stream: boolean, waitMs = 1500): Promise<Wire> {
  return new Promise((resolve) => {
    const wire: Wire = { body: "", ended: false };
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(wire);
    };
    const timer = setTimeout(done, waitMs);
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } }, (res) => {
      wire.status = res.statusCode;
      wire.contentType = String(res.headers["content-type"] ?? "");
      res.setEncoding("utf8");
      res.on("data", (c: string) => (wire.body += c));
      res.on("end", () => {
        wire.ended = true;
        done();
      });
      res.on("error", (e) => {
        wire.error = e.message;
        done();
      });
      res.on("aborted", () => {
        wire.error ??= "aborted";
      });
    });
    req.on("error", (e) => {
      wire.error = (e as NodeJS.ErrnoException).code ?? e.message;
      done();
    });
    req.end(JSON.stringify({ model: "mock/default", stream, messages: [{ role: "user", content: "hi" }] }));
  });
}

const dataLines = (body: string) => body.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
const parsedFrames = (body: string) =>
  dataLines(body).flatMap((d) => {
    try {
      return [JSON.parse(d)];
    } catch {
      return [];
    }
  });
const textOf = (body: string) => parsedFrames(body).map((f) => f.choices?.[0]?.delta?.content ?? "").join("");

describe("mock LLM wire faults", () => {
  it("partial_disconnect: some deltas, half a frame, then the socket is reset", async () => {
    const server = await mockWith({ fault: "partial_disconnect", faultAfterChunks: 3 });
    const wire = await rawPost(server.port, true);
    expect(wire.status).toBe(200);
    expect(wire.ended).toBe(false);
    expect(wire.error).toBeTruthy();
    expect(wire.body).not.toContain("[DONE]");
    expect(textOf(wire.body).length).toBeGreaterThan(0);
    expect(REPLY.startsWith(textOf(wire.body))).toBe(true);
    expect(wire.body.endsWith("\n\n")).toBe(false); // cut mid-frame
    expect(server.calls.at(-1)).toMatchObject({ fault: "partial_disconnect", stream: true });
  });

  it("partial_disconnect without stream: half the JSON body, then reset", async () => {
    const server = await mockWith({ fault: "partial_disconnect" });
    const wire = await rawPost(server.port, false);
    expect(wire.ended).toBe(false);
    expect(() => JSON.parse(wire.body)).toThrow();
  });

  it("connection_reset: no status line at all", async () => {
    const server = await mockWith({ fault: "connection_reset" });
    const wire = await rawPost(server.port, true);
    expect(wire.status).toBeUndefined();
    expect(wire.error).toMatch(/ECONNRESET|socket hang up/);
  });

  it("stall: headers and some deltas, then silence until the client gives up", async () => {
    const server = await mockWith({ fault: "stall", faultAfterChunks: 2 });
    const wire = await rawPost(server.port, true, 400);
    expect(wire.status).toBe(200);
    expect(wire.ended).toBe(false);
    expect(wire.error).toBeUndefined();
    expect(parsedFrames(wire.body).length).toBe(3); // role frame + 2 deltas
    expect(wire.body).not.toContain("[DONE]");
  });

  it("stall holds its socket until the client closes it, and close() still ends it", async () => {
    const server = await mockWith({ fault: "stall" });
    const socket = net.connect(server.port, "127.0.0.1");
    socket.write(`POST /v1/chat/completions HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}`);
    await new Promise((r) => socket.once("data", r));
    const closed = new Promise((r) => socket.once("close", r));
    await servers.pop()!.close();
    await closed;
  });

  it("malformed_chunk: one frame is broken JSON and carries text a lenient client loses; the stream still finishes", async () => {
    const server = await mockWith({ fault: "malformed_chunk", faultAfterChunks: 2 });
    const wire = await rawPost(server.port, true);
    expect(wire.ended).toBe(true);
    expect(wire.body).toContain("[DONE]");
    const broken = dataLines(wire.body).filter((d) => d !== "[DONE]" && (() => { try { JSON.parse(d); return false; } catch { return true; } })());
    expect(broken).toHaveLength(1);
    const text = textOf(wire.body);
    expect(text).not.toBe(REPLY);
    expect(text.length).toBeLessThan(REPLY.length);
    expect(parsedFrames(wire.body).at(-1)?.choices?.[0]?.finish_reason).toBe("stop");
  });

  it("stream_eof: a clean end with no finish_reason and no [DONE]", async () => {
    const server = await mockWith({ fault: "stream_eof", faultAfterChunks: 3 });
    const wire = await rawPost(server.port, true);
    expect(wire.ended).toBe(true);
    expect(wire.error).toBeUndefined();
    expect(wire.body).not.toContain("[DONE]");
    expect(parsedFrames(wire.body).some((f) => f.choices?.[0]?.finish_reason)).toBe(false);
  });

  it.each(["openai", "deepseek", "anthropic"] as const)("context_overflow: 400 with the %s wording", async (overflowWording) => {
    const server = await mockWith({ fault: "context_overflow", overflowWording });
    const wire = await rawPost(server.port, true);
    expect(wire.status).toBe(400);
    expect(JSON.parse(wire.body)).toEqual(contextOverflowBody(overflowWording));
    expect(JSON.parse(wire.body).error.message).toMatch(/maximum context length|prompt is too long/);
    expect(server.calls.at(-1)).toMatchObject({ status: 400, fault: "context_overflow" });
  });

  it("server_error: a 503 burst of `times`, then the next rule answers", async () => {
    const server = await startMockLlm({
      speed: 0,
      quiet: true,
      script: { rules: [{ id: "burst", fault: "server_error", times: 3 }, { id: "ok", reply: REPLY }], fallback: "fallback" },
    });
    servers.push(server);
    const statuses: Array<number | undefined> = [];
    for (let i = 0; i < 4; i++) statuses.push((await rawPost(server.port, false)).status);
    expect(statuses).toEqual([503, 503, 503, 200]);
    expect(server.calls.map((c) => c.fault ?? "-")).toEqual(["server_error", "server_error", "server_error", "-"]);
  });

  it("a fault striking after the last piece still drops the end (faultAfterChunks past the reply)", async () => {
    const server = await mockWith({ fault: "stream_eof", faultAfterChunks: 999 });
    const wire = await rawPost(server.port, true);
    expect(textOf(wire.body)).toBe(REPLY);
    expect(wire.body).not.toContain("[DONE]");
  });

  it("an unknown fault in a script file is refused at load", () => {
    expect(() => loadScript(path.resolve(import.meta.dirname, "fixtures/mock-llm-bad-fault.json"))).toThrow(/unknown fault "explode"/);
  });

  it("the faults script has one scenario per fault, each striking once (server_error: three times)", () => {
    const script = loadScript(path.resolve(import.meta.dirname, "../../../scripts/mock-llm/scripts/faults.json"));
    const faultRules = script.rules.filter((r) => r.fault);
    expect(faultRules.map((r) => r.fault).sort()).toEqual([...MOCK_FAULTS].sort());
    for (const r of faultRules) {
      expect(r.scenario).toBe((r.fault as MockFault).replace(/_/g, "-"));
      expect(r.times).toBe(r.fault === "server_error" ? 3 : 1);
    }
    expect(script.rules.some((r) => r.id === "planner")).toBe(true); // extends default.json
  });
});
