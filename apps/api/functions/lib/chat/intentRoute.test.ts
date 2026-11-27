import { describe, expect, it } from "vitest";
import { parseIntentResult, type IntentRoutingContext } from "./intent";
import { buildIntentClassifierPrompt } from "../prompts/chat";
import { actionableRouting, parseRoutingClassification } from "./routingClassification";

const routing: IntentRoutingContext = {
  roles: ["cto", "lead", "frontend", "backend", "devops", "qa", "designer"],
  team: [
    { _id: "be", name: "Backend", role: "backend" },
    { _id: "fe", name: "Frontend", role: "frontend" },
  ],
};

const answer = (owner: unknown) =>
  JSON.stringify({
    intent: "task",
    subtype: "implementation",
    requiresWorkspace: false,
    requiresExecution: true,
    confidence: 0.9,
    reasoning: "request",
    owner,
  });

describe("intent owner: the LLM routing decision is validated before it can dispatch", () => {
  it("accepts a live RoleKey with kind, files and confidence", () => {
    const result = parseIntentResult(
      answer({ role: "frontend", kind: "implementation", files: ["src/a.tsx"], confidence: 0.86 }),
      routing
    );
    expect(result?.owner).toMatchObject({ role: "frontend", kind: "implementation", files: ["src/a.tsx"] });
    expect(actionableRouting(result?.owner)).not.toBeNull();
  });

  it("drops a retired role, an unknown kind and an invalid file list", () => {
    expect(parseIntentResult(answer({ role: "support", kind: "implementation", files: [], confidence: 0.9 }), routing)?.owner).toBeUndefined();
    expect(parseIntentResult(answer({ role: "backend", kind: "magic", files: [], confidence: 0.9 }), routing)?.owner).toBeUndefined();
    expect(parseIntentResult(answer({ role: "backend", kind: "implementation", files: [42], confidence: 0.9 }), routing)?.owner).toBeUndefined();
  });

  it("a null role or low confidence is not actionable (the caller asks the user)", () => {
    expect(actionableRouting(parseRoutingClassification({ role: null, kind: "research", files: [], confidence: 0.9 }))).toBeNull();
    expect(actionableRouting(parseRoutingClassification({ role: "qa", kind: "verification", files: [], confidence: 0.4 }))).toBeNull();
  });

  it("still parses intent when no routing context is supplied", () => {
    expect(parseIntentResult(answer({ role: "backend", kind: "implementation", files: [], confidence: 0.9 }))?.intent).toBe("task");
  });
});

describe("intent classifier prompt: carries one-project context", () => {
  const prompt = buildIntentClassifierPrompt(
    "jangan ubah kode, cuma riset kenapa build lambat setelah deploy",
    { title: "Perbaiki CI", status: "running" },
    {
      roles: routing.roles,
      team: [{ id: "fe", name: "Frontend", role: "frontend" }],
      historyLines: ["User: halo", "Agent: saya cek deploy"],
      contextSummary: "deploy terakhir gagal",
    }
  );

  it("includes the meaning rule, the enum and the message", () => {
    expect(prompt).toContain("Judge by meaning, not by word list");
    expect(prompt).toContain("cto|lead|frontend|backend|devops|qa|designer");
    expect(prompt).toContain("jangan ubah kode");
  });

  it("includes project history, summary and active task", () => {
    expect(prompt).toContain("saya cek deploy");
    expect(prompt).toContain("deploy terakhir gagal");
    expect(prompt).toContain("Perbaiki CI");
  });
});
