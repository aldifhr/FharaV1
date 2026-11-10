/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  BUILT_IN_TEMPLATES,
  builtInTemplateId,
  matchSkillsByName,
  nextAgentName,
} from "./lib/agentTemplates";
import { ROLES } from "./lib/roles";

const modules = import.meta.glob("./**/*.ts");

describe("agent templates helpers", () => {
  test("nextAgentName follows the New agent rule and skips taken numbers", () => {
    expect(nextAgentName("frontend", [])).toBe("Frontend");
    expect(nextAgentName("frontend", [{ name: "Frontend", role: "frontend" }])).toBe("Frontend 2");
    expect(
      nextAgentName("frontend", [
        { name: "Frontend", role: "frontend" },
        { name: "Frontend 2", role: "frontend" },
      ])
    ).toBe("Frontend 3");
    // "Frontend 2" was deleted earlier but "Frontend 3" is still around.
    expect(
      nextAgentName("frontend", [
        { name: "Frontend", role: "frontend" },
        { name: "Frontend 2", role: "frontend" },
        { name: "Frontend 3", role: "qa" },
      ])
    ).toBe("Frontend 4");
    expect(nextAgentName("qa", [{ name: "Frontend", role: "frontend" }])).toBe("QA");
  });

  test("matchSkillsByName is case-insensitive, ordered, and skips unknowns", () => {
    const lib = [
      { _id: "a", name: "Write tests first" },
      { _id: "b", name: "Conventional commits" },
    ];
    expect(matchSkillsByName(["conventional COMMITS", "Missing", "write tests first"], lib)).toEqual(["b", "a"]);
  });

  test("every built-in prompt starts with its role seed prompt", () => {
    for (const t of BUILT_IN_TEMPLATES) {
      expect(ROLES[t.role]).toBeDefined();
      expect(t.systemPrompt.length).toBeGreaterThan(200);
    }
  });
});

