/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

/**
 * Plan 009: MCP server config persistence.
 *
 * Invariants: add stores the worker-facing config fields (enabled /
 * autoConnect / transport / allowedDirectories) with a disconnected
 * status; updateStatus patches it; list is project-scoped; and
 * getRunContext crosses only enabled configs (never a disabled row,
 * never anything credential-shaped — there is no key material in this
 * table).
 */

const modules = import.meta.glob("./**/*.ts");

async function seedProject(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" })
  );
}

describe("mcpServers config persistence (Plan 009)", () => {
  test("add stores the worker-facing fields and list returns them", async () => {
    const t = convexTest(schema, modules);
    const projectId = await seedProject(t);

    const serverId = await t.mutation(internal.mcpServers.add, {
      projectId,
      name: "filesystem",
      type: "local",
      command: "npx",
      args: '["-y", "@modelcontextprotocol/server-filesystem", "{workspace}"]',
      enabled: true,
      autoConnect: false,
      transport: "stdio",
      allowedDirectories: ["/tmp/shared"],
    });
    expect(serverId).toBeTruthy();

    const rows = await t.query(api.mcpServers.list, { projectId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "filesystem",
      type: "local",
      command: "npx",
      enabled: true,
      autoConnect: false,
      transport: "stdio",
      allowedDirectories: ["/tmp/shared"],
      status: "disconnected",
    });
  });

  test("list is scoped to the project", async () => {
    const t = convexTest(schema, modules);
    const projectId = await seedProject(t);
    const otherId = await seedProject(t);

    await t.mutation(internal.mcpServers.add, {
      projectId,
      name: "mine",
      type: "remote",
      url: "https://mcp.example.test/mcp",
    });
    await t.mutation(internal.mcpServers.add, {
      projectId: otherId,
      name: "theirs",
      type: "remote",
      url: "https://other.example.test/mcp",
    });

    const rows = await t.query(api.mcpServers.list, { projectId });
    expect(rows.map((row) => row.name)).toEqual(["mine"]);
  });

  test("updateStatus patches status and errorMessage", async () => {
    const t = convexTest(schema, modules);
    const projectId = await seedProject(t);
    const serverId = await t.mutation(internal.mcpServers.add, {
      projectId,
      name: "fs",
      type: "local",
      command: "npx",
    });

    await t.mutation(internal.mcpServers.updateStatus, {
      serverId,
      status: "connected",
    });
    let stored = await t.run(async (ctx) => ctx.db.get(serverId));
    expect(stored?.status).toBe("connected");

    await t.mutation(internal.mcpServers.updateStatus, {
      serverId,
      status: "error",
      errorMessage: "spawn failed",
    });
    stored = await t.run(async (ctx) => ctx.db.get(serverId));
    expect(stored?.status).toBe("error");
    expect(stored?.errorMessage).toBe("spawn failed");
  });

  test("remove deletes the row", async () => {
    const t = convexTest(schema, modules);
    const projectId = await seedProject(t);
    const serverId = await t.mutation(internal.mcpServers.add, {
      projectId,
      name: "fs",
      type: "local",
      command: "npx",
    });

    await t.mutation(internal.mcpServers.remove, { serverId });
    expect(await t.run(async (ctx) => ctx.db.get(serverId))).toBeNull();
  });
});

describe("getRunContext MCP payload (Plan 009)", () => {
  test("returns enabled configs only, with no credential-shaped fields", async () => {
    const t = convexTest(schema, modules);
    const taskId = await t.run(async (ctx) => {
      const agentId = await ctx.db.insert("agents", {
        name: "A",
        role: "executor",
        status: "idle",
      });
      const projectId = await ctx.db.insert("projects", {
        name: "P",
        workspacePath: "/tmp/p",
        agentIds: [agentId],
      });
      await ctx.db.insert("mcpServers", {
        projectId,
        name: "enabled-fs",
        type: "local",
        command: "npx",
        args: '["-y", "@modelcontextprotocol/server-filesystem"]',
        status: "connected",
        createdAt: 1,
        enabled: true,
        autoConnect: false,
        transport: "stdio",
        allowedDirectories: ["/tmp/shared"],
      });
      await ctx.db.insert("mcpServers", {
        projectId,
        name: "disabled-fs",
        type: "local",
        command: "npx",
        status: "disconnected",
        createdAt: 2,
        enabled: false,
      });
      return await ctx.db.insert("tasks", {
        projectId,
        title: "T",
        command: "use the filesystem tools",
        status: "queued",
        assignedAgentIds: [agentId],
      });
    });

    const result = await t.query(internal.orchestration.getRunContext, { taskId });
    expect(result).not.toBeNull();
    expect(result!.mcpServers).toHaveLength(1);
    const server = result!.mcpServers[0];
    expect(server.name).toBe("enabled-fs");
    expect(server.command).toBe("npx");
    expect(server.allowedDirectories).toEqual(["/tmp/shared"]);

    // Config crosses to the worker; credential material never does.
    const serialized = JSON.stringify(result!.mcpServers);
    for (const field of ["apiKey", "apiKeyCiphertext", "secret", "token", "password"]) {
      expect(field in server).toBe(false);
      expect(serialized).not.toContain(field);
    }
  });
});
