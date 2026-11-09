/**
 * Plan 009: MCP client + registry behaviour against a real stdio process.
 *
 * The fake server in `fixtures/fakeMcpServer.mjs` speaks just enough MCP
 * (initialize / tools/list / tools/call) to prove the worker's hand-rolled
 * client: lazy connect, one shared session per workspace, per-call
 * authorization, event emission, and graceful failure when the server is
 * dead, hangs, or speaks garbage.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, buildChildEnv, flattenToolResult } from "@/mcp/client";
import { getMcpRegistry, McpRegistry } from "@/mcp/registry";
import type { McpServerConfig } from "@/mcp/types";

const FIXTURE = fileURLToPath(new URL("./fixtures/fakeMcpServer.mjs", import.meta.url));
const NODE = process.execPath;

function serverConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    _id: "srv-1",
    name: "fake-filesystem",
    type: "local",
    command: NODE,
    // `{workspace}` is filled in by the registry at spawn time.
    args: JSON.stringify([FIXTURE, "{workspace}"]),
    enabled: true,
    autoConnect: false,
    transport: "stdio",
    ...overrides,
  };
}

let workspace: string;
let outside: string;
const clients: McpClient[] = [];
const registries: McpRegistry[] = [];

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-mcp-client-ws-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-mcp-client-out-"));
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "src", "index.ts"), "export const x = 1;\n", "utf-8");
});

afterEach(async () => {
  for (const client of clients) await client.dispose().catch(() => undefined);
  clients.length = 0;
  for (const registry of registries) await registry.disposeAll().catch(() => undefined);
  registries.length = 0;
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

function newRegistry(): McpRegistry {
  const registry = new McpRegistry();
  registries.push(registry);
  return registry;
}

describe("buildChildEnv", () => {
  it("never forwards worker secrets to an MCP child process", () => {
    const previousToken = process.env.CONVEX_SERVICE_TOKEN;
    const previousKey = process.env.PROVIDER_ENCRYPTION_KEY;
    process.env.CONVEX_SERVICE_TOKEN = "service-token-value";
    process.env.PROVIDER_ENCRYPTION_KEY = "encryption-key-value";
    try {
      const env = buildChildEnv({ SOME_PROXY: "http://proxy", OTHER_TOKEN: "nope" });
      expect(env.CONVEX_SERVICE_TOKEN).toBeUndefined();
      expect(env.PROVIDER_ENCRYPTION_KEY).toBeUndefined();
      expect(env.OTHER_TOKEN).toBeUndefined();
      expect(env.SOME_PROXY).toBe("http://proxy");
      expect(env.PATH).toBeDefined();
    } finally {
      if (previousToken === undefined) delete process.env.CONVEX_SERVICE_TOKEN;
      else process.env.CONVEX_SERVICE_TOKEN = previousToken;
      if (previousKey === undefined) delete process.env.PROVIDER_ENCRYPTION_KEY;
      else process.env.PROVIDER_ENCRYPTION_KEY = previousKey;
    }
  });
});

describe("McpClient", () => {
  it("performs initialize, tools/list and tools/call over stdio", async () => {
    const client = McpClient.start({
      command: NODE,
      args: [FIXTURE, workspace],
      cwd: workspace,
      timeoutMs: 5_000,
      maxResultChars: 4_000,
    });
    clients.push(client);

    const init = (await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    })) as { serverInfo?: { name?: string } };
    expect(init.serverInfo?.name).toBe("fake-filesystem");

    client.notify("notifications/initialized", {});

    const listed = (await client.request("tools/list")) as { tools?: Array<{ name: string }> };
    const names = (listed.tools ?? []).map((tool) => tool.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");

    const result = (await client.request("tools/call", {
      name: "read_file",
      arguments: { path: path.join(workspace, "src", "index.ts") },
    })) as unknown;
    const { text } = flattenToolResult(result, 4_000);
    expect(text).toContain("export const x = 1;");
  });

  it("passes configured args verbatim to the child (no token magic in the client)", async () => {
    const client = McpClient.start({
      command: NODE,
      args: [FIXTURE, workspace],
      cwd: workspace,
      timeoutMs: 5_000,
      maxResultChars: 4_000,
    });
    clients.push(client);
    await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
    client.notify("notifications/initialized", {});
    const result = (await client.request("tools/call", {
      name: "list_allowed_directories",
      arguments: {},
    })) as unknown;
    const { text } = flattenToolResult(result, 4_000);
    expect(text).toContain(workspace);
  });

  it("ignores non-JSON stdout junk instead of crashing", async () => {
    const client = McpClient.start({
      command: NODE,
      args: [FIXTURE, workspace, "--garbage"],
      cwd: workspace,
      timeoutMs: 5_000,
      maxResultChars: 4_000,
    });
    clients.push(client);
    const init = await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
    expect(init).toBeTruthy();
  });

  it("times out and kills a wedged server", async () => {
    const client = McpClient.start({
      command: NODE,
      args: [FIXTURE, workspace, "--hang"],
      cwd: workspace,
      timeoutMs: 300,
      maxResultChars: 4_000,
    });
    clients.push(client);
    await expect(client.request("initialize", {})).rejects.toThrow(/timed out|exited/);
  });

  it("surfaces a crashed server as a rejected request", async () => {
    const client = McpClient.start({
      command: NODE,
      args: [FIXTURE, workspace, "--crash"],
      cwd: workspace,
      timeoutMs: 5_000,
      maxResultChars: 4_000,
    });
    clients.push(client);
    await expect(client.request("initialize", {})).rejects.toThrow(/exited|closed|EPIPE/);
  });
});

describe("McpRegistry", () => {
  it("connects lazily: ensure() spawns nothing until tools are requested", async () => {
    const registry = newRegistry();
    const sessions = registry.ensure([serverConfig()], workspace, {
      timeoutMs: 5_000,
      maxResultChars: 4_000,
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("disconnected");
    expect(sessions[0].client).toBeNull();

    const tools = await registry.toolsFor(sessions[0], { role: "researcher" });
    expect(sessions[0].status).toBe("connected");
    expect(tools.map((tool) => tool.name)).toContain("read_file");
  });

  it("shares one session per workspace across agents and repeated ensure()", async () => {
    const registry = newRegistry();
    const options = { timeoutMs: 5_000, maxResultChars: 4_000 };
    const first = registry.ensure([serverConfig()], workspace, options)[0];
    const second = registry.ensure([serverConfig()], workspace, options)[0];
    expect(second).toBe(first);

    const before = first.client;
    await registry.toolsFor(first, { role: "researcher" });
    const clientAfterFirst = first.client;
    await registry.toolsFor(first, { role: "researcher" });
    expect(first.client).toBe(clientAfterFirst);
    expect(before).toBeNull();
  });

  it("separates sessions by workspace", () => {
    const registry = newRegistry();
    const sessions = registry.ensure([serverConfig()], workspace, { timeoutMs: 5_000, maxResultChars: 4_000 });
    const other = registry.ensure([serverConfig()], outside, { timeoutMs: 5_000, maxResultChars: 4_000 });
    expect(other[0]).not.toBe(sessions[0]);
  });

  it("fills the {workspace} token in args at spawn time", async () => {
    const registry = newRegistry();
    const session = registry.ensure([serverConfig()], workspace, {
      timeoutMs: 5_000,
      maxResultChars: 4_000,
    })[0];
    // The fake server reports its confinement root, which is argv[1]. It can
    // only equal the workspace if the registry substituted the token.
    const result = await registry.callTool(session, { role: "researcher" }, "list_allowed_directories", {}, "agent-3");
    expect(result.ok).toBe(true);
    expect(result.text).toContain(workspace);
  });

  it("does not launch remote configs (stored only)", () => {
    const registry = newRegistry();
    const sessions = registry.ensure(
      [serverConfig({ _id: "remote-1", type: "remote", url: "https://example.test/mcp", command: undefined })],
      workspace,
      { timeoutMs: 5_000, maxResultChars: 4_000 }
    );
    expect(sessions).toHaveLength(0);
  });

  it("filters tools per role on every toolsFor call", async () => {
    const registry = newRegistry();
    const session = registry.ensure([serverConfig()], workspace, {
      timeoutMs: 5_000,
      maxResultChars: 4_000,
    })[0];
    const researcherTools = await registry.toolsFor(session, { role: "researcher" });
    expect(researcherTools.map((t) => t.name)).not.toContain("write_file");
    const developerTools = await registry.toolsFor(session, { role: "developer", allowWrite: true });
    expect(developerTools.map((t) => t.name)).toContain("write_file");
  });

  it("executes a permitted call and emits a masked event with caller context", async () => {
    const registry = newRegistry();
    const session = registry.ensure([serverConfig()], workspace, {
      timeoutMs: 5_000,
      maxResultChars: 4_000,
    })[0];
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const result = await registry.callTool(
      session,
      { role: "researcher" },
      "read_file",
      { path: path.join(workspace, "src", "index.ts") },
      "agent-7",
      undefined,
      { onEvent: async (type, payload) => void events.push({ type, payload: { ...payload } }) }
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain("export const x = 1;");
    const event = events.find((entry) => entry.type === "mcp.tool_call");
    expect(event?.payload.agentId).toBe("agent-7");
    expect(event?.payload.serverId).toBe("srv-1");
    expect(event?.payload.workspace).toBe(workspace);
  });

  it("refuses a call-time write for a read-only role and emits mcp.tool_denied", async () => {
    const registry = newRegistry();
    const session = registry.ensure([serverConfig()], workspace, {
      timeoutMs: 5_000,
      maxResultChars: 4_000,
    })[0];
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const result = await registry.callTool(
      session,
      { role: "researcher" },
      "write_file",
      { path: path.join(workspace, "src", "new.ts"), content: "nope" },
      "agent-9",
      undefined,
      { onEvent: async (type, payload) => void events.push({ type, payload: { ...payload } }) }
    );
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("refused");
    expect(events.some((entry) => entry.type === "mcp.tool_denied")).toBe(true);
    // The write must never have reached the filesystem.
    await expect(fs.access(path.join(workspace, "src", "new.ts"))).rejects.toThrow();
  });

  it("refuses a path outside the allowed roots at call time", async () => {
    const registry = newRegistry();
    const session = registry.ensure([serverConfig()], workspace, {
      timeoutMs: 5_000,
      maxResultChars: 4_000,
    })[0];
    const result = await registry.callTool(
      session,
      { role: "researcher" },
      "read_file",
      { path: path.join(outside, "secret.txt") },
      "agent-1"
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("mcp-path-outside-roots");
  });

  it("reports a dead server as an error status and never throws", async () => {
    const registry = newRegistry();
    const statuses: string[] = [];
    const session = registry.ensure(
      [
        serverConfig({
          _id: "dead-1",
          command: NODE,
          args: JSON.stringify(["-e", "process.exit(3)"]),
        }),
      ],
      workspace,
      { timeoutMs: 2_000, maxResultChars: 4_000 }
    )[0];

    const tools = await registry.toolsFor(session, { role: "researcher" }, {
      onStatus: async (_serverId, status) => void statuses.push(status),
    });
    expect(tools).toHaveLength(0);
    expect(session.status).toBe("error");
    expect(statuses).toContain("error");

    const result = await registry.callTool(session, { role: "researcher" }, "read_file", { path: workspace }, "agent-2");
    expect(result.ok).toBe(false);
  });

  it("disposeAll closes every child process", async () => {
    const registry = newRegistry();
    const session = registry.ensure([serverConfig()], workspace, {
      timeoutMs: 5_000,
      maxResultChars: 4_000,
    })[0];
    await registry.toolsFor(session, { role: "researcher" });
    const client = session.client!;
    expect(client.isClosed).toBe(false);
    await registry.disposeAll();
    expect(client.isClosed).toBe(true);
  });

  it("exposes a process-wide singleton for the runner and shutdown hook", () => {
    expect(getMcpRegistry()).toBe(getMcpRegistry());
  });
});
