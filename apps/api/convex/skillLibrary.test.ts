/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { loadLibrarySkills } from "./skillLibrary";
import { createSkillLoader, formatLibraryIndex, wantsLoadSkillTool } from "./lib/skillRuntime";
import { chatLocalTools, chatSkillLoader } from "./lib/chat/localTools";

const modules = import.meta.glob("./**/*.ts");

type T = ReturnType<typeof convexTest>;

async function agent(t: T, role: string, extra: Record<string, unknown> = {}) {
  return await t.run((ctx) =>
    ctx.db.insert("agents", { name: role, role, status: "idle", isEnabled: true, ...extra } as never)
  );
}

async function library(t: T, agentId: string) {
  return await t.run(async (ctx) => loadLibrarySkills(ctx, (await ctx.db.get(agentId as never))! as never));
}

describe("loadLibrarySkills", () => {
  test("name, description and version only: never a body", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.skills.create, { name: "Guide", description: "How we work", instructions: "secret body text" });
    const fe = await agent(t, "frontend");
    const refs = await library(t, fe);
    expect(refs).toEqual([{ name: "Guide", description: "How we work", version: 1 }]);
    expect(JSON.stringify(refs)).not.toContain("secret body text");
  });

  test("skills whose permissions the agent lacks are left out", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.skills.create, { name: "Browse", instructions: "b", permissions: ["browser"] });
    await t.mutation(api.skills.create, { name: "Plain", instructions: "p" });
    const backend = await agent(t, "backend");
    const qa = await agent(t, "qa");
    expect((await library(t, backend)).map((s) => s.name)).toEqual(["Plain"]);
    expect((await library(t, qa)).map((s) => s.name).sort()).toEqual(["Browse", "Plain"]);
  });

  test("a skill whose required skill the agent cannot use is left out; an attached requirement counts", async () => {
    const t = convexTest(schema, modules);
    const browse = await t.mutation(api.skills.create, { name: "Browse", instructions: "b", permissions: ["browser"] });
    const base = await t.mutation(api.skills.create, { name: "Base", instructions: "base" });
    await t.mutation(api.skills.create, { name: "NeedsBrowse", instructions: "nb", requires: [browse] });
    await t.mutation(api.skills.create, { name: "NeedsBase", instructions: "nbase", requires: [base] });
    const backend = await agent(t, "backend");
    expect((await library(t, backend)).map((s) => s.name).sort()).toEqual(["Base", "NeedsBase"]);
    // A deleted requirement takes its dependent out too.
    const gone = await t.mutation(api.skills.create, { name: "Gone", instructions: "g" });
    await t.mutation(api.skills.create, { name: "NeedsGone", instructions: "ng", requires: [gone] });
    await t.run((ctx) => ctx.db.delete(gone));
    expect((await library(t, backend)).map((s) => s.name)).not.toContain("NeedsGone");
  });

  test("the agent's pinned version wins for name, description and version", async () => {
    const t = convexTest(schema, modules);
    const skillId = await t.mutation(api.skills.create, { name: "Lint", description: "v1 desc", instructions: "lint v1" });
    await t.mutation(api.skills.update, { skillId, description: "v2 desc", instructions: "lint v2" });
    const pinned = await agent(t, "frontend", { skillIds: [skillId] });
    const latest = await agent(t, "backend");
    await t.mutation(api.skills.setPin, { agentId: pinned, skillId, version: 1 });
    expect(await library(t, pinned)).toEqual([{ name: "Lint", description: "v1 desc", version: 1 }]);
    expect(await library(t, latest)).toEqual([{ name: "Lint", description: "v2 desc", version: 2 }]);
    // The body follows the same rule.
    expect(await t.query(internal.skillLibrary.body, { agentId: pinned, name: "Lint" })).toEqual({
      name: "Lint",
      body: "lint v1",
      version: 1,
    });
    expect((await t.query(internal.skillLibrary.body, { agentId: latest, name: "Lint" }))?.body).toBe("lint v2");
  });
});

