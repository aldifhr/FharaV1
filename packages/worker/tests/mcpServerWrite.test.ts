import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startMcpHttpServer, type FharaMcpServer, type McpSource } from "@/mcpServer";
import { convexMcpSource } from "@/mcpServer/convexSource";
import {
  deliverWebhook,
  signWebhookBody,
  verifyWebhookSignature,
  webhookConfigFrom,
  withCompletionWebhook,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type McpCompletionEvent,
} from "@/mcpServer/webhook";
import type { McpRunReportResult, McpTaskCreateResult } from "@/mcpServer/types";
import type { WorkerApi } from "@/workerApi";

/** GOAT G12b: the Fhara MCP write tools (contracts, dedupe passthrough, refusals) and the signed completion webhook. */

const TOKEN = "test-token-0123456789abcdef";
const SECRET = "webhook-secret-0123456789";

/** An in-memory write source that dedupes by clientRequestId like apps/api/convex/mcpWrite.ts. */
function fakeWriteSource(projectMode: "supervised" | "full_access" = "supervised") {
  const seen = new Map<string, Record<string, unknown>>();
  const calls: Array<[string, unknown]> = [];
  const once = async <T,>(name: string, input: { clientRequestId: string }, make: () => T): Promise<T> => {
    calls.push([name, input]);
    const prior = seen.get(input.clientRequestId);
    if (prior) return { ...prior, deduped: true } as T;
    const result = make() as Record<string, unknown>;
    if (result.kind !== "refused") seen.set(input.clientRequestId, result);
    return { ...result, ...(result.kind !== "refused" ? { deduped: false } : {}) } as T;
  };
  let n = 0;
  const source: McpSource = {
    taskStatus: async () => null,
    taskList: async () => ({ tasks: [] }),
    memorySearch: async () => ({ memories: [] }),
    taskCreate: (input) =>
      once("taskCreate", input, () =>
        (input.approved && projectMode === "full_access" && !input.conversationId
          ? { kind: "task", taskId: `t${++n}`, projectId: input.projectId, permissionMode: "full_access" }
          : { kind: "draft", draftId: `d${++n}`, projectId: input.projectId, reason: "Not approved" }) as McpTaskCreateResult
      ),
    threadSend: (input) => once("threadSend", input, () => ({ kind: "sent" as const, messageId: `m${++n}`, taskId: input.taskId, deduped: false })),
    runReportResult: (input) =>
      once("runReportResult", input, () =>
        (input.taskId === "done"
          ? { kind: "refused", reason: "task_already_terminal" }
          : {
              kind: "recorded",
              taskId: input.taskId,
              projectId: "p1",
              status: input.status,
              summary: input.summary,
              reportedAt: 1000,
            }) as McpRunReportResult
      ),
    questionAsk: (input) => once("questionAsk", input, () => ({ kind: "asked" as const, taskId: input.taskId, question: input.question, deduped: false })),
  };
  return { source, calls };
}

let server: FharaMcpServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function callTool(path: string, args: unknown) {
  const res = await fetch(server!.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "call", arguments: { path, args } } }),
  });
  return (await res.json()).result;
}

