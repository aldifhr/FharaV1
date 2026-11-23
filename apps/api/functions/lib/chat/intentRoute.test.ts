import { describe, expect, it } from "vitest";
import { parseIntentResult, type IntentRoutingContext } from "./intent";
import { buildIntentClassifierPrompt } from "../prompts/chat";

const routing: IntentRoutingContext = {
  domains: ["frontend", "backend", "devops"],
  team: [
    { _id: "be", name: "Backend", role: "backend" },
    { _id: "fe", name: "Frontend", role: "frontend" },
  ],
};

const answer = (route: unknown) =>
  JSON.stringify({
    intent: "ask",
    subtype: "explanation",
    requiresWorkspace: false,
    requiresExecution: false,
    confidence: 0.9,
    reasoning: "question",
    route,
  });

describe("intent route: the LLM routing decision is validated before it can dispatch", () => {
  it("accepts a route to a live teammate in a known domain", () => {
    const result = parseIntentResult(
      answer({ domain: "frontend", agentId: "fe", confidence: 0.86, reasoning: "UI question" }),
      routing
    );
    expect(result?.route).toMatchObject({ domain: "frontend", agentId: "fe", confidence: 0.86 });
  });

  it("drops a route to an unknown teammate or an unknown domain", () => {
    expect(parseIntentResult(answer({ domain: "frontend", agentId: "ghost", confidence: 0.9 }), routing)?.route).toBeUndefined();
    expect(parseIntentResult(answer({ domain: "magic", agentId: "fe", confidence: 0.9 }), routing)?.route).toBeUndefined();
  });

  it("drops a low-confidence route so deterministic routing wins", () => {
    const result = parseIntentResult(
      answer({ domain: "frontend", agentId: "fe", confidence: 0.4 }),
      routing
    );
    expect(result?.route).toBeUndefined();
  });

  it("still parses intent when no routing context is supplied", () => {
    expect(parseIntentResult(answer({ domain: "frontend", agentId: "fe", confidence: 0.9 }))?.intent).toBe("ask");
  });
});

describe("intent classifier prompt: carries one-project context", () => {
  const prompt = buildIntentClassifierPrompt(
    "jangan ubah kode, cuma riset kenapa build lambat setelah deploy",
    { title: "Perbaiki CI", status: "running" },
    {
      domains: ["frontend", "backend", "devops"],
      team: [{ id: "fe", name: "Frontend", role: "frontend" }],
      historyLines: ["User: halo", "Agent: saya cek deploy"],
      contextSummary: "deploy terakhir gagal",
    }
  );

  it("includes the meaning rule, the team and the message", () => {
    expect(prompt).toContain("Judge by meaning, not by word list");
    expect(prompt).toContain("id=fe");
    expect(prompt).toContain("jangan ubah kode");
  });

  it("includes project history, summary and active task", () => {
    expect(prompt).toContain("saya cek deploy");
    expect(prompt).toContain("deploy terakhir gagal");
    expect(prompt).toContain("Perbaiki CI");
  });
});
