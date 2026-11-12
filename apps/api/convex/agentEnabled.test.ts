/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { ROLE_KEYS } from "./lib/roles";

const modules = import.meta.glob("./**/*.ts");

describe("agents: disable / enable", () => {
  test("a disabled fixed agent stays disabled through the fixed-team sync and is not duplicated", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.syncFixedTeamInternal, {});
    const agents = await t.run((ctx) => ctx.db.query("agents").collect());
    const qa = agents.find((a) => a.role === "qa")!;
    await t.mutation(api.agentEnabled.setEnabled, { agentId: qa._id, isEnabled: false });

    await t.mutation(internal.agents.syncFixedTeamInternal, {});
    await t.mutation(api.agents.ensureFixedTeam, {});

    const after = await t.run((ctx) => ctx.db.query("agents").collect());
    expect(after).toHaveLength(ROLE_KEYS.length);
    expect(after.filter((a) => a.role === "qa")).toHaveLength(1);
    expect(after.find((a) => a._id === qa._id)?.isEnabled).toBe(false);

    await t.mutation(api.agentEnabled.setEnabled, { agentId: qa._id, isEnabled: true });
    expect((await t.run((ctx) => ctx.db.get(qa._id)))?.isEnabled).toBe(true);
  });
});
