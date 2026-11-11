import { connect } from "node:net";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_LOOPBACK_HOST, startMcpHttpServer, type FharaMcpServer, type McpSource } from "@/mcpServer";
import { bearerMatches } from "@/mcpServer/httpServer";
import { convexMcpSource } from "@/mcpServer/convexSource";
import { MCP_TOOLS } from "@/mcpServer/registry";
import type { McpMemorySearchResult, McpTaskListResult, McpTaskStatusResult } from "@/mcpServer/types";
import type { WorkerApi } from "@/workerApi";

/** GOAT G12a: the localhost Fhara MCP server — auth, loopback bind, core listing, and a contract per read tool. */

const TOKEN = "test-token-0123456789abcdef";
const TASK = {
  id: "t1",
  projectId: "p1",
  title: "Add login",
  status: "running" as const,
  mode: "orchestrated" as const,
  createdAt: 1,
};

function fakeSource(): McpSource & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    taskStatus: async (input) => {
      calls.push(["taskStatus", input]);
      return (input.taskId === "t1" ? { task: TASK, subtasks: [{ status: "completed", count: 2 }] } : null) as McpTaskStatusResult;
    },
    taskList: async (input) => {
      calls.push(["taskList", input]);
      return { tasks: [TASK] } as unknown as McpTaskListResult;
    },
    memorySearch: async (input) => {
      calls.push(["memorySearch", input]);
      return {
        memories: [
          { id: "m1", scope: "shared", title: "Deploy", content: "preview first", truncated: false, tags: [], pinned: false, updatedAt: 2 },
        ],
      } as unknown as McpMemorySearchResult;
    },
    // G12b write tools have their own contract tests (mcpServerWrite.test.ts).
    taskCreate: async () => {
      throw new Error("unused");
    },
    threadSend: async () => {
      throw new Error("unused");
    },
    runReportResult: async () => {
      throw new Error("unused");
    },
    questionAsk: async () => {
      throw new Error("unused");
    },
  };
}

let server: FharaMcpServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(source: McpSource = fakeSource()) {
  server = await startMcpHttpServer({ port: 0, token: TOKEN, source });
  return server;
}

async function post(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  const res = await fetch(server!.url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined };
}

let nextId = 1;
const rpc = (method: string, params?: unknown) => post({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) });
const callTool = async (path: string, args?: unknown) =>
  (await rpc("tools/call", { name: "call", arguments: { path, ...(args !== undefined ? { args } : {}) } })).json.result;

describe("auth", () => {
  it("no token → 401 with a Bearer challenge, before anything else runs", async () => {
    const source = fakeSource();
    await start(source);
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "call", arguments: { path: "task.list" } } }, {});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(source.calls).toEqual([]);
  });

  it("a wrong token, a non-Bearer scheme and a wrong path without a token are all 401", async () => {
    await start();
    expect((await post({}, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await post({}, { authorization: `Basic ${TOKEN}` })).status).toBe(401);
    const res = await fetch(`http://${MCP_LOOPBACK_HOST}:${server!.port}/other`);
    expect(res.status).toBe(401);
  });

  it("bearerMatches is exact", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer   ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
  });

  it("refuses to start with a short token", async () => {
    await expect(startMcpHttpServer({ port: 0, token: "short", source: fakeSource() })).rejects.toThrow(/at least 16/);
  });

  it("a non-loopback browser Origin is refused even with the token", async () => {
    await start();
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: `Bearer ${TOKEN}`, origin: "http://localhost:3000" })).status).toBe(200);
  });
});

describe("bind", () => {
  it("listens on 127.0.0.1, never 0.0.0.0", async () => {
    const s = await start();
    expect(s.host).toBe("127.0.0.1");
    expect((s.server.address() as { address: string }).address).toBe("127.0.0.1");
    expect(s.url).toBe(`http://127.0.0.1:${s.port}/mcp`);
  });

  it("is not reachable on a non-loopback interface", async () => {
    const s = await start();
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (!external) {
      console.warn("no non-loopback IPv4 interface on this host; bind address asserted above only");
      return;
    }
    const outcome = await new Promise<string>((resolve) => {
      const sock = connect({ host: external, port: s.port });
      sock.setTimeout(2000, () => {
        sock.destroy();
        resolve("timeout");
      });
      sock.once("connect", () => {
        sock.destroy();
        resolve("connected");
      });
      sock.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
    });
    expect(outcome).not.toBe("connected");
  });
});

