/**
 * GOAT G1: every code-writing prompt (code_change, native provider) carries
 * the shared completion contract, and the
 * Frontend / Backend / DevOps roles get the fhara-discipline skill.
 */
import { describe, expect, test } from "vitest";
import { COMPLETION_CONTRACT, COMPLETION_CONTRACT_LINES, buildNativePrompt, codeChangePrompt } from "@/prompts";
import { AGENT_SEED_PROMPTS } from "@/api/convex/lib/prompts/agents";
import { builtinSkillKeysForRole } from "@/api/convex/lib/builtinSkills";

const CODE_ROLES = ["frontend", "backend", "devops"] as const;

describe("completion contract", () => {
  test("stays compact", () => {
    expect(COMPLETION_CONTRACT_LINES.length).toBeLessThanOrEqual(4);
    expect(COMPLETION_CONTRACT.length).toBeLessThan(700);
    expect(COMPLETION_CONTRACT).toMatch(/NOT RUN:/);
  });

  test.each(CODE_ROLES)("the %s code_change and native prompts contain it", (role) => {
    const subtask = { title: `${role} part`, description: "Add a field" };
    const cc = codeChangePrompt({ command: "Add a field", subtask, context: "ctx", staged: "", mcpFindings: "" });
    expect(cc).toContain(COMPLETION_CONTRACT);
    const native = buildNativePrompt({ ...subtask, command: "Add a field", systemPrompt: AGENT_SEED_PROMPTS[role] });
    expect(native).toContain(COMPLETION_CONTRACT);
    expect(native).toContain(AGENT_SEED_PROMPTS[role]);
    expect(builtinSkillKeysForRole(role)).toContain("fhara-discipline");
  });

});
