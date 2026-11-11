/**
 * GOAT G12a: start the Fhara MCP server when the worker is configured for it
 * (FHARA_MCP_PORT > 0 and FHARA_MCP_TOKEN at least 16 characters). Off by
 * default; a bad config logs one line and leaves the worker running.
 */
import { wenv } from "@fhara/config/worker";
import type { WorkerApi } from "@/workerApi";
import { convexMcpSource } from "./convexSource";
import { MCP_MIN_TOKEN_LENGTH, startMcpHttpServer, type FharaMcpServer } from "./httpServer";

export { startMcpHttpServer, MCP_LOOPBACK_HOST, MCP_PATH } from "./httpServer";
export type { FharaMcpServer } from "./httpServer";
export type { McpReadSource } from "./types";

export async function startFharaMcpFromEnv(workerApi: WorkerApi): Promise<FharaMcpServer | null> {
  const port = wenv("FHARA_MCP_PORT");
  if (!port) return null;
  const token = wenv("FHARA_MCP_TOKEN");
  if (token.length < MCP_MIN_TOKEN_LENGTH) {
    console.warn(`[mcp-server] FHARA_MCP_PORT is set but FHARA_MCP_TOKEN is missing or under ${MCP_MIN_TOKEN_LENGTH} characters; server off`);
    return null;
  }
  try {
    const server = await startMcpHttpServer({ port, token, source: convexMcpSource(workerApi) });
    console.log(`[mcp-server] listening on ${server.url} (bearer token required)`);
    return server;
  } catch (error) {
    console.warn(`[mcp-server] could not start on 127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