describe("write tools over MCP", () => {
  it("a duplicate clientRequestId returns the same result, marked deduped", async () => {
    const { source } = fakeWriteSource();
    server = await startMcpHttpServer({ port: 0, token: TOKEN, source });
    const first = await callTool("task.create", { clientRequestId: "abc", projectId: "p1", command: "add login" });
    const again = await callTool("task.create", { clientRequestId: "abc", projectId: "p1", command: "add login" });
    expect(first.isError).toBe(false);
    expect(first.structuredContent).toMatchObject({ kind: "draft", draftId: "d1", deduped: false });
    expect(again.structuredContent).toEqual({ ...first.structuredContent, deduped: true });
  });

  it("every write requires a clientRequestId and validates its args", async () => {
    const { source, calls } = fakeWriteSource();
    server = await startMcpHttpServer({ port: 0, token: TOKEN, source });
    expect((await callTool("task.create", { projectId: "p1", command: "x" })).isError).toBe(true);
    expect((await callTool("thread.send", { clientRequestId: " ", taskId: "t1", content: "x" })).isError).toBe(true);
    expect((await callTool("run.report_result", { clientRequestId: "r", taskId: "t1", status: "maybe", summary: "x" })).isError).toBe(true);
    expect((await callTool("run.report_result", { clientRequestId: "r", taskId: "t1", status: "failed", summary: "x", links: ["nope"] })).isError).toBe(true);
    expect((await callTool("question.ask", { clientRequestId: "q", taskId: "t1", question: "?", options: ["only one"] })).isError).toBe(true);
    expect((await callTool("task.create", { clientRequestId: "c", projectId: "p1", command: "x", permissionMode: "root" })).isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("forwards each write to its source method; a backend refusal is a readable tool error", async () => {
    const { source, calls } = fakeWriteSource();
    server = await startMcpHttpServer({ port: 0, token: TOKEN, source });
    expect((await callTool("thread.send", { clientRequestId: "s1", taskId: "t1", content: "hi" })).structuredContent).toMatchObject({ kind: "sent" });
    expect((await callTool("question.ask", { clientRequestId: "q1", taskId: "t1", question: "A or B?", options: ["A", "B"] })).isError).toBe(false);
    const refused = await callTool("run.report_result", { clientRequestId: "r1", taskId: "done", status: "succeeded", summary: "ok" });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ kind: "refused", reason: "task_already_terminal" });
    expect(calls.map(([name]) => name)).toEqual(["threadSend", "questionAsk", "runReportResult"]);
  });

  it("convexMcpSource sends each write to its mcpWrite mutation with the worker token", async () => {
    const mutation = vi.fn(async () => ({ kind: "sent" }));
    const workerApi = { client: { mutation }, args: (v: object) => ({ ...v, workerToken: "svc" }) } as unknown as WorkerApi;
    const src = convexMcpSource(workerApi);
    await src.taskCreate({ clientRequestId: "a", projectId: "p1", command: "c" });
    await src.threadSend({ clientRequestId: "b", taskId: "t1", content: "x" });
    await src.runReportResult({ clientRequestId: "c", taskId: "t1", status: "succeeded", summary: "s" });
    await src.questionAsk({ clientRequestId: "d", taskId: "t1", question: "?" });
    expect(mutation.mock.calls.map((c) => ((c as unknown[])[1] as { workerToken: string }).workerToken)).toEqual(["svc", "svc", "svc", "svc"]);
    expect(mutation.mock.calls.map((c) => ((c as unknown[])[1] as { clientRequestId: string }).clientRequestId)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("completion webhook", () => {
  const event: McpCompletionEvent = {
    event: "run.completed",
    taskId: "t1",
    projectId: "p1",
    status: "succeeded",
    summary: "green",
    reportedAt: 1000,
    clientRequestId: "r1",
  };

  it("the signature verifies for the exact body and timestamp only", () => {
    const body = JSON.stringify(event);
    const now = 1_700_000_000_000;
    const timestamp = String(now);
    const signature = signWebhookBody(SECRET, timestamp, body);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature({ secret: SECRET, body, timestamp, signature, now })).toBe(true);
    expect(verifyWebhookSignature({ secret: SECRET, body: body.replace("green", "red"), timestamp, signature, now })).toBe(false);
    expect(verifyWebhookSignature({ secret: "another-secret-0123456", body, timestamp, signature, now })).toBe(false);
    expect(verifyWebhookSignature({ secret: SECRET, body, timestamp: String(now + 1), signature, now })).toBe(false);
    expect(verifyWebhookSignature({ secret: SECRET, body, timestamp, signature, now: now + 10 * 60_000 })).toBe(false);
    expect(verifyWebhookSignature({ secret: SECRET, body, timestamp, signature: null, now })).toBe(false);
    expect(verifyWebhookSignature({ secret: SECRET, body, timestamp: "abc", signature, now })).toBe(false);
  });

  it("a real receiver gets a POST whose signature verifies", async () => {
    const received = await new Promise<{ headers: IncomingMessage["headers"]; body: string; ok: boolean }>((resolve, reject) => {
      const receiver = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.writeHead(204).end();
          receiver.close();
          resolve({ headers: req.headers, body, ok: true });
        });
      });
      receiver.listen(0, "127.0.0.1", () => {
        const { port } = receiver.address() as AddressInfo;
        deliverWebhook({ url: `http://127.0.0.1:${port}/hook`, secret: SECRET }, event).then((ok) => {
          if (!ok) reject(new Error("delivery failed"));
        }, reject);
      });
    });
    expect(JSON.parse(received.body)).toEqual(event);
    const timestamp = received.headers[WEBHOOK_TIMESTAMP_HEADER] as string;
    const signature = received.headers[WEBHOOK_SIGNATURE_HEADER] as string;
    expect(verifyWebhookSignature({ secret: SECRET, body: received.body, timestamp, signature })).toBe(true);
    expect(verifyWebhookSignature({ secret: "wrong-secret-0123456789", body: received.body, timestamp, signature })).toBe(false);
  });

  it("fires once per newly recorded result: not on a deduped repeat, not on a refusal", async () => {
    const { source } = fakeWriteSource();
    const deliver = vi.fn(async () => true);
    const wrapped = withCompletionWebhook(source, { url: "http://127.0.0.1:1/x", secret: SECRET }, deliver);
    const input = { clientRequestId: "r1", taskId: "t1", status: "succeeded" as const, summary: "green" };
    await wrapped.runReportResult(input);
    await wrapped.runReportResult(input);
    await wrapped.runReportResult({ ...input, clientRequestId: "r2", taskId: "done" });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(event);
  });

  it("a failed delivery never throws into the tool call", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await deliverWebhook({ url: "http://127.0.0.1:1/x?token=hidden", secret: SECRET }, event, failing)).toBe(false);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/hidden|webhook-secret/);
    warn.mockRestore();
  });

  it("config: off when blank; off with a reason for a bad URL, a non-http scheme or a short secret", () => {
    expect(webhookConfigFrom("", "")).toEqual({ config: null });
    expect(webhookConfigFrom("not a url", SECRET).problem).toMatch(/valid URL/);
    expect(webhookConfigFrom("file:///etc/passwd", SECRET).problem).toMatch(/http/);
    expect(webhookConfigFrom("https://hooks.example/x", "short").problem).toMatch(/16/);
    expect(webhookConfigFrom("", SECRET).problem).toMatch(/URL is blank/);
    expect(webhookConfigFrom("https://hooks.example/x", SECRET).config).toEqual({ url: "https://hooks.example/x", secret: SECRET });
  });
});
