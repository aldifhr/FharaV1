/// <reference types="vite/client" />
/**
 * Role prompt templates (lib/prompts/roles/*.md): the fixed-team seeds use
 * them, an unedited earlier seed follows the template while a customised
 * prompt is kept, "Reset to role template" overwrites one agent, and the
 * create form's prefill keeps text the user typed.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { FIXED_AGENTS, defaultSystemPromptForRole } from "./agents";
import { ROLE_KEYS } from "./lib/roles";
import { AGENT_SEED_PROMPTS, PREVIOUS_SEED_PROMPTS } from "./lib/prompts/agents";
import { ROLE_PROMPT_TEMPLATES } from "./lib/prompts/rolePrompts.data";
import { isUneditedSeed, prefillPromptForRole, roleTemplateFor } from "./lib/prompts/roleTemplate";

const modules = import.meta.glob("./**/*.ts");
const makeT = () => convexTest(schema, modules);
// The last one-line seed used before the role prompt templates. Later
// entries can be earlier template versions ("# <Role>" markdown, e.g. the
// pre-O2 Support template), which are checked separately below.
const isTemplateText = (p: string) => p.startsWith("# ");
const oldSeed = (role: (typeof ROLE_KEYS)[number]) => {
  const list = (PREVIOUS_SEED_PROMPTS[role] ?? []).filter((p) => !isTemplateText(p));
  return list[list.length - 1]!;
};

