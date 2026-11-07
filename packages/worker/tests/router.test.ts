import { describe, it, expect } from "vitest";
import { routeMessage } from "@/router/route";
import { selectAgentsForChat } from "@/router/selectAgents";
import type { AgentDefinition } from "@/orchestrator/types";

const agents: AgentDefinition[] = [
  { _id: "a-fe", name: "Frontend", role: "frontend developer", capabilities: ["frontend-development"] },
  { _id: "a-be", name: "Backend", role: "backend developer", capabilities: ["backend-development"] },
  { _id: "a-cto", name: "CTO", role: "cto", capabilities: ["architecture", "code-review"] },
  { _id: "a-sec", name: "Security", role: "security auditor", capabilities: ["security-audit"] },
  { _id: "a-qa", name: "QA", role: "qa engineer", capabilities: ["browser-testing"] },
  { _id: "a-gen", name: "General", role: "assistant", capabilities: ["general"] },
];

describe("router: R1-R7 intent routing", () => {
  it("R1: greeting routes to chat, never to a task", async () => {
    const result = await routeMessage({ text: "hello!", agents });
    expect(result.intent).toBe("chat");
    expect(result.agentIds.length).toBe(1);
  });

  it("R2: a how-to question is answered in chat, no task", async () => {
    const result = await routeMessage({
      text: "How do I style a React button?",
      agents,
    });
    expect(result.intent).toBe("question");
    expect(result.agentIds).toContain("a-fe");
  });

  it("R3: an advice request is answered in chat, no task", async () => {
    const result = await routeMessage({
      text: "Should I use Zustand or Redux for global state?",
      agents,
    });
    expect(result.intent).toBe("advice");
    expect(result.agentIds.length).toBe(1);
  });

  it("R4: an explicit change request routes to task, no chat agents", async () => {
    const result = await routeMessage({
      text: "Add a login form to the page",
      agents,
    });
    expect(result.intent).toBe("task");
    expect(result.agentIds).toEqual([]);
  });

  it("R5: a bug report routes to task without resolving agents yet", async () => {
    const result = await routeMessage({
      text: "Fix the checkout button on the landing page",
      agents,
    });
    expect(result.intent).toBe("task");
    expect(result.agentIds).toEqual([]);
  });

  it("R6: ambiguous input with a garbage advisor falls back to chat, never task", async () => {
    const result = await routeMessage({
      text: "kadas aksjfd",
      agents,
      advise: async () => "not-an-intent",
    });
    expect(result.intent).toBe("chat");
    expect(result.reasons.some((r) => r.includes("advisor"))).toBe(true);
  });

  it("R6b: a valid advisor answer is honored (chat -> task upgrade)", async () => {
    const result = await routeMessage({
      text: "kadas aksjfd",
      agents,
      advise: async () => "task",
    });
    expect(result.intent).toBe("task");
    expect(result.reasons).toContain("advisor: task");
  });

  it("R6c: a throwing advisor fails closed to chat", async () => {
    const result = await routeMessage({
      text: "kadas aksjfd",
      agents,
      advise: async () => {
        throw new Error("provider down");
      },
    });
    expect(result.intent).toBe("chat");
  });

  it("R6d: ambiguous input without an advisor becomes chat", async () => {
    const result = await routeMessage({ text: "kadas aksjfd", agents });
    expect(result.intent).toBe("chat");
  });

  it("research-shaped input stays in chat (analysis never executes)", async () => {
    const result = await routeMessage({
      text: "What does the auth middleware do?",
      agents,
    });
    expect(result.intent).toBe("question");
  });

  it("audit-shaped input stays in chat", async () => {
    const result = await routeMessage({
      text: "Audit the security of the login flow",
      agents,
    });
    expect(result.intent).toBe("audit");
  });

  it("multi-domain change routes to task", async () => {
    const result = await routeMessage({
      text: "Update the API endpoint and the UI form",
      agents,
    });
    expect(result.intent).toBe("task");
  });
});

describe("router: R7 capability-based selection", () => {
  it("multi-agent reply only when >=2 agents serve distinct capabilities", () => {
    const selection = selectAgentsForChat(
      agents,
      ["frontend-development", "backend-development"],
      3
    );
    expect(selection.agentIds).toEqual(["a-fe", "a-be"]);
  });

  it("never falls back to an unrelated agent", () => {
    const selection = selectAgentsForChat(
      agents.filter((a) => a._id !== "a-gen"),
      ["web-browsing"],
      1
    );
    // No agent serves web-browsing: the first enabled agent is the only
    // fallback, and it must be named in the reasons, not silently skipped.
    expect(selection.agentIds.length).toBe(1);
    expect(selection.reasons.some((r) => r.includes("fallback"))).toBe(true);
  });

  it("respects the chatMaxAgents cap", () => {
    const selection = selectAgentsForChat(
      agents,
      ["frontend-development", "backend-development", "security-audit"],
      1
    );
    expect(selection.agentIds).toEqual(["a-fe"]);
  });

  it("empty agent list yields no selection, not an error", () => {
    const selection = selectAgentsForChat([], ["general"], 1);
    expect(selection.agentIds).toEqual([]);
  });

  it("CTO is not forced: a frontend question does not select the CTO", async () => {
    const result = await routeMessage({
      text: "How do I style a React button?",
      agents,
    });
    expect(result.agentIds).not.toContain("a-cto");
  });
});
