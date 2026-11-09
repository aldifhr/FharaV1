/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { changedFields } from "./lib/recordAudit";

const modules = import.meta.glob("./**/*.ts");

describe("config changes write audit rows", () => {
  test("agents create/update/remove record field names only", async () => {
    const t = convexTest(schema, modules);
    const agentId = await t.mutation(api.agents.create, { name: "Bea", role: "backend" });
    await t.mutation(api.agents.update, {
      agentId,
      name: "Bea",
      role: "backend",
      systemPrompt: "SECRET-PROMPT-TEXT",
    });
    await t.mutation(api.agents.remove, { agentId });

    const page = await t.query(api.auditLog.list, { category: "config" });
    const actions = page.items.map((r) => r.action);
    expect(actions).toEqual(["agent.remove", "agent.update", "agent.create"]);
    const update = page.items.find((r) => r.action === "agent.update")!;
    expect(update.tool).toBe("config");
    expect(update.decision).toBe("recorded");
    expect(update.details).toEqual({ changed: ["systemPrompt"] });
    expect(JSON.stringify(page.items)).not.toContain("SECRET-PROMPT-TEXT");
  });

  test("an update that changes nothing writes no row", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.mutation(api.projects.create, { name: "P", workspacePath: "/tmp/p" });
    await t.mutation(api.projects.update, { projectId, instructions: "Use pnpm" });
    await t.mutation(api.projects.update, { projectId, instructions: "Use pnpm" });
    const page = await t.query(api.auditLog.list, { projectId });
    expect(page.items.map((r) => r.action)).toEqual(["project.update", "project.create"]);
    expect(page.items[0].details).toEqual({ changed: ["instructions"] });
  });

  test("provider keys never reach the audit row", async () => {
    process.env.CONVEX_SERVICE_TOKEN = "test-token";
    process.env.PROVIDER_ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const t = convexTest(schema, modules);
    const id = await t.mutation(api.llmProviders.create, {
      token: "test-token",
      name: "OpenAI",
      provider: "openai",
      model: "gpt-x",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKey: "sk-super-secret",
      priority: 1,
    });
    await t.mutation(api.llmProviders.updateProvider, { token: "test-token", id, apiKey: "sk-rotated-secret", priority: 2 });
    const page = await t.query(api.auditLog.list, {});
    const text = JSON.stringify(page.items);
    expect(text).not.toContain("sk-super-secret");
    expect(text).not.toContain("sk-rotated-secret");
    const created = page.items.find((r) => r.action === "llmProvider.create")!;
    expect(created.details.fields).toContain("apiKey");
    const updated = page.items.find((r) => r.action === "llmProvider.update")!;
    expect(updated.details).toEqual({ changed: ["apiKey", "priority"] });
  });

  test("approvals and MCP servers are recorded", async () => {
    const t = convexTest(schema, modules);
    const { projectId, approvalId } = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      const taskId = await ctx.db.insert("tasks", { projectId, title: "T", command: "c", status: "needs_approval" });
      const approvalId = await ctx.db.insert("approvals", {
        taskId,
        projectId,
        kind: "git_push",
        summary: "Push branch",
        status: "pending",
      });
      return { projectId, approvalId };
    });
    await t.mutation(api.approvals.reject, { approvalId });
    const serverId = await t.mutation(internal.mcpServers.add, {
      projectId,
      name: "fs",
      type: "local",
      command: "npx fs --token=abc123",
    });
    await t.mutation(internal.mcpServers.remove, { serverId });

    const all = await t.query(api.auditLog.list, { projectId });
    expect(all.items.map((r) => r.action)).toEqual(["mcpServer.remove", "mcpServer.add", "approval.reject"]);
    expect(JSON.stringify(all.items)).not.toContain("abc123");
    const denied = await t.query(api.auditLog.list, { projectId, decision: "denied" });
    expect(denied.items.map((r) => r.action)).toEqual(["approval.reject"]);
  });
});

describe("auditLog.list", () => {
  test("filters, labels agent actors, and paginates newest first", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      await ctx.db.insert("agents", { name: "Coder", role: "backend", status: "idle" });
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert("audit", {
          projectId,
          actor: "Coder",
          tool: "run_command",
          action: "run",
          decision: i === 2 ? "denied" : "allowed",
          target: `cmd-${i}`,
          createdAt: i,
        });
      }
      return projectId;
    });

    const tools = await t.query(api.auditLog.list, { projectId, category: "tools" });
    expect(tools.items).toHaveLength(5);
    expect(tools.items[0].target).toBe("cmd-4");
    expect(tools.items[0].actorRole).toBe("backend");
    expect(tools.items[0].projectName).toBe("P");
    expect(tools.nextCursor).toBeNull();

    const first = await t.query(api.auditLog.list, { projectId, limit: 2 });
    expect(first.items.map((r) => r.target)).toEqual(["cmd-4", "cmd-3"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await t.query(api.auditLog.list, { projectId, limit: 2, cursor: first.nextCursor });
    expect(second.items.map((r) => r.target)).toEqual(["cmd-2", "cmd-1"]);
    const third = await t.query(api.auditLog.list, { projectId, limit: 2, cursor: second.nextCursor });
    expect(third.items.map((r) => r.target)).toEqual(["cmd-0"]);
    expect(third.nextCursor).toBeNull();

    const config = await t.query(api.auditLog.list, { projectId, category: "config" });
    expect(config.items).toHaveLength(0);
  });

  test("hides rows of a project the viewer cannot see", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const owned = await ctx.db.insert("projects", { name: "O", workspacePath: "/tmp/o", ownerId: "x" });
      await ctx.db.insert("audit", { projectId: owned, actor: "a", tool: "read_file", action: "read", decision: "allowed", createdAt: 1 });
      await ctx.db.insert("audit", { actor: "user", tool: "config", action: "agent.create", decision: "recorded", createdAt: 2 });
    });
    const page = await t.query(api.auditLog.list, {});
    expect(page.items.map((r) => r.action)).toEqual(["agent.create"]);
  });
});

describe("changedFields", () => {
  test("compares values but returns names only", () => {
    expect(changedFields({ a: 1, b: "x", c: [1] }, { a: 1, b: "y", c: [1, 2], updatedAt: 5 })).toEqual(["b", "c"]);
    expect(changedFields({ a: 1 }, { a: undefined, z: undefined })).toEqual(["a"]);
  });
});