describe("role templates as seeds", () => {
  test.each(ROLE_KEYS)("%s seeds, defaults and keeps its earlier seed as previous", (role) => {
    expect(AGENT_SEED_PROMPTS[role]).toBe(ROLE_PROMPT_TEMPLATES[role]);
    expect(FIXED_AGENTS.find((a) => a.role === role)?.systemPrompt).toBe(ROLE_PROMPT_TEMPLATES[role]);
    expect(defaultSystemPromptForRole(role)).toBe(ROLE_PROMPT_TEMPLATES[role]);
    expect(oldSeed(role)).toMatch(/^You are the /);
    expect(isUneditedSeed(role, oldSeed(role))).toBe(true);
    expect(isUneditedSeed(role, `${oldSeed(role)} Also check Safari.`)).toBe(false);
  });

  test("earlier template versions are unedited seeds that migrate to the current template", () => {
    for (const role of ROLE_KEYS) {
      for (const prev of PREVIOUS_SEED_PROMPTS[role] ?? []) {
        expect(prev.startsWith("You are the ") || isTemplateText(prev)).toBe(true);
        expect(isUneditedSeed(role, prev)).toBe(true);
        expect(prev).not.toBe(ROLE_PROMPT_TEMPLATES[role]);
        if (isTemplateText(prev)) expect(prefillPromptForRole(prev, role)).toBe(ROLE_PROMPT_TEMPLATES[role]);
      }
    }
    // Pre-O2, and pre chat-language scoping (2026-11-13).
    const preO2Support = (PREVIOUS_SEED_PROMPTS.support ?? []).filter(isTemplateText);
    expect(preO2Support).toHaveLength(2);
    expect(preO2Support[0]).toMatch(/^# Support Specialist\n/);
    expect(ROLE_PROMPT_TEMPLATES.support).toMatch(/^# Support Specialist\n/);
  });

  test("legacy and label roles resolve to their template; custom roles have none", () => {
    expect(roleTemplateFor("UI/UX")).toBe(ROLE_PROMPT_TEMPLATES.designer);
    expect(roleTemplateFor("QA")).toBe(ROLE_PROMPT_TEMPLATES.qa);
    expect(roleTemplateFor("data-wrangler")).toBeNull();
  });
});

describe("fixed-team sync with the templates", () => {
  test("unedited one-line seeds follow the template, customised prompts stay", async () => {
    const t = makeT();
    const custom = `${oldSeed("backend")} Prefer Postgres.`;
    const ids = await t.run(async (ctx) => ({
      cto: await ctx.db.insert("agents", {
        name: "CTO", role: "cto", status: "idle", isEnabled: true, description: "d",
        capabilities: ["architecture", "project-coordination"], supportedTools: ["read_file"], systemPrompt: oldSeed("cto"),
      }),
      backend: await ctx.db.insert("agents", {
        name: "Backend", role: "backend", status: "idle", isEnabled: true, description: "d",
        capabilities: ["backend"], supportedTools: ["read_file", "write_file", "run_command"], systemPrompt: custom,
      }),
    }));
    await t.mutation(internal.agents.syncFixedTeamInternal, {});
    const rows = await t.run(async (ctx) => ({ cto: await ctx.db.get(ids.cto), backend: await ctx.db.get(ids.backend) }));
    expect(rows.cto?.systemPrompt).toBe(ROLE_PROMPT_TEMPLATES.cto);
    expect(rows.backend?.systemPrompt).toBe(custom);

    // The deploy step reports the customised agent and leaves it alone…
    const result = await t.mutation(internal.agentPrompts.applyRoleTemplates, {});
    expect(result.customised).toContain("Backend");
    expect(await t.run(async (ctx) => (await ctx.db.get(ids.backend))?.systemPrompt)).toBe(custom);
    // …unless forced.
    const forced = await t.mutation(internal.agentPrompts.applyRoleTemplates, { force: true });
    expect(forced.reset).toContain("Backend");
    expect(await t.run(async (ctx) => (await ctx.db.get(ids.backend))?.systemPrompt)).toBe(ROLE_PROMPT_TEMPLATES.backend);
  });

  test("the deploy step also updates an extra agent with an unedited seed", async () => {
    const t = makeT();
    await t.mutation(internal.agents.syncFixedTeamInternal, {});
    const extra = await t.run(async (ctx) =>
      ctx.db.insert("agents", { name: "QA 2", role: "qa", status: "idle", isEnabled: true, systemPrompt: oldSeed("qa") })
    );
    const result = await t.mutation(internal.agentPrompts.applyRoleTemplates, {});
    expect(result.reset).toEqual(["QA 2"]);
    expect(await t.run(async (ctx) => (await ctx.db.get(extra))?.systemPrompt)).toBe(ROLE_PROMPT_TEMPLATES.qa);
  });
});

describe("reset to role template", () => {
  test("overwrites a customised prompt and audits it", async () => {
    const t = makeT();
    const id = await t.run(async (ctx) =>
      ctx.db.insert("agents", { name: "Reviewer", role: "reviewer", status: "idle", isEnabled: true, systemPrompt: "my own" })
    );
    const res = await t.mutation(api.agentPrompts.resetToRoleTemplate, { agentId: id });
    expect(res.systemPrompt).toBe(ROLE_PROMPT_TEMPLATES.reviewer);
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.systemPrompt).toBe(ROLE_PROMPT_TEMPLATES.reviewer);
    const audit = await t.run(async (ctx) => ctx.db.query("audit").collect());
    expect(audit.some((a) => a.target === "Reviewer" && (a.details as { reason?: string }).reason === "reset to role template")).toBe(true);
  });

  test("a custom role has no template to reset to", async () => {
    const t = makeT();
    const id = await t.run(async (ctx) =>
      ctx.db.insert("agents", { name: "Wrangler", role: "data-wrangler", status: "idle", isEnabled: true, systemPrompt: "x" })
    );
    await expect(t.mutation(api.agentPrompts.resetToRoleTemplate, { agentId: id })).rejects.toThrow(/no template/);
  });
});

describe("create form prefill", () => {
  test("picking a role fills its template; switching roles swaps an untouched template", () => {
    expect(prefillPromptForRole("", "frontend")).toBe(ROLE_PROMPT_TEMPLATES.frontend);
    expect(prefillPromptForRole(ROLE_PROMPT_TEMPLATES.frontend, "backend")).toBe(ROLE_PROMPT_TEMPLATES.backend);
    expect(prefillPromptForRole(oldSeed("qa"), "qa")).toBe(ROLE_PROMPT_TEMPLATES.qa);
    expect(prefillPromptForRole(ROLE_PROMPT_TEMPLATES.qa, null)).toBe("");
  });

  test("text the user typed is kept", () => {
    expect(prefillPromptForRole("You review SQL only.", "backend")).toBe("You review SQL only.");
    expect(prefillPromptForRole(`${ROLE_PROMPT_TEMPLATES.frontend}\nUse Vue.`, "backend")).toBe(`${ROLE_PROMPT_TEMPLATES.frontend}\nUse Vue.`);
  });
});
