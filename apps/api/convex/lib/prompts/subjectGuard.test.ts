import { describe, expect, test } from "vitest";
import { buildChatPersonaLines, buildPersonalChatSystem, buildRequestSubjectGuard } from "./chat";
import { BUILTIN_SKILL_SOURCES } from "../builtinSkills.data";

// Live transcript 2026-11-11: in "Genlatter" (cover letters) a task-management
// UI concept came back as job-seeker personas and /surat-lamaran routes.
const designer = { name: "Designer", role: "designer", systemPrompt: "You are the UI/UX Designer." };

describe("request subject guard", () => {
  test("keeps the project as the base but never swaps the request's subject", () => {
    const guard = buildRequestSubjectGuard("Genlatter");
    expect(guard).toContain('"Genlatter" is the base: build on its stack, design tokens and shared components');
    expect(guard).toContain("Never recast it into the project's own product or domain");
    expect(guard).toContain("Designing <subject> as a new area inside Genlatter");
    expect(guard).toContain("ask one short question");
    expect(guard).toMatch(/concept or spec request .*do not read feature files/);
  });

  test("every project chat reply carries it, the Designer included", () => {
    const lines = buildChatPersonaLines(designer, "Genlatter", [designer], "apps/\n  web/", true).join("\n");
    expect(lines).toContain("Keep the subject of the user's request exactly as asked");
    const personal = buildPersonalChatSystem(designer, { projectName: "Genlatter", repoSnapshot: null, repoTools: false }).join("\n");
    expect(personal).toContain("Keep the subject of the user's request exactly as asked");
    const unattached = buildPersonalChatSystem(designer, { projectName: null, repoSnapshot: null, repoTools: false }).join("\n");
    expect(unattached).not.toContain("Keep the subject");
  });

  test("the design-system-detection skill says the same for tasks", () => {
    const skill = BUILTIN_SKILL_SOURCES.find((s) => s.key === "design-system-detection");
    expect(skill?.instructions).toContain("Keep the request's subject.");
    expect(skill?.instructions).toContain("Never recast it into the app's own domain");
  });
});
