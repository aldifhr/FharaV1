/// <reference types="vite/client" />
/**
 * Plan 040 (P1): the fixed-team sync brings existing rows to the role
 * policy without touching user choices: new default tools are added
 * (Researcher web_reach, DevOps write_file), revoked ones removed
 * (Designer/Support write_file), and a prompt is replaced only when it is
 * exactly an earlier seed (D10). Each patched row leaves an audit entry.
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
  test("adds only the listed new defaults and removes only revoked ones", () => {
    expect(syncedTools(["read_file"], "researcher")).toEqual(["read_file", "web_reach"]);
    expect(syncedTools(["read_file", "web_reach"], "researcher")).toBeNull();
    expect(syncedTools(["read_file", "write_file", "my_tool"], "designer")).toEqual(["read_file", "my_tool"]);
    expect(syncedTools(["read_file", "run_command"], "devops")).toEqual(["read_file", "run_command", "write_file"]);
    // A frontend row whose user removed run_command keeps it removed.
    expect(syncedTools(["read_file", "write_file"], "frontend")).toBeNull();
    expect(syncedTools(undefined, "researcher")).toBeNull();
  });
});

describe("fixed-team sync: tools and unedited seed prompts", () => {
  test("patches old rows, keeps user-added tools and edited prompts, audits each patch", async () => {
    const t = makeT();
    const oldSupportSeed = PREVIOUS_SEED_PROMPTS.support![0];
    const ids = await t.run(async (ctx) => ({
      researcher: await ctx.db.insert("agents", {
        name: "Researcher", role: "researcher", status: "idle", isEnabled: true, description: "d",
        capabilities: ["research"], supportedTools: ["read_file"], systemPrompt: "my own research prompt",
      }),
      designer: await ctx.db.insert("agents", {
        name: "Designer", role: "designer", status: "idle", isEnabled: true, description: "d",
        capabilities: ["ui-ux-design"], supportedTools: ["read_file", "write_file", "figma_peek"],
        systemPrompt: AGENT_SEED_PROMPTS.designer,
      }),
      support: await ctx.db.insert("agents", {
        name: "Support", role: "support", status: "idle", isEnabled: true, description: "d",
        capabilities: [...ROLES.support.capabilities], supportedTools: ["read_file", "write_file"],
        systemPrompt: oldSupportSeed,
      }),
      qa: await ctx.db.insert("agents", {
        name: "QA", role: "qa", status: "idle", isEnabled: true, description: "d",
        capabilities: ["browser-testing"], supportedTools: ["read_file", "run_command"],
        systemPrompt: `${PREVIOUS_SEED_PROMPTS.qa![0]} Also check Safari.`,
      }),
    }));

    await t.mutation(internal.agents.syncFixedTeamInternal, {});

    const rows = await t.run(async (ctx) => ({
      researcher: await ctx.db.get(ids.researcher),
      designer: await ctx.db.get(ids.designer),
      support: await ctx.db.get(ids.support),
      qa: await ctx.db.get(ids.qa),
      audit: await ctx.db.query("audit").collect(),
    }));
    expect(rows.researcher?.supportedTools).toEqual(["read_file", "web_reach"]);
    expect(rows.researcher?.systemPrompt).toBe("my own research prompt");
    expect(rows.designer?.supportedTools).toEqual(["read_file", "figma_peek"]);
    expect(rows.support?.supportedTools).toEqual(["read_file"]);
    // Unedited old seed → current seed. Edited one stays exactly as is.
    expect(rows.support?.systemPrompt).toBe(AGENT_SEED_PROMPTS.support);
    expect(rows.qa?.systemPrompt).toBe(`${PREVIOUS_SEED_PROMPTS.qa![0]} Also check Safari.`);
    expect(rows.qa?.supportedTools).toEqual(["read_file", "run_command"]);

    const synced = rows.audit.filter((row) => row.action === "agent.sync");
    expect(synced.map((row) => row.target).sort()).toEqual(["Designer", "Researcher", "Support"]);
    const supportAudit = synced.find((row) => row.target === "Support");
    expect((supportAudit?.details as { changed: string[] }).changed).toEqual(["supportedTools", "systemPrompt"]);

    // Idempotent: a second sync patches nothing more.
    await t.mutation(internal.agents.syncFixedTeamInternal, {});
    const again = await t.run(async (ctx) => (await ctx.db.query("audit").collect()).filter((row) => row.action === "agent.sync"));
    expect(again).toHaveLength(synced.length);
  });

  test("fresh seed rows follow the role policy", async () => {
    const t = makeT();
    await t.mutation(internal.agents.syncFixedTeamInternal, {});
    const agents = await t.run(async (ctx) => await ctx.db.query("agents").collect());
    const tools = (role: string) => agents.find((agent) => agent.role === role)?.supportedTools ?? [];
    expect(tools("designer")).not.toContain("write_file");
    expect(tools("support")).not.toContain("write_file");
    expect(tools("researcher")).toContain("web_reach");
    expect(tools("devops")).toContain("write_file");
  });
});
