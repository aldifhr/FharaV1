/**
 * GOAT G12a: start the Fhara MCP server when the worker is configured for it
 * (FHARA_MCP_PORT > 0 and FHARA_MCP_TOKEN at least 16 characters). Off by
 * default; a bad config logs one line and leaves the worker running.
 * G12b: FHARA_MCP_WEBHOOK_URL + FHARA_MCP_WEBHOOK_SECRET add the signed
 * completion webhook (webhook.ts); a bad webhook config only turns it off.
 */
import { wenv } from "@fhara/config/worker";
import type { WorkerApi } from "@/workerApi";
import { convexMcpSource } from "./convexSource";
import { MCP_MIN_TOKEN_LENGTH, startMcpHttpServer, type FharaMcpServer } from "./httpServer";
import { webhookConfigFrom, withCompletionWebhook } from "./webhook";

export { startMcpHttpServer, MCP_LOOPBACK_HOST, MCP_PATH } from "./httpServer";
export type { FharaMcpServer } from "./httpServer";
export type { McpReadSource, McpSource, McpWriteSource } from "./types";
export { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from "./webhook";

export async function startFharaMcpFromEnv(workerApi: WorkerApi, ctoFirst?: { enabled: boolean; ttlMs: number }): Promise<FharaMcpServer | null> {
  const port = wenv("FHARA_MCP_PORT");
  if (!port) return null;
  const token = wenv("FHARA_MCP_TOKEN");
  if (token.length < MCP_MIN_TOKEN_LENGTH) {
    console.warn(`[mcp-server] FHARA_MCP_PORT is set but FHARA_MCP_TOKEN is missing or under ${MCP_MIN_TOKEN_LENGTH} characters; server off`);
    return null;
  }
  try {
    const webhook = webhookConfigFrom(wenv("FHARA_MCP_WEBHOOK_URL"), wenv("FHARA_MCP_WEBHOOK_SECRET"));
    if (webhook.problem) console.warn(`[mcp-server] completion webhook off: ${webhook.problem}`);
    const base = convexMcpSource(workerApi, ctoFirst?.enabled ? { ttlMs: ctoFirst.ttlMs } : undefined);
    const source = webhook.config ? withCompletionWebhook(base, webhook.config) : base;
    const server = await startMcpHttpServer({ port, token, source });
    console.log(`[mcp-server] listening on ${server.url} (bearer token required${webhook.config ? ", completion webhook on" : ""})`);
    return server;
  } catch (error) {
    console.warn(`[mcp-server] could not start on 127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
