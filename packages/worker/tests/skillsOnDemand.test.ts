import { describe, expect, test } from "vitest";
import { appendSkillsToPrompt, LOAD_SKILL_MAX_CALLS, type PromptSkill } from "@/api/convex/lib/skills";
import { toAgentDefinition } from "@/services/runner/setup";
import { preloadOnDemandSkills, SKILL_PRELOAD_DONE } from "@/execution/skillLoading";
import type { WorkerRunAgent } from "@/workerApi";

const SKILLS: PromptSkill[] = [
  { name: "Design eng", description: "Craft", instructions: "short inline", fullInstructions: "FULL DESIGN TEXT ".repeat(1000) },
  { name: "Apple design", description: "HIG", instructions: "apple inline", fullInstructions: "APPLE FULL" },
];

function agent(extra: Partial<WorkerRunAgent> = {}): WorkerRunAgent {
  return {
    _id: "a1",
    _creationTime: 0,
    name: "Designer",
    role: "designer",
    status: "idle",
    systemPrompt: "You are Designer.",
    supportedTools: ["read_file", "write_file"],
    attachedSkills: SKILLS,
    ...extra,
  } as unknown as WorkerRunAgent;
}

describe("toAgentDefinition skill loading", () => {
  test("inline (default) is unchanged", () => {
    const def = toAgentDefinition(agent());
    expect(def.systemPrompt).toBe(appendSkillsToPrompt("You are Designer.", SKILLS));
    expect(def.onDemandSkills).toBeUndefined();
  });

  test("on_demand: index only in the prompt, skills kept for load_skill, tools untouched", () => {
    const def = toAgentDefinition(agent({ skillLoading: "on_demand" } as Partial<WorkerRunAgent>));
    expect(def.systemPrompt).toContain("## Skills (load on demand)");
    expect(def.systemPrompt).toContain("- Design eng: Craft");
    expect(def.systemPrompt).not.toContain("short inline");
    expect(def.systemPrompt).not.toContain("FULL DESIGN TEXT");
    expect(def.onDemandSkills).toEqual(SKILLS);
    expect(def.supportedTools).toEqual(["read_file", "write_file"]);
  });
});

describe("preloadOnDemandSkills", () => {
  test("loads the requested skills (full text) into the system prompt, then stops on DONE", async () => {
    const replies = [
      '{"tool":"load_skill","arguments":{"name":"design eng"}}',
      '{"tool":"load_skill","arguments":{"name":"Nope"}}',
      SKILL_PRELOAD_DONE,
    ];
    const seen: string[] = [];
    const res = await preloadOnDemandSkills({
      systemPrompt: "BASE",
      skills: SKILLS,
      assignment: "Polish the header",
      call: async (messages) => {
        seen.push(messages[messages.length - 1].content);
        return replies.shift() ?? SKILL_PRELOAD_DONE;
      },
    });
    expect(res.loaded).toEqual(["Design eng"]);
    expect(res.llmCalls).toBe(3);
    expect(res.failed.map((f) => f.name)).toEqual(["Nope"]);
    expect(res.systemPrompt!.startsWith("BASE\n\n## Loaded skills")).toBe(true);
    expect(res.systemPrompt).toContain("FULL DESIGN TEXT");
    expect(res.systemPrompt).not.toContain("APPLE FULL");
    expect(seen[0]).toContain("Polish the header");
    expect(seen[1]).toContain("[tool result: load_skill]");
  });

  test("bounded: at most LOAD_SKILL_MAX_CALLS loads, and capped chars per load", async () => {
    const many: PromptSkill[] = Array.from({ length: 8 }, (_, i) => ({ name: `S${i}`, instructions: `body ${i} `.repeat(10_000) }));
    let i = 0;
    const res = await preloadOnDemandSkills({
      systemPrompt: undefined,
      skills: many,
      assignment: "x",
      maxChars: 500,
      call: async () => `{"tool":"load_skill","arguments":{"name":"S${i++}"}}`,
    });
    expect(res.loaded).toHaveLength(LOAD_SKILL_MAX_CALLS);
    expect(res.llmCalls).toBe(LOAD_SKILL_MAX_CALLS);
    for (const chunk of res.systemPrompt!.split("## Skill: ").slice(1)) expect(chunk.length).toBeLessThanOrEqual(500);
  });

  test("no skills or no call → prompt unchanged, no LLM call", async () => {
    let calls = 0;
    const call = async () => {
      calls++;
      return SKILL_PRELOAD_DONE;
    };
    expect((await preloadOnDemandSkills({ systemPrompt: "B", skills: [], assignment: "x", call })).systemPrompt).toBe("B");
    expect(calls).toBe(0);
    const none = await preloadOnDemandSkills({ systemPrompt: "B", skills: SKILLS, assignment: "x", call });
    expect(none).toMatchObject({ systemPrompt: "B", loaded: [], llmCalls: 1 });
  });
});
