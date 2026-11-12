// Paradev C3: skills the user invoked ("/<skill>") reach every task run inline.
import { describe, expect, test, vi } from "vitest";
import type { LibrarySkillRef, PromptSkill } from "@/api/convex/lib/skills";
import { INVOKED_SKILLS_NOTE } from "@/api/convex/lib/skillRuntime";
import { toAgentDefinition } from "@/services/runner/setup";
import { preloadOnDemandSkills, SKILL_PRELOAD_DONE, taskAgentSkills } from "@/execution/skillLoading";
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

describe("shared library on demand", () => {
  test("inline agent: library index in the prompt, no body anywhere, loadable by name", () => {
    const deploy: LibrarySkillRef = { name: "Deploy", description: "Ship it", version: 2 };
    const def = toAgentDefinition(agent({ librarySkills: [deploy] } as Partial<WorkerRunAgent>));
    expect(def.systemPrompt).toContain("## Library skills (load on demand)");
    expect(def.systemPrompt).toContain("- Deploy: Ship it (v2)");
    expect(def.onDemandSkills).toBeUndefined();
    expect(def.librarySkills).toEqual([deploy]);
    // Still guidance only: no tool is granted.
    expect(def.supportedTools).toEqual(["read_file"]);
  });

  test("a library skill the agent already carries is not listed twice", () => {
    const def = toAgentDefinition(
      agent({ skillLoading: "on_demand", librarySkills: [{ name: "frontend-design" }, { name: "release-notes" }] } as Partial<WorkerRunAgent>)
    );
    expect(count(def.systemPrompt, "frontend-design")).toBe(1);
    expect(count(def.systemPrompt, "release-notes")).toBe(1);
    expect(def.onDemandSkills?.map((s) => s.name)).toEqual(["frontend-design", "release-notes"]);
    expect(def.librarySkills).toBeUndefined();
  });

  test("preload fetches a library body only when the model asks for it", async () => {
    const fetchBody = vi.fn(async (ref: LibrarySkillRef) => ({ body: `${ref.name} BODY`, version: 4 }));
    const replies = ['{"tool":"load_skill","arguments":{"name":"deploy"}}', SKILL_PRELOAD_DONE];
    const result = await preloadOnDemandSkills({
      systemPrompt: "base",
      skills: undefined,
      library: [{ name: "Deploy" }, { name: "Unused" }],
      fetchBody,
      assignment: "ship it",
      call: async () => replies.shift() ?? SKILL_PRELOAD_DONE,
    });
    expect(fetchBody).toHaveBeenCalledTimes(1);
    expect(fetchBody).toHaveBeenCalledWith({ name: "Deploy" });
    expect(result.loaded).toEqual(["Deploy"]);
    expect(result.systemPrompt).toContain("## Skill: Deploy (v4)\nDeploy BODY");
  });
});
