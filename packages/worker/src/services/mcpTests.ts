import fs from "node:fs/promises";
import path from "node:path";
import type { WorkerApi } from "@/workerApi";
import { probeMcpServer, type McpProbeResult } from "@/mcp/probe";
import type { McpServerConfig } from "@/mcp/types";

/**
 * Integrations "Test connection", worker side. The web asks Convex
 * (mcpServers.requestTest); an idle worker claims the request with a lease,
 * spawns the server once, lists its tools and reports the outcome. A
 * project server is tested in that project's workspace; a global one in the
 * worker's workspace root.
 */

export interface McpTestDeps {
  api: Pick<WorkerApi, "claimMcpServerTest" | "completeMcpServerTest">;
  workerId: string;
  workspaceRoot: string;
  log: (...args: unknown[]) => void;
  probe?: (config: McpServerConfig, workspaceRoot: string) => Promise<McpProbeResult>;
}

/** Claim and run at most one test request. Returns whether one ran. */
export async function processNextMcpTest(deps: McpTestDeps): Promise<boolean> {
  const claim = await deps.api.claimMcpServerTest({ workerId: deps.workerId });
  if (!claim) return false;
  const workspace = claim.workspacePath
    ? path.isAbsolute(claim.workspacePath)
      ? claim.workspacePath
      : path.resolve(deps.workspaceRoot, claim.workspacePath)
    : deps.workspaceRoot;
  await fs.mkdir(workspace, { recursive: true }).catch(() => undefined);
  const config: McpServerConfig = {
    _id: String(claim.serverId),
    name: claim.name,
    type: claim.type,
    command: claim.command ?? undefined,
    args: claim.args ?? undefined,
    preset: claim.preset ?? undefined,
    allowedDirectories: claim.allowedDirectories ?? undefined,
    envCiphertext: claim.envCiphertext ?? undefined,
  };
  deps.log(`mcp test ${config._id}: ${config.name}`);
  const result = await (deps.probe ?? probeMcpServer)(config, workspace);
  await deps.api.completeMcpServerTest({
    serverId: config._id,
    workerId: deps.workerId,
    ok: result.ok,
    toolNames: result.ok ? result.toolNames : undefined,
    errorMessage: result.error,
  });
  return true;
}
