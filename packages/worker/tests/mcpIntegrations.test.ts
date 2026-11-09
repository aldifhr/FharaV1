/**
 * Integrations: worker side of scoped / role-limited MCP servers with
 * encrypted env, plus the "Test connection" probe.
 *
 * Uses the same fake stdio server as the Plan 009 suite.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { encryptApiKey } from "@/api/convex/lib/llmCrypto";
import { buildChildEnv } from "@/mcp/client";
import { McpRegistry, sessionAllowedForRole } from "@/mcp/registry";
import { resolveMcpSpawn, redactSecrets } from "@/mcp/spawn";
import { probeMcpServer } from "@/mcp/probe";
import { authorizeToolCall, filterToolsForAgent } from "@/mcp/permissions";
import { resetEncryptionKeyCache } from "@/llm/crypto";
import { processNextMcpTest } from "@/services/mcpTests";
import type { McpServerConfig } from "@/mcp/types";

const FIXTURE = fileURLToPath(new URL("./fixtures/fakeMcpServer.mjs", import.meta.url));
const NODE = process.execPath;
const TEST_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let previousKey: string | undefined;

beforeAll(() => {
  previousKey = process.env.PROVIDER_ENCRYPTION_KEY;
  process.env.PROVIDER_ENCRYPTION_KEY = TEST_KEY;
  resetEncryptionKeyCache();
});
afterAll(() => {
  if (previousKey === undefined) delete process.env.PROVIDER_ENCRYPTION_KEY;
  else process.env.PROVIDER_ENCRYPTION_KEY = previousKey;
  resetEncryptionKeyCache();
});

function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    _id: "srv-int",
    name: "fake",
    type: "local",
    command: NODE,
    args: JSON.stringify([FIXTURE, "{workspace}"]),
    enabled: true,
    transport: "stdio",
    ...overrides,
  };
}

let workspace: string;
const registries: McpRegistry[] = [];

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-mcp-int-"));
});
afterEach(async () => {
  for (const registry of registries) await registry.disposeAll().catch(() => undefined);
  registries.length = 0;
  await fs.rm(workspace, { recursive: true, force: true });
});

function newRegistry() {
  const registry = new McpRegistry();
  registries.push(registry);
  return registry;
}

const OPTIONS = { timeoutMs: 10_000, maxResultChars: 4_000 };

describe("spawn spec from an encrypted row", () => {
  it("decrypts env at spawn and fills {env:KEY} and {workspace} args", async () => {
    const envCiphertext = await encryptApiKey(JSON.stringify({ DATABASE_URL: "postgresql://u:pw@db/app" }));
    const spec = await resolveMcpSpawn(
      config({ args: JSON.stringify(["-y", "pkg", "{env:DATABASE_URL}", "{workspace}"]), envCiphertext }),
      "/ws"
    );
    expect(spec.args).toEqual(["-y", "pkg", "postgresql://u:pw@db/app", "/ws"]);
    expect(spec.env).toEqual({ DATABASE_URL: "postgresql://u:pw@db/app" });
    expect(redactSecrets("failed: postgresql://u:pw@db/app", spec.secretValues)).toBe("failed: ••••");
  });

  it("refuses to spawn when an arg names a missing secret", async () => {
    await expect(resolveMcpSpawn(config({ args: JSON.stringify(["{env:DATABASE_URL}"]) }), "/ws")).rejects.toThrow(
      /Missing secret DATABASE_URL/
    );
  });

  it("forwards the server's own token env but never the worker's secrets", () => {
    process.env.CONVEX_SERVICE_TOKEN = "worker-service-token";
    const env = buildChildEnv(undefined, {
      GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_server",
      CONVEX_SERVICE_TOKEN: "smuggled",
      PROVIDER_ENCRYPTION_KEY: "smuggled",
    });
    delete process.env.CONVEX_SERVICE_TOKEN;
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("ghp_server");
    expect(env.CONVEX_SERVICE_TOKEN).toBeUndefined();
    expect(env.PROVIDER_ENCRYPTION_KEY).toBeUndefined();
  });
});

describe("role allowlist", () => {
  it("matches role keys and free-form role names", () => {
    expect(sessionAllowedForRole({ config: config() }, "frontend")).toBe(true);
    expect(sessionAllowedForRole({ config: config({ agentRoles: ["qa"] }) }, "QA")).toBe(true);
    expect(sessionAllowedForRole({ config: config({ agentRoles: ["qa"] }) }, "frontend")).toBe(false);
    expect(sessionAllowedForRole({ config: config({ agentRoles: ["qa"] }) }, undefined)).toBe(false);
  });

  it("never spawns or lists a server for a role outside its allowlist", async () => {
    const registry = newRegistry();
    const [session] = registry.ensure([config({ agentRoles: ["qa"] })], workspace, OPTIONS);
    expect(await registry.toolsFor(session, { role: "frontend" })).toEqual([]);
    expect(session.status).toBe("disconnected");
    const denied = await registry.callTool(session, { role: "frontend" }, "list_allowed_directories", {}, "agent-1");
    expect(denied.error).toBe("mcp-role-denied");
    const tools = await registry.toolsFor(session, { role: "qa" });
    expect(tools.map((tool) => tool.name)).toContain("read_file");
  });
});

describe("preset tool policy", () => {
  it("a custom server exposes only allowlisted tools, without filesystem path checks", async () => {
    const registry = newRegistry();
    const [locked] = registry.ensure([config({ _id: "c1", preset: "custom" })], workspace, OPTIONS);
    expect(await registry.toolsFor(locked, { role: "qa" })).toEqual([]);

    const [open] = registry.ensure(
      [config({ _id: "c2", preset: "custom", toolAllowlist: ["list_allowed_directories"] })],
      workspace,
      OPTIONS
    );
    expect((await registry.toolsFor(open, { role: "qa" })).map((tool) => tool.name)).toEqual(["list_allowed_directories"]);
    const result = await registry.callTool(open, { role: "qa" }, "list_allowed_directories", {}, "agent-1");
    expect(result.ok).toBe(true);
  });

  it("github preset: reads for every role, writes need the write knob, repo paths are not root-checked", async () => {
    const tools = [
      { name: "get_file_contents", description: "", inputSchema: {} },
      { name: "create_issue", description: "", inputSchema: {} },
      { name: "do_magic", description: "", inputSchema: {} },
    ];
    const policy = { preset: "github" };
    expect(filterToolsForAgent(tools, { role: "qa" }, policy).map((t) => t.name)).toEqual(["get_file_contents"]);
    expect(filterToolsForAgent(tools, { role: "frontend", allowWrite: true }, policy).map((t) => t.name)).toEqual([
      "get_file_contents",
      "create_issue",
    ]);
    const relativeRepoPath = await authorizeToolCall({
      tool: "get_file_contents",
      args: { path: "src/index.ts" },
      scope: { role: "qa" },
      allowedRoots: [workspace],
      policy,
    });
    expect(relativeRepoPath.ok).toBe(true);
    // The same relative path on a filesystem server is still refused.
    const fsCall = await authorizeToolCall({
      tool: "read_file",
      args: { path: "src/index.ts" },
      scope: { role: "qa" },
      allowedRoots: [workspace],
    });
    expect(fsCall.ok).toBe(false);
  });
});

describe("test connection probe", () => {
  it("lists the tools of a working server", async () => {
    const result = await probeMcpServer(config(), workspace, { timeoutMs: 10_000 });
    expect(result.ok).toBe(true);
    expect(result.toolNames).toContain("read_file");
  });

  it("reports a dead server as a failure with secrets redacted", async () => {
    const envCiphertext = await encryptApiKey(JSON.stringify({ SECRET_VALUE: "super-secret-123" }));
    const result = await probeMcpServer(
      config({
        args: JSON.stringify(["-e", "console.error('bad ' + process.env.SECRET_VALUE); process.exit(3)"]),
        envCiphertext,
      }),
      workspace,
      { timeoutMs: 5_000 }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain("super-secret-123");
  });

  it("processNextMcpTest claims, probes and reports through the API", async () => {
    const completed: unknown[] = [];
    const api = {
      claimMcpServerTest: async () => ({
        serverId: "srv-x",
        name: "fake",
        type: "local" as const,
        command: NODE,
        args: JSON.stringify([FIXTURE, "{workspace}"]),
        preset: undefined,
        allowedDirectories: undefined,
        envCiphertext: undefined,
        workspacePath: workspace,
      }),
      completeMcpServerTest: async (input: unknown) => {
        completed.push(input);
        return true;
      },
    };
    const ran = await processNextMcpTest({ api: api as never, workerId: "w1", workspaceRoot: workspace, log: () => undefined });
    expect(ran).toBe(true);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ serverId: "srv-x", workerId: "w1", ok: true });
    expect((completed[0] as { toolNames: string[] }).toolNames).toContain("read_file");
  });

  it("returns false when nothing is queued", async () => {
    const api = { claimMcpServerTest: async () => null, completeMcpServerTest: async () => true };
    expect(await processNextMcpTest({ api: api as never, workerId: "w1", workspaceRoot: workspace, log: () => undefined })).toBe(false);
  });
});