describe("agentTemplates functions", () => {
  test("list returns built-ins with skills matched by name, then custom templates", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.skills.seedDefaults, {});
    await t.mutation(api.agentTemplates.create, { name: "Mine", role: "backend" });
    const list = await t.query(api.agentTemplates.list, {});
    expect(list.slice(0, BUILT_IN_TEMPLATES.length).every((x) => x.builtIn)).toBe(true);
    const react = list.find((x) => x.id === builtInTemplateId("react-frontend"))!;
    const skills = await t.query(api.skills.list, {});
    const names = react.skillIds.map((id) => skills.find((s) => s._id === id)?.name);
    expect(names).toEqual(["Accessible UI checklist", "Conventional commits"]);
    const mine = list[list.length - 1];
    expect(mine.name).toBe("Mine");
    expect(mine.builtIn).toBe(false);
    // Empty prompt falls back to the role default.
    expect(mine.systemPrompt).toContain("Backend Developer");
  });

  test("createAgentFromTemplate names, prefills and joins the project", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.skills.seedDefaults, {});
    const projectId = await t.run((ctx) =>
      ctx.db.insert("projects", { name: "P", workspacePath: "p", agentIds: [] } as never)
    );
    await t.run((ctx) =>
      ctx.db.insert("agents", { name: "Frontend", role: "frontend", status: "idle", isEnabled: true })
    );
    const templateId = builtInTemplateId("react-frontend");
    const first = await t.mutation(api.agentTemplates.createAgentFromTemplate, { templateId, projectId });
    expect(first.name).toBe("Frontend 2");
    const agent = await t.run((ctx) => ctx.db.get(first.agentId));
    const template = BUILT_IN_TEMPLATES.find((x) => x.key === "react-frontend")!;
    expect(agent?.role).toBe("frontend");
    expect(agent?.systemPrompt).toBe(template.systemPrompt);
    expect(agent?.skillIds).toHaveLength(2);
    expect(agent?.avatarParams).toEqual(template.avatarParams);
    expect(agent?.capabilities).toEqual([...ROLES.frontend.capabilities]);
    expect(agent?.isEnabled).toBe(true);
    const project = await t.run((ctx) => ctx.db.get(projectId));
    expect(project?.agentIds).toEqual([first.agentId]);

    const second = await t.mutation(api.agentTemplates.createAgentFromTemplate, { templateId });
    expect(second.name).toBe("Frontend 3");
    await expect(
      t.mutation(api.agentTemplates.createAgentFromTemplate, { templateId: "builtin:nope" })
    ).rejects.toThrow(/not found/);
  });

  test("saveFromAgent round-trips through createAgentFromTemplate", async () => {
    const t = convexTest(schema, modules);
    const skillId = await t.mutation(api.skills.create, { name: "Lint", instructions: "run lint" });
    const agentId = await t.run((ctx) =>
      ctx.db.insert("agents", {
        name: "QA",
        role: "qa",
        status: "idle",
        isEnabled: true,
        systemPrompt: "Test everything twice.",
        skillIds: [skillId],
        executionRuntime: "opencode",
        opencodeModel: "openrouter/some-model",
        avatarParams: { face: 1, hair: 2, eyes: 3, mouth: 4, outfit: 5, accessory: 6, facialHair: 7, bg: "#fff" },
      })
    );
    const saved = await t.mutation(api.agentTemplates.saveFromAgent, { agentId });
    expect(saved.name).toBe("QA");
    const again = await t.mutation(api.agentTemplates.saveFromAgent, { agentId });
    expect(again.name).toBe("QA 2");

    const made = await t.mutation(api.agentTemplates.createAgentFromTemplate, { templateId: saved.templateId });
    expect(made.name).toBe("QA 2");
    const agent = await t.run((ctx) => ctx.db.get(made.agentId));
    expect(agent?.systemPrompt).toBe("Test everything twice.");
    expect(agent?.skillIds).toEqual([skillId]);
    // Plan 035: the template keeps the runtime/model as legacy data, but a
    // new agent does not inherit them - the app-wide setting decides.
    const template = await t.run((ctx) => ctx.db.get(saved.templateId));
    expect(template?.runtime).toBe("opencode");
    expect(template?.opencodeModel).toBe("openrouter/some-model");
    expect(agent?.executionRuntime).toBeUndefined();
    expect(agent?.opencodeModel).toBeUndefined();
    expect((agent?.avatarParams as { face: number }).face).toBe(1);
  });

  test("update/remove apply to custom templates only; names stay unique", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(api.agentTemplates.create, { name: "A", role: "qa", tags: ["E2E", "e2e"] });
    await expect(t.mutation(api.agentTemplates.create, { name: "A", role: "qa" })).rejects.toThrow(/already exists/);
    await expect(t.mutation(api.agentTemplates.create, { name: "React Frontend", role: "qa" })).rejects.toThrow(/built-in/);
    await expect(t.mutation(api.agentTemplates.create, { name: "B", role: "wizard" })).rejects.toThrow(/Unknown role/);
    await t.mutation(api.agentTemplates.update, { templateId: id, name: "A2", systemPrompt: "custom" });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.name).toBe("A2");
    expect(row?.systemPrompt).toBe("custom");
    expect(row?.tags).toEqual(["e2e"]);
    await expect(
      t.mutation(api.agentTemplates.remove, { templateId: builtInTemplateId("react-frontend") })
    ).rejects.toThrow(/cannot be deleted/);
    await t.mutation(api.agentTemplates.remove, { templateId: id });
    expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
  });

  test("agents.create accepts the modal's avatar and template skills", async () => {
    const t = convexTest(schema, modules);
    const skillId = await t.mutation(api.skills.create, { name: "S", instructions: "s" });
    const avatar = { face: 1, hair: 1, eyes: 1, mouth: 1, outfit: 1, accessory: 1, facialHair: 1, bg: "#000" };
    const agentId = await t.mutation(api.agents.create, {
      name: "Backend",
      role: "backend",
      avatarParams: avatar,
      skillIds: [skillId, skillId],
      executionRuntime: "api",
    });
    const agent = await t.run((ctx) => ctx.db.get(agentId));
    expect(agent?.avatarParams).toEqual(avatar);
    expect(agent?.skillIds).toEqual([skillId]);
    expect(agent?.executionRuntime).toBe("api");
  });
});