describe("library bodies on load_skill", () => {
  test("body: the full text, re-checked against the agent", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.skills.create, { name: "Browse", instructions: "browse body", permissions: ["browser"] });
    const backend = await agent(t, "backend");
    const qa = await agent(t, "qa");
    expect(await t.query(internal.skillLibrary.body, { agentId: backend, name: "Browse" })).toBeNull();
    expect((await t.query(internal.skillLibrary.body, { agentId: qa, name: "Browse" }))?.body).toBe("browse body");
    expect(await t.query(internal.skillLibrary.body, { agentId: qa, name: "Missing" })).toBeNull();
  });

  test("bodyForWorker is token-gated", async () => {
    process.env.CONVEX_SERVICE_TOKEN = "test-token";
    const t = convexTest(schema, modules);
    await t.mutation(api.skills.create, { name: "Guide", instructions: "guide body" });
    const fe = await agent(t, "frontend");
    await expect(t.action(api.skillLibrary.bodyForWorker, { workerToken: "wrong", agentId: fe, name: "Guide" })).rejects.toThrow();
    expect(await t.action(api.skillLibrary.bodyForWorker, { workerToken: "test-token", agentId: fe, name: "Guide" })).toMatchObject({
      name: "Guide",
      body: "guide body",
    });
  });

  test("chat: the loader fetches a library body only when load_skill asks for it", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.skills.create, { name: "Guide", description: "How we work", instructions: "guide body" });
    const fe = await agent(t, "frontend");
    const refs = await library(t, fe);
    const runQuery = vi.fn((ref: unknown, args: unknown) => (t.query as (r: unknown, a: unknown) => Promise<unknown>)(ref, args));
    const loader = chatSkillLoader({ runQuery } as never, { _id: fe, name: "frontend", role: "frontend", librarySkills: refs });
    expect(loader).toBeDefined();
    expect(runQuery).not.toHaveBeenCalled();
    const tools = chatLocalTools({ skillLoader: loader });
    const loadSkill = tools.localTools!.load_skill as (call: { tool: string; args: Record<string, unknown> }) => Promise<unknown>;
    const result = await loadSkill({ tool: "load_skill", args: { name: "guide" } });
    expect(result).toEqual({ ok: true, text: "## Skill: Guide (v1)\nguide body" });
    expect(runQuery).toHaveBeenCalledTimes(1);
  });
});

describe("skill runtime over library refs", () => {
  const refs = [
    { name: "Alpha", description: "first", version: 3 },
    { name: "Beta" },
  ];

  test("index lists name, description and version; no sizes, no bodies", () => {
    const index = formatLibraryIndex(refs);
    expect(index).toContain("- Alpha: first (v3)");
    expect(index).toContain("- Beta");
    expect(index).not.toContain("chars)");
    expect(wantsLoadSkillTool(undefined, "inline", refs)).toBe(true);
    expect(wantsLoadSkillTool(undefined, "inline", [])).toBe(false);
  });

  test("loadAsync: own skills shadow the library, fetches count against the cap, failures are reported", async () => {
    const fetchBody = vi.fn(async (ref: { name: string }) =>
      ref.name === "Beta" ? null : { body: `${ref.name} body`, version: 3 }
    );
    const loader = createSkillLoader([{ name: "alpha", instructions: "own alpha" }], {
      maxCalls: 2,
      library: [...refs, { name: "Gamma" }],
      fetchBody,
    });
    expect((await loader.loadAsync("Alpha")).text).toBe("## Skill: alpha\nown alpha");
    expect(fetchBody).not.toHaveBeenCalled();
    expect(await loader.loadAsync("beta")).toEqual({ ok: false, text: 'Skill "Beta" could not be loaded. Continue without it.' });
    expect(loader.calls).toBe(1);
    expect((await loader.loadAsync("Gamma")).text).toBe("## Skill: Gamma (v3)\nGamma body");
    expect((await loader.loadAsync("Gamma")).text).toMatch(/already loaded/);
    expect(loader.calls).toBe(2);
    expect((await loader.loadAsync("Beta")).text).toMatch(/limit reached/);
    // The synchronous path never reaches the library.
    expect(createSkillLoader([], { library: refs, fetchBody }).load("Alpha").ok).toBe(false);
  });
});
