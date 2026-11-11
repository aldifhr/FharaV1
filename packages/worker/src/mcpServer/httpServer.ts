/**
 * GOAT G12a: the Fhara MCP server's HTTP transport (MCP Streamable HTTP,
 * JSON responses only, no SSE stream).
 *
 * Security, in order, on every request:
 *   1. It listens on 127.0.0.1 only. The host is a constant, not a
 *      setting: nothing on the LAN or 0.0.0.0 can reach it.
 *   2. `Authorization: Bearer <token>` must match, compared in constant
 *      time over SHA-256 digests; otherwise 401 before any body is read.
 *   3. A browser Origin that is not loopback is refused (403), against DNS
 *      rebinding from a web page.
 *   4. Bodies over 1 MiB are refused (413).
 *
 * Pattern from GOAT `apps/server/src/mcp/McpHttpServer.ts`
 * (https://github.com/goat-si/goat, commit 718f5b11), MIT License,
 * Copyright (c) 2026 T3 Tools Inc., Copyright (c) 2026 goat-si contributors.
 * No code is copied; written for Fhara on node:http, 2026-11. See
 * THIRD_PARTY_NOTICES.md (## GOAT).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { handleRpc, RPC } from "./protocol";
import type { McpReadSource } from "./types";

export const MCP_LOOPBACK_HOST = "127.0.0.1";
export const MCP_PATH = "/mcp";
export const MCP_MIN_TOKEN_LENGTH = 16;
const MAX_BODY_BYTES = 1024 * 1024;

export interface FharaMcpServer {
  server: Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Constant-time bearer check; false for a missing or malformed header. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) return false;
  return timingSafeEqual(digest(match[1].trim()), digest(token));
}

function loopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { ...(text ? { "content-type": "application/json" } : {}), ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createMcpRequestHandler(opts: { token: string; source: McpReadSource }) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (!bearerMatches(req.headers.authorization, opts.token)) {
      send(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="fhara-mcp"' });
      return;
    }
    const origin = req.headers.origin;
    if (origin && !loopbackOrigin(origin)) {
      send(res, 403, { error: "origin not allowed" });
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    if (path !== MCP_PATH) {
      send(res, 404, { error: "not found" });
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: "method not allowed" }, { allow: "POST" });
      return;
    }
    const raw = await readBody(req);
    if (raw === null) {
      send(res, 413, { error: "body too large" });
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      send(res, 400, { jsonrpc: "2.0", id: null, error: { code: RPC.PARSE, message: "Parse error" } });
      return;
    }
    const response = await handleRpc(message, opts.source);
    if (response === null) send(res, 202);
    else send(res, 200, response);
  };
}

/**
 * Start the server on 127.0.0.1:`port` (0 = an ephemeral port, for tests).
 * Refuses a token shorter than MCP_MIN_TOKEN_LENGTH.
 */
export async function startMcpHttpServer(opts: { port: number; token: string; source: McpReadSource }): Promise<FharaMcpServer> {
  if (opts.token.length < MCP_MIN_TOKEN_LENGTH) {
    throw new Error(`Fhara MCP token must be at least ${MCP_MIN_TOKEN_LENGTH} characters`);
  }
  const handler = createMcpRequestHandler(opts);
  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, MCP_LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    host: address.address,
    port: address.port,
    url: `http://${MCP_LOOPBACK_HOST}:${address.port}${MCP_PATH}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
