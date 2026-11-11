// Paradev C3: skills the user invoked ("/<skill>") reach every task run inline.
import { describe, expect, test } from "vitest";
import type { PromptSkill } from "@/api/convex/lib/skills";
import { INVOKED_SKILLS_NOTE } from "@/api/convex/lib/skillRuntime";
import { toAgentDefinition } from "@/services/runner/setup";
import { taskAgentSkills } from "@/execution/skillLoading";
import type { WorkerRunAgent } from "@/workerApi";

const FRONTEND: PromptSkill = { name: "frontend-design", description: "UI", instructions: "FRONTEND BODY", fullInstructions: "FRONTEND BODY" };
const OTHER: PromptSkill = { name: "release-notes", description: "Notes", instructions: "NOTES BODY" };

function agent(extra: Partial<WorkerRunAgent> = {}): WorkerRunAgent {
  return {
    _id: "a1",
    _creationTime: 0,
    name: "Frontend",
    role: "frontend",
    status: "idle",
    systemPrompt: "You are Frontend.",
    supportedTools: ["read_file"],
    attachedSkills: [FRONTEND, OTHER],
    ...extra,
  } as unknown as WorkerRunAgent;
}

const count = (text: string | undefined, needle: string) => (text ?? "").split(needle).length - 1;

describe("task invokedSkills → inline", () => {
  test("on_demand agent: the invoked skill is inline (once) and leaves the load_skill list", () => {
    const def = toAgentDefinition(agent({ skillLoading: "on_demand", invokedSkills: [FRONTEND] } as Partial<WorkerRunAgent>));
    expect(def.systemPrompt).toContain("## Skills invoked for this request");
    expect(def.systemPrompt).toContain(INVOKED_SKILLS_NOTE);
    expect(count(def.systemPrompt, "FRONTEND BODY")).toBe(1);
    expect(def.systemPrompt).toContain("## Skills (load on demand)");
    expect(def.systemPrompt).not.toContain("NOTES BODY");
    expect(def.onDemandSkills?.map((s) => s.name)).toEqual(["release-notes"]);
    // Guidance only: no tool is granted.
    expect(def.supportedTools).toEqual(["read_file"]);
  });

  test("inline agent: an invoked skill it already carries is not duplicated", () => {
    const def = toAgentDefinition(agent({ invokedSkills: [FRONTEND] } as Partial<WorkerRunAgent>));
    expect(count(def.systemPrompt, "FRONTEND BODY")).toBe(1);
    expect(count(def.systemPrompt, "NOTES BODY")).toBe(1);
    expect(def.systemPrompt!.indexOf("NOTES BODY")).toBeLessThan(def.systemPrompt!.indexOf("## Skills invoked for this request"));
  });

  test("an agent that does not carry the skill still gets it; no invoked skills = unchanged", () => {
    const plain = agent({ attachedSkills: [] } as Partial<WorkerRunAgent>);
    expect(taskAgentSkills(plain).systemPrompt).toBe("You are Frontend.");
    const withSkill = taskAgentSkills({ ...plain, invokedSkills: [FRONTEND] });
    expect(withSkill.systemPrompt).toContain("FRONTEND BODY");
    expect(withSkill.onDemandSkills).toBeUndefined();
  });
});
