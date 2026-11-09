/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("orgIntel", () => {
  test("org chart, capacity, agent profile, collaboration, load-aware setting", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const cto = await ctx.db.insert("agents", { name: "CTO", role: "cto", status: "idle", skillIds: [], supportedTools: ["read_file"] });
      const fe = await ctx.db.insert("agents", { name: "Frontend", role: "frontend", status: "idle", maxConcurrency: 2, llmModel: "m-1" });
      const be = await ctx.db.insert("agents", { name: "Backend", role: "backend", status: "idle" });
      const rv = await ctx.db.insert("agents", { name: "Reviewer", role: "reviewer", status: "idle" });
      const projectId = await ctx.db.insert("projects", { name: "Shop", workspacePath: "/tmp/a", agentIds: [cto, fe, be, rv] });
      const hidden = await ctx.db.insert("projects", { name: "Secret", workspacePath: "/tmp/c", ownerId: "someone-else" });
      const taskId = await ctx.db.insert("tasks", { projectId, title: "Checkout", command: "c", status: "running", updatedAt: now });
      const hiddenTask = await ctx.db.insert("tasks", { projectId: hidden, title: "Hidden", command: "c", status: "running", updatedAt: now });
      const base = { description: "d", order: 1, attempts: 1, status: "completed" as const };
      await ctx.db.insert("subtasks", { ...base, taskId, projectId, key: "api", title: "API", kind: "code_change", capability: "backend-development", dependencies: [], assignedAgentId: be });
      await ctx.db.insert("subtasks", { ...base, taskId, projectId, key: "ui", title: "UI", kind: "code_change", capability: "frontend-development", dependencies: ["api"], assignedAgentId: fe, startedAt: now - 3000, completedAt: now - 1000 });
      await ctx.db.insert("subtasks", { ...base, taskId, projectId, key: "review", title: "Review", kind: "review", capability: "code-review", dependencies: ["ui"], assignedAgentId: rv });
      await ctx.db.insert("subtasks", { ...base, taskId, projectId, key: "review_fix_1", title: "Fix", kind: "code_change", capability: "frontend-development", dependencies: [], assignedAgentId: fe, origin: "review_fix", status: "running" });
      await ctx.db.insert("executions", { taskId, projectId, subtaskKey: "review_fix_1", agentId: fe, agentName: "Frontend", capability: "frontend-development", workerId: "w", status: "running", attempt: 1, startedAt: now, leaseExpiresAt: now + 60_000, createdAt: now });
      await ctx.db.insert("executions", { taskId: hiddenTask, projectId: hidden, subtaskKey: "x", agentId: fe, agentName: "Frontend", capability: "frontend-development", workerId: "w", status: "running", attempt: 1, startedAt: now, leaseExpiresAt: now + 60_000, createdAt: now });
      await ctx.db.insert("tokenUsage", { projectId, taskId, agentId: fe, agentName: "Frontend", model: "m", inputTokens: 200, outputTokens: 100, estimatedCost: 0.02, createdAt: now });
      await ctx.db.insert("taskEvents", { taskId, projectId, type: "review.requested_changes", payload: {}, createdAt: now - 500 });
      await ctx.db.insert("evaluations", { taskId, projectId, planVersion: 1, verdict: "passed", checks: [], createdAt: now });
      await ctx.db.insert("delegations", { taskId, projectId, fromAgentId: fe, toAgentId: be, decision: "APPROVE", createdAt: now });
      const conversationId = await ctx.db.insert("conversations", { projectId, title: "c", status: "active", createdAt: now });
      await ctx.db.insert("messages", { projectId, conversationId, authorType: "user", content: "hi" });
      await ctx.db.insert("messages", { projectId, conversationId, authorType: "agent", agentId: cto, content: "@Frontend please check." });
      const reply = await ctx.db.insert("messages", { projectId, conversationId, authorType: "agent", agentId: fe, content: "checked" });
      return { cto, fe, be, rv, projectId, reply };
    });

    const chart = await t.query(api.orgIntel.orgChart, {});
    expect(chart.rootKey).toBe(ids.cto);
    expect(chart.nodes.find((n) => n.agentId === ids.fe)).toMatchObject({ parent: ids.cto, model: "m-1", maxConcurrency: 2 });
    expect(chart.nodes.find((n) => n.agentId === ids.cto)).toMatchObject({ tools: ["read_file"], skills: 0 });

    // The hidden project's execution does not show (nor count) for this viewer.
    const cap = await t.query(api.orgIntel.capacity, { projectId: ids.projectId });
    expect(cap.rows.find((r) => r.agentId === ids.fe)).toMatchObject({ running: 1, limit: 2, spare: 1 });
    expect(cap.loadAwareRouting).toBeNull();
    // The worker's load read is global (service side).
    const load = await t.query(internal.orgIntel.agentLoad, {});
    expect(load[ids.fe]).toBe(2);

    await t.mutation(api.orgIntel.setLoadAwareRouting, { projectId: ids.projectId, enabled: true });
    expect((await t.query(api.orgIntel.capacity, { projectId: ids.projectId })).loadAwareRouting).toBe(true);
    await t.mutation(api.orgIntel.setLoadAwareRouting, { projectId: ids.projectId, enabled: null });
    expect((await t.query(api.orgIntel.capacity, { projectId: ids.projectId })).loadAwareRouting).toBeNull();

    const profile = await t.query(api.orgIntel.agentProfile, { agentId: ids.fe, sinceDays: 7 });
    expect(profile).not.toBeNull();
    expect(profile!.subtasks.total).toBe(2);
    expect(profile!.fixes).toBe(1);
    expect(profile!.tokens).toMatchObject({ total: 300, cost: 0.02 });
    expect(profile!.workReviewed).toMatchObject({ tasks: 1, firstPass: 0 });
    expect(profile!.evals).toMatchObject({ tasks: 1, passed: 1 });
    expect(profile!.chatReplies).toBe(1);
    expect(profile!.recent[0].taskTitle).toBe("Checkout");
    expect(profile!.agent.label).toBe("Frontend");

    // Recorded handoff on the reply (what chat.ts writes).
    await t.mutation(internal.orgIntel.markChatHandoff, { messageId: ids.reply, fromAgentId: ids.cto });
    const graph = await t.query(api.orgIntel.collaboration, { projectId: ids.projectId, sinceDays: 30 });
    const edge = (from: string, to: string) => graph.edges.find((e) => e.from === from && e.to === to);
    expect(edge("frontend", "backend")?.counts.delegation).toBe(1);
    expect(edge("backend", "frontend")?.counts.dependency).toBe(1);
    expect(edge("frontend", "reviewer")?.counts.dependency).toBe(1);
    expect(edge("reviewer", "frontend")?.counts.review_loop).toBe(1);
    expect(edge("cto", "frontend")?.counts.chat).toBe(1);
    expect(graph.totals.chatRecorded).toBe(1);
  });
});