describe("protocol", () => {
  it("initialize names the server and the tools capability", async () => {
    await start();
    const res = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(res.json.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "fhara" }, capabilities: { tools: {} } });
  });

  it("a notification gets 202 and no body; unknown methods and batches are JSON-RPC errors", async () => {
    await start();
    const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    expect(note.json).toBeUndefined();
    expect((await rpc("resources/list")).json.error.code).toBe(-32601);
    expect((await post([{ jsonrpc: "2.0", id: 1, method: "ping" }])).json.error.code).toBe(-32600);
  });

  it("tools/list is the core listing: describe (read-only) and call (writes since G12b)", async () => {
    await start();
    const tools = (await rpc("tools/list")).json.result.tools;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["describe", "call"]);
    expect(tools[0].annotations.readOnlyHint).toBe(true);
    expect(tools[1].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(JSON.stringify(tools).length).toBeLessThan(2500);
  });

  it("describe with no path lists every registry tool with its access", async () => {
    await start();
    const res = (await rpc("tools/call", { name: "describe", arguments: {} })).json.result;
    expect(res.isError).toBe(false);
    expect(res.structuredContent.tools).toEqual([
      { path: "task.status", access: "read", summary: expect.any(String) },
      { path: "task.list", access: "read", summary: expect.any(String) },
      { path: "memory.search", access: "read", summary: expect.any(String) },
      { path: "task.create", access: "write", summary: expect.any(String) },
      { path: "thread.send", access: "write", summary: expect.any(String) },
      { path: "run.report_result", access: "write", summary: expect.any(String) },
      { path: "question.ask", access: "write", summary: expect.any(String) },
    ]);
  });

  it("describe with a path returns its JSON Schema; an unknown path or tool is an error", async () => {
    await start();
    for (const tool of MCP_TOOLS) {
      const res = (await rpc("tools/call", { name: "describe", arguments: { path: tool.path } })).json.result;
      expect(res.structuredContent).toMatchObject({ path: tool.path, access: tool.access, inputSchema: { type: "object" } });
    }
    expect((await rpc("tools/call", { name: "describe", arguments: { path: "task.nope" } })).json.result.isError).toBe(true);
    expect((await rpc("tools/call", { name: "task.list", arguments: {} })).json.error.code).toBe(-32602);
  });
});

describe("tool contracts", () => {
  it("task.status: forwards taskId, returns the row and counts; unknown id → found:false", async () => {
    const source = fakeSource();
    await start(source);
    const res = await callTool("task.status", { taskId: "t1" });
    expect(res.isError).toBe(false);
    expect(res.structuredContent).toEqual({ task: TASK, subtasks: [{ status: "completed", count: 2 }] });
    expect(JSON.parse(res.content[0].text)).toEqual(res.structuredContent);
    expect(source.calls).toEqual([["taskStatus", { taskId: "t1" }]]);
    expect((await callTool("task.status", { taskId: "zz" })).structuredContent).toEqual({ found: false, taskId: "zz" });
    expect((await callTool("task.status", {})).isError).toBe(true);
    expect((await callTool("task.status", { taskId: "t1", extra: 1 })).isError).toBe(true);
  });

  it("task.list: forwards filters, validates status and limit", async () => {
    const source = fakeSource();
    await start(source);
    const res = await callTool("task.list", { projectId: "p1", status: "running", limit: 5 });
    expect(res.structuredContent).toEqual({ tasks: [TASK] });
    expect(source.calls).toEqual([["taskList", { projectId: "p1", status: "running", limit: 5 }]]);
    expect((await callTool("task.list")).isError).toBe(false);
    expect((await callTool("task.list", { status: "exploded" })).isError).toBe(true);
    expect((await callTool("task.list", { limit: 51 })).isError).toBe(true);
  });

  it("memory.search: forwards text and project, requires text", async () => {
    const source = fakeSource();
    await start(source);
    const res = await callTool("memory.search", { text: "deploy", projectId: "p1", limit: 3 });
    expect(res.structuredContent.memories[0]).toMatchObject({ id: "m1", scope: "shared", title: "Deploy" });
    expect(source.calls).toEqual([["memorySearch", { text: "deploy", projectId: "p1", limit: 3 }]]);
    expect((await callTool("memory.search", {})).isError).toBe(true);
    expect((await callTool("memory.search", { text: "x", limit: 11 })).isError).toBe(true);
  });

  it("a backend failure is an isError result that never echoes the backend message", async () => {
    const source = fakeSource();
    source.taskList = async () => {
      throw new Error("Worker authentication required: secret-ish detail");
    };
    await start(source);
    const res = await callTool("task.list");
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("task.list failed: backend error");
  });

  it("convexMcpSource sends each read to its mcpRead query with the worker token", async () => {
    const query = vi.fn(async () => ({ tasks: [] }));
    const workerApi = { client: { query }, args: (v: object) => ({ ...v, workerToken: "svc" }) } as unknown as WorkerApi;
    const src = convexMcpSource(workerApi);
    await src.taskStatus({ taskId: "t1" });
    await src.taskList({ status: "done" });
    await src.memorySearch({ text: "x" });
    const sent = query.mock.calls.map((c) => (c as unknown[])[1]);
    expect(sent).toEqual([
      { taskId: "t1", workerToken: "svc" },
      { status: "done", workerToken: "svc" },
      { text: "x", workerToken: "svc" },
    ]);
  });
});
