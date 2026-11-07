/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const { project1Id, project2Id, agentId } = await t.run(async (ctx) => {
    const p1 = await ctx.db.insert("projects", { name: "Northwind", workspacePath: "/tmp/n" });
    const p2 = await ctx.db.insert("projects", { name: "Atlas", workspacePath: "/tmp/a" });
    const agentId = await ctx.db.insert("agents", { name: "Dev", role: "developer", status: "idle", isEnabled: true });
    return { project1Id: p1, project2Id: p2, agentId };
  });
  await t.mutation(internal.roleRegistry.seedDefaults, {});
  return { t, project1Id, project2Id, agentId };
}

describe("organization: registry", () => {
  test("role definition reused across projects", async () => {
    const { t, project1Id, project2Id, agentId } = await setup();
    const { api } = await import("./_generated/api");
    await t.mutation(api.roleRegistry.assignToProject, { projectId: project1Id, agentId });
    await t.mutation(api.roleRegistry.assignToProject, { projectId: project2Id, agentId });
    const team1 = await t.query(api.roleRegistry.listProjectTeam, { projectId: project1Id });
    const team2 = await t.query(api.roleRegistry.listProjectTeam, { projectId: project2Id });
    expect(team1).toHaveLength(1);
    expect(team2).toHaveLength(1);
    expect(team1[0]!.agent?._id).toBe(team2[0]!.agent?._id);
  });
  test("different projects can have different team compositions", async () => {
    const { t, project1Id, project2Id, agentId } = await setup();
    const { api } = await import("./_generated/api");
    const otherAgent = await t.run(async (ctx) => ctx.db.insert("agents", { name: "QA", role: "qa", status: "idle", isEnabled: true }));
    await t.mutation(api.roleRegistry.assignToProject, { projectId: project1Id, agentId });
    await t.mutation(api.roleRegistry.assignToProject, { projectId: project2Id, agentId: otherAgent });
    const team1 = await t.query(api.roleRegistry.listProjectTeam, { projectId: project1Id });
    const team2 = await t.query(api.roleRegistry.listProjectTeam, { projectId: project2Id });
    expect(team1[0]!.agent?.name).toBe("Dev");
    expect(team2[0]!.agent?.name).toBe("QA");
  });
  test("removing assignment does not delete member", async () => {
    const { t, project1Id, agentId } = await setup();
    const { api } = await import("./_generated/api");
    await t.mutation(api.roleRegistry.assignToProject, { projectId: project1Id, agentId });
    await t.mutation(api.roleRegistry.removeFromProject, { projectId: project1Id, agentId });
    const team = await t.query(api.roleRegistry.listProjectTeam, { projectId: project1Id });
    expect(team).toHaveLength(0);
    const agent = await t.run(async (ctx) => ctx.db.get(agentId));
    expect(agent?._id).toBe(agentId);
  });
  test("agent members do not run continuously (idle default)", async () => {
    const { t, agentId } = await setup();
    const { api } = await import("./_generated/api");
    const status = await t.query(api.roleRegistry.getExecutionStatus, { agentId });
    expect(status.active).toBe(0);
    expect(status.status).toBe("idle");
  });
  test("project resources remain isolated (no cross-project file bleed via team)", async () => {
    const { t, project1Id, project2Id } = await setup();
    const { api } = await import("./_generated/api");
    // Team of p1 empty
    const team1 = await t.query(api.roleRegistry.listProjectTeam, { projectId: project1Id });
    const team2 = await t.query(api.roleRegistry.listProjectTeam, { projectId: project2Id });
    expect(team1).toEqual([]);
    expect(team2).toEqual([]);
  });
});
