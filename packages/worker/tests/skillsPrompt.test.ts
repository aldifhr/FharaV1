import { describe, expect, it } from "vitest";
import { appendSkillsToPrompt, formatSkillsSection, SKILLS_PROMPT_BUDGET } from "@/api/convex/lib/skills";
import { toAgentDefinition } from "@/services/runner/setup";
import { appendMemoryToPrompt } from "@/api/convex/lib/memory";

describe("library skills in the agent prompt", () => {
  it("appends each skill after the static system prompt", () => {
    const out = appendSkillsToPrompt("You are Frontend.", [
      { name: "A", instructions: "do a" },
      { name: "B", instructions: "do b" },
    ]);
    expect(out).toBe("You are Frontend.\n\n## Skill: A\ndo a\n\n## Skill: B\ndo b");
  });

  it("leaves the prompt untouched without skills", () => {
    expect(appendSkillsToPrompt("base", [])).toBe("base");
    expect(appendSkillsToPrompt(undefined, undefined)).toBeUndefined();
    expect(appendSkillsToPrompt(undefined, [{ name: "A", instructions: "x" }])).toBe("## Skill: A\nx");
  });

  it("keeps the section within the budget, truncating then dropping", () => {
    const big = "x".repeat(SKILLS_PROMPT_BUDGET);
    const section = formatSkillsSection([
      { name: "Small", instructions: "ok" },
      { name: "Big", instructions: big },
      { name: "Dropped", instructions: "never" },
    ]);
    expect(section.length).toBeLessThanOrEqual(SKILLS_PROMPT_BUDGET);
    expect(section).toContain("## Skill: Small\nok");
    expect(section).toContain("## Skill: Big\n");
    expect(section).toContain("(truncated)");
    expect(section).not.toContain("Dropped");
  });

  it("toAgentDefinition composes the skills into systemPrompt", () => {
    const def = toAgentDefinition({
      _id: "a1",
      _creationTime: 0,
      name: "Frontend",
      role: "frontend",
      status: "idle",
      systemPrompt: "static",
      attachedSkills: [{ name: "Tests first", instructions: "write a failing test" }],
    } as never);
    expect(def.systemPrompt).toBe("static\n\n## Skill: Tests first\nwrite a failing test");
  });
});

describe("memory in the agent prompt", () => {
  it("toAgentDefinition puts the memory section after the skills", () => {
    const def = toAgentDefinition({
      _id: "a1",
      _creationTime: 0,
      name: "Frontend",
      role: "frontend",
      status: "idle",
      systemPrompt: "static",
      attachedSkills: [{ name: "S", instructions: "skill body" }],
      memorySection: "## Memory\n\n### Note\nremember me",
    } as never);
    expect(def.systemPrompt).toBe("static\n\n## Skill: S\nskill body\n\n## Memory\n\n### Note\nremember me");
  });

  it("memory alone still follows the static prompt; no memory leaves it untouched", () => {
    expect(appendMemoryToPrompt("static", "## Memory\nx")).toBe("static\n\n## Memory\nx");
    expect(appendMemoryToPrompt("static", undefined)).toBe("static");
    expect(appendMemoryToPrompt(undefined, "## Memory\nx")).toBe("## Memory\nx");
  });
});
