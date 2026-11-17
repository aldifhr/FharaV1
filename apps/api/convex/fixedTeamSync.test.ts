/// <reference types="vite/client" />
/**
 * Plan 040 (P1): the fixed-team sync brings existing rows to the role
 * policy without touching user choices. A prompt is replaced only when it
 * is exactly an earlier seed (D10). Each patched row leaves an audit entry.
 *
 * Retired roles (reviewer, researcher, devops, support) were removed from
 * the role system entirely; the sync no longer disables or retires them.
 * Old stored agents with those roles are simply ignored by the sync.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { syncedTools } from "./agents";
import { ROLES } from "./lib/roles";
import { AGENT_SEED_PROMPTS, PREVIOUS_SEED_PROMPTS } from "./lib/prompts/agents";

const modules = import.meta.glob("./**/*.ts");
const makeT = () => convexTest(schema, modules);

describe("syncedTools", () => {
  test("always returns null — no tool migrations remain after retired-role removal", () => {
    expect(syncedTools(["read_file", "write_file"], "frontend")).toBeNull();
    expect(syncedTools(["read_file"], "qa")).toBeNull();
    expect(syncedTools(["read_file", "write_file"], "backend")).toBeNull();
    expect(syncedTools(["read_file"], "cto")).toBeNull();
    expect(syncedTools(undefined, "frontend")).toBeNull();
    // Retired role keys are no longer migrated either.
    expect(syncedTools(["read_file"], "researcher")).toBeNull();
  });
});

describe("fixed-team sync: unedited seed prompts and fresh seeds", () => {
  test("keeps edited prompts, replaces unedited seeds, and audits live-role patches", async () => {
    const t = makeT();
    const ids = await t.run(async (ctx) => ({
      reviewer: await ctx.db.insert("agents", {
        name: "Reviewer", role: "reviewer", status: "idle", isEnabled: true, description: "d",
        capabilities: ["code-review"], supportedTools: ["read_file", "write_file", "figma_peek"],
        systemPrompt: "my own review prompt",
      }),
      qa: await ctx.db.insert("agents", {
        name: "QA", role: "qa", status: "idle", isEnabled: true, description: "d",
        capabilities: ["browser-testing"], supportedTools: ["read_file", "run_command"],
        systemPrompt: `${PREVIOUS_SEED_PROMPTS.qa![0]} Also check Safari.`,
      }),
      cto: await ctx.db.insert("agents", {
        name: "CTO", role: "cto", status: "idle", isEnabled: true, description: "d",
        capabilities: ["architecture", "project-coordination"], supportedTools: ["read_file"],
        systemPrompt: PREVIOUS_SEED_PROMPTS.cto![0],
      }),
    }));

    await t.mutation(internal.agents.syncFixedTeamInternal, {});

    const rows = await t.run(async (ctx) => ({
      reviewer: await ctx.db.get(ids.reviewer),
      qa: await ctx.db.get(ids.qa),
      cto: await ctx.db.get(ids.cto),
      audit: await ctx.db.query("audit").collect(),
    }));

    // Retired-role agents are no longer touched by the sync.
    expect(rows.reviewer?.isEnabled).toBe(true);
    expect(rows.reviewer?.retiredAt).toBeUndefined();
    expect(rows.reviewer?.systemPrompt).toBe("my own review prompt");

    // Unedited old seed → current seed; an edited one stays exactly as is.
    expect(rows.cto?.systemPrompt).toBe(AGENT_SEED_PROMPTS.cto);
    expect(rows.qa?.systemPrompt).toBe(`${PREVIOUS_SEED_PROMPTS.qa![0]} Also check Safari.`);
    expect(rows.qa?.supportedTools).toEqual(["read_file", "run_command"]);

    const synced = rows.audit.filter((row) => row.action === "agent.sync");
    expect(synced.map((row) => row.target)).toContain("CTO");
    const ctoAudit = synced.find((row) => row.target === "CTO");
    expect((ctoAudit?.details as { changed: string[] }).changed).toContain("systemPrompt");

    // Idempotent: a second sync patches nothing more.
    await t.mutation(internal.agents.syncFixedTeamInternal, {});
    const again = await t.run(async (ctx) => (await ctx.db.query("audit").collect()).filter((row) => row.action === "agent.sync"));
    expect(again).toHaveLength(synced.length);
  });

  test("fresh seed rows follow the fixed-team policy; Designer is manual, not seeded", async () => {
    const t = makeT();
    await t.mutation(internal.agents.syncFixedTeamInternal, {});
    const agents = await t.run(async (ctx) => await ctx.db.query("agents").collect());
    const tools = (role: string) => agents.find((agent) => agent.role === role)?.supportedTools ?? [];
    expect(tools("frontend")).toContain("write_file");
    expect(tools("backend")).toContain("write_file");
    expect(tools("qa")).not.toContain("write_file");
    expect(tools("cto")).not.toContain("write_file");
    expect(agents.some((agent) => agent.role === "designer")).toBe(false);
  });
});
