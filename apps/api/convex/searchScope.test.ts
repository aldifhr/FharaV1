/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("search.global agent scoping", () => {
  test("returns only agents that belong to a visible project", async () => {
    const t = convexTest(schema, modules);
    const { visibleAgent } = await t.run(async (ctx) => {
      const visibleAgent = await ctx.db.insert("agents", { name: "Alpha dev", role: "developer", status: "idle" });
      const hiddenAgent = await ctx.db.insert("agents", { name: "Alpha secret", role: "developer", status: "idle" });
      const orphan = await ctx.db.insert("agents", { name: "Alpha orphan", role: "developer", status: "idle" });
      void orphan;
      await ctx.db.insert("projects", { name: "Open", workspacePath: "/tmp/open", agentIds: [visibleAgent] });
      // Owned by someone else: invisible to an anonymous viewer.
      await ctx.db.insert("projects", {
        name: "Private",
        workspacePath: "/tmp/private",
        ownerId: "other-user",
        agentIds: [hiddenAgent],
      });
      return { visibleAgent };
    });
    const res = await t.query(api.search.global, { q: "alpha" });
    expect(res.agents.map((a) => a._id)).toEqual([visibleAgent]);
    expect(res.agents[0].projectId).not.toBeNull();
    expect(JSON.stringify(res)).not.toContain("Alpha secret");
    expect(JSON.stringify(res)).not.toContain("Alpha orphan");
  });

  test("an owner sees the agents of their own project", async () => {
    const t = convexTest(schema, modules);
    const agentId = await t.run(async (ctx) => {
      const agentId = await ctx.db.insert("agents", { name: "Beta", role: "qa", status: "idle" });
      await ctx.db.insert("projects", { name: "Mine", workspacePath: "/tmp/m", ownerId: "user-1", agentIds: [agentId] });
      return agentId;
    });
    const anon = await t.query(api.search.global, { q: "beta" });
    expect(anon.agents).toEqual([]);
    const owner = await t.withIdentity({ subject: "user-1" }).query(api.search.global, { q: "beta" });
    expect(owner.agents.map((a) => a._id)).toEqual([agentId]);
  });
});
