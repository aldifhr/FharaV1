/**
 * Integrations "Test connection": spawn one MCP server, run the protocol
 * handshake and `tools/list`, then kill it. Uses the same spawn path as
 * real runs (resolveMcpSpawn + McpClient), so a passing test means a run
 * can start the server with the same config and credentials.
 */

import { McpClient, maskMcpError } from "./client";
import { redactSecrets, resolveMcpSpawn } from "./spawn";
import type { McpServerConfig } from "./types";

export interface McpProbeResult {
  ok: boolean;
  toolNames: string[];
  error?: string;
}

export async function probeMcpServer(
  config: McpServerConfig,
  workspaceRoot: string,
  options: { timeoutMs?: number; startClient?: typeof McpClient.start } = {}
): Promise<McpProbeResult> {
  let secretValues: string[] = [];
  let stderr = "";
  let client: McpClient | null = null;
  try {
    const spec = await resolveMcpSpawn(config, workspaceRoot);
    secretValues = spec.secretValues;
    const start = options.startClient ?? McpClient.start;
    client = start({
      command: spec.command,
      args: spec.args,
      env: spec.env,
      cwd: workspaceRoot,
      // npx/uvx/docker may download on first run.
      timeoutMs: options.timeoutMs ?? 60_000,
      maxResultChars: 2_000,
      onStderr: (chunk) => {
        stderr = (stderr + chunk).slice(-2_000);
      },
    });
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "moagent-worker-test", version: "1.0.0" },
    });
    client.notify("notifications/initialized", {});
    const listed = await client.request<{ tools?: unknown }>("tools/list");
    const toolNames = Array.isArray(listed?.tools)
      ? (listed.tools as Array<Record<string, unknown>>)
          .map((tool) => (typeof tool?.name === "string" ? tool.name : ""))
          .filter(Boolean)
      : [];
    return { ok: true, toolNames };
  } catch (error) {
    const message = maskMcpError(error);
    const detail = stderr.trim() ? `${message} — ${stderr.trim().slice(-300)}` : message;
    return { ok: false, toolNames: [], error: redactSecrets(detail, secretValues).slice(0, 500) };
  } finally {
    await client?.dispose().catch(() => undefined);
  }
}
