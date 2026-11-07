/**
 * Plan 009: end-to-end against the real reference filesystem MCP server.
 *
 * Opt-in: RUN_MCP_E2E=1. Downloads/launches
 * `@modelcontextprotocol/server-filesystem` via npx, so it costs network
 * and a real subprocess. It proves the integration is not mock-only: the
 * registry spawns the official server, discovers its tools, and MOAgent's
 * own path/permission checks refuse `.env` and out-of-root reads before the
 * server is ever called.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getMcpRegistry } from "@/mcp/registry";
import type { McpServerConfig } from "@/mcp/types";

const RUN = process.env.RUN_MCP_E2E === "1";

let workspace: string;
let outside: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-mcp-e2e-ws-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-mcp-e2e-out-"));
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "src", "index.ts"), "export const e2e = true;\n", "utf-8");
  await fs.writeFile(path.join(workspace, ".env"), "SECRET_E2E=do-not-read\n", "utf-8");
  await fs.writeFile(path.join(outside, "outside.txt"), "outside the workspace\n", "utf-8");
});

afterEach(async () => {
  await getMcpRegistry().disposeAll().catch(() => undefined);
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe.skipIf(!RUN)("MCP filesystem server (RUN_MCP_E2E=1)", () => {
  it("discovers the official tool surface and reads a file through MOAgent", async () => {
    const registry = getMcpRegistry();
    const config: McpServerConfig = {
      _id: "e2e-fs",
      name: "filesystem",
      type: "local",
      command: "npx",
      args: JSON.stringify(["-y", "@modelcontextprotocol/server-filesystem", "{workspace}"]),
      enabled: true,
      autoConnect: false,
      transport: "stdio",
    };
    const session = registry.ensure([config], workspace, {
      timeoutMs: 120_000,
      maxResultChars: 8_000,
    })[0];

    const tools = await registry.toolsFor(session, { role: "researcher" });
    expect(session.status).toBe("connected");
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("read_file");
    expect(names).toContain("list_directory");
    expect(names).toContain("list_allowed_directories");
    // Read-only for a researcher: write tools are filtered out.
    expect(names).not.toContain("write_file");

    const result = await registry.callTool(
      session,
      { role: "researcher" },
      "read_file",
      { path: path.join(workspace, "src", "index.ts") },
      "agent-e2e"
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain("export const e2e = true;");
  });

  it("refuses .env and out-of-root paths in MOAgent before the server sees them", async () => {
    const registry = getMcpRegistry();
    const config: McpServerConfig = {
      _id: "e2e-fs-2",
      name: "filesystem",
      type: "local",
      command: "npx",
      args: JSON.stringify(["-y", "@modelcontextprotocol/server-filesystem", "{workspace}"]),
      enabled: true,
      autoConnect: false,
      transport: "stdio",
    };
    const session = registry.ensure([config], workspace, {
      timeoutMs: 120_000,
      maxResultChars: 8_000,
    })[0];
    // Warm the connection so the refusal is attributed to MOAgent, not spawn.
    await registry.toolsFor(session, { role: "researcher" });

    const secret = await registry.callTool(
      session,
      { role: "developer", allowWrite: true },
      "read_file",
      { path: path.join(workspace, ".env") },
      "agent-e2e-2"
    );
    expect(secret.ok).toBe(false);
    expect(secret.error).toBe("mcp-path-forbidden");

    const escaped = await registry.callTool(
      session,
      { role: "developer", allowWrite: true },
      "read_file",
      { path: path.join(outside, "outside.txt") },
      "agent-e2e-3"
    );
    expect(escaped.ok).toBe(false);
    expect(escaped.error).toBe("mcp-path-outside-roots");
  });

  it("executes a permitted write end-to-end when mcpWriteTools is on", async () => {
    const registry = getMcpRegistry();
    const config: McpServerConfig = {
      _id: "e2e-fs-3",
      name: "filesystem",
      type: "local",
      command: "npx",
      args: JSON.stringify(["-y", "@modelcontextprotocol/server-filesystem", "{workspace}"]),
      enabled: true,
      autoConnect: false,
      transport: "stdio",
    };
    const session = registry.ensure([config], workspace, {
      timeoutMs: 120_000,
      maxResultChars: 8_000,
    })[0];
    await registry.toolsFor(session, { role: "developer", allowWrite: true });

    const target = path.join(workspace, "created-by-mcp.txt");
    const result = await registry.callTool(
      session,
      { role: "developer", allowWrite: true },
      "write_file",
      { path: target, content: "written through MCP\n" },
      "agent-e2e-4"
    );
    expect(result.ok).toBe(true);
    expect(await fs.readFile(target, "utf-8")).toBe("written through MCP\n");
  });
});
