import { describe, expect, it } from "vitest";
import { applyRoutingHint, capabilityOfRole, hintOverride, hintedKind, routingHintPromptLines, taskRoutingHint } from "@/orchestrator/planningHint";
import { classifyCommand } from "@/orchestrator/classifier";
import { buildPlanningPrompt, createPlan } from "@/orchestrator/planner";
import { conversationReplyCapability } from "@/orchestrator/plannerAgent";
import { loadPolicy } from "@/orchestrator/policy";
import type { AgentDefinition, Classification } from "@/types";

/**
 * P1a: the task's routing hint (tasks.routingHint, set by chat) is a prior for
 * the planner: a classifier tie-break, one prompt block, the conversation
 * reply owner, and the plan.hint_overridden payload. Only an explicit
 * @mention (hard) binds.
 */
const policy = { ...loadPolicy(), reviewMode: "never" as const, qaMode: "never" as const };
const cto: AgentDefinition = { _id: "cto", name: "CTO", role: "cto", capabilities: ["architecture"], isEnabled: true, priority: 9 };
const frontend: AgentDefinition = { _id: "fe", name: "Frontend", role: "frontend", capabilities: ["frontend-development"], isEnabled: true, priority: 5 };
const backend: AgentDefinition = { _id: "be", name: "Backend", role: "backend", capabilities: ["backend-development"], isEnabled: true, priority: 6 };
const support: AgentDefinition = { _id: "sp", name: "Support", role: "support", capabilities: ["documentation-support"], isEnabled: true, priority: 1 };
const team = [cto, frontend, backend, support];

const base = (fields: Partial<Classification>): Classification => ({ kind: "code_change", strategy: "single", reasons: ["text"], suggestedCapabilities: ["backend-development"], ...fields });

describe("taskRoutingHint / hintedKind / capabilityOfRole", () => {
  it("reads a stored hint and ignores junk", () => {
    expect(taskRoutingHint({ routingHint: { source: "offer", role: "frontend" } })).toEqual({ source: "offer", role: "frontend" });
    expect(taskRoutingHint({ routingHint: { source: "nope" } })).toBeNull();
    expect(taskRoutingHint({})).toBeNull();
    expect(taskRoutingHint(null)).toBeNull();
  });

  it("maps chat subtypes to task kinds; unknown subtypes map to nothing", () => {
    expect(hintedKind({ source: "offer", kind: "implementation" })).toBe("code_change");
    expect(hintedKind({ source: "offer", kind: "testing" })).toBe("code_change");
    expect(hintedKind({ source: "offer", kind: "explanation" })).toBe("research");
    expect(hintedKind({ source: "offer", kind: "audit" })).toBe("audit");
    expect(hintedKind({ source: "offer", kind: "small_talk" })).toBeNull();
    expect(hintedKind({ source: "offer" })).toBeNull();
    expect(hintedKind(null)).toBeNull();
  });

  it("a role's first capability", () => {
    expect(capabilityOfRole("frontend")).toBe("frontend-development");
    expect(capabilityOfRole("chef")).toBeNull();
    expect(capabilityOfRole(undefined)).toBeNull();
  });
});

describe("applyRoutingHint", () => {
  it("no hint: the text classification as is", () => {
    const b = base({});
    expect(applyRoutingHint(b, "x", null)).toBe(b);
  });

  it("same kind: the hint's role leads the capabilities", () => {
    const out = applyRoutingHint(base({}), "ubah tombol", { source: "offer", role: "frontend", kind: "implementation" });
    expect(out.kind).toBe("code_change");
    expect(out.suggestedCapabilities).toEqual(["frontend-development", "backend-development"]);
    expect(out.reasons.at(-1)).toBe("routing hint: owner frontend");
  });

  it("a soft kind from chat replaces the text guess (research → audit)", () => {
    const out = applyRoutingHint(base({ kind: "research", suggestedCapabilities: ["research"] }), "periksa kode auth", { source: "offer", kind: "audit" });
    expect(out.kind).toBe("audit");
    expect(out.strategy).toBe("single");
    expect(out.suggestedCapabilities[0]).toBe("code-review");
    expect(out.reasons.at(-1)).toBe("routing hint: audit from chat (offer)");
  });

  it("a read-only kind from research text becomes a change when chat offered implementation; complexity is not invented", () => {
    const out = applyRoutingHint(base({ kind: "research", suggestedCapabilities: ["research"] }), "landing page", { source: "offer", role: "frontend", kind: "implementation" });
    expect(out.kind).toBe("code_change");
    expect(out.suggestedCapabilities[0]).toBe("frontend-development");
    expect(out.complexity).toBeUndefined();
  });

  it("a hint never turns a change into a read-only kind", () => {
    const out = applyRoutingHint(base({ complexity: "medium" }), "tambah endpoint", { source: "offer", kind: "research" });
    expect(out.kind).toBe("code_change");
    expect(out.complexity).toBe("medium");
  });

  it("the text classifier's hard rules win: command, conversation, multi, investigation, explicit no-code", () => {
    const hint = { source: "offer" as const, role: "frontend", kind: "implementation" };
    for (const b of [base({ kind: "command" }), base({ kind: "conversation" }), base({ kind: "multi" }), base({ kind: "research", investigation: true })]) {
      expect(applyRoutingHint(b, "x", hint)).toBe(b);
    }
    const noCode = classifyCommand("jangan ubah kode, jelaskan saja cara kerja login");
    expect(applyRoutingHint(noCode, "jangan ubah kode, jelaskan saja cara kerja login", hint)).toBe(noCode);
  });
});

describe("routingHintPromptLines", () => {
  it("empty without a hint or without facts", () => {
    expect(routingHintPromptLines(null)).toEqual([]);
    expect(routingHintPromptLines({ source: "command" })).toEqual([]);
  });

  it("a soft hint is a prior with its facts listed", () => {
    expect(
      routingHintPromptLines({ source: "offer", role: "frontend", kind: "implementation", domain: "frontend", topic: "landing", files: ["a.tsx", "b.css"], brief: "I'll add a page." })
    ).toEqual([
      "",
      "Routing hint (from chat; a prior, override it when the request clearly needs another owner):",
      "- owner role: Frontend",
      "- intent: implementation",
      "- domain: frontend",
      "- topic: landing",
      "- files named: a.tsx, b.css",
      "- plan line: I'll add a page.",
    ]);
  });

  it("a hard hint (an @mention) says to route the work to that owner", () => {
    expect(routingHintPromptLines({ source: "mention", role: "backend", hard: true })[1]).toBe(
      "Routing hint (the user @mentioned this owner: route the implementing work to it):"
    );
  });

  it("the planning prompt carries the block after the classification, and only when there is a hint", () => {
    const command = "buatkan halaman landing";
    const classification = classifyCommand(command);
    const without = buildPlanningPrompt({ command, classification, agents: team, policy });
    expect(without).not.toContain("Routing hint");
    const prompt = buildPlanningPrompt({ command, classification, agents: team, policy, routingHint: { source: "offer", role: "frontend", files: ["landing.html"] } });
    expect(prompt).toContain("Routing hint (from chat; a prior, override it when the request clearly needs another owner):\n- owner role: Frontend\n- files named: landing.html");
    expect(prompt.indexOf("Suggested capabilities:")).toBeLessThan(prompt.indexOf("Routing hint"));
  });
});

describe("conversation reply owner", () => {
  it("the hint's role answers before the domain matcher; an absent role falls back", () => {
    expect(conversationReplyCapability("hello", team)).toBe("documentation-support");
    expect(conversationReplyCapability("hello", team, "backend")).toBe("backend-development");
    expect(conversationReplyCapability("hello", team, "designer")).toBe("documentation-support");
  });

  it("createPlan routes a conversation-only task's reply node to the hint's role", async () => {
    const command = "hello";
    const { plan } = await createPlan({ command, classification: classifyCommand(command), agents: team, policy, routingHint: { source: "route", role: "frontend" } });
    expect(plan.subtasks.map((s) => s.capability)).toEqual(["frontend-development"]);
  });
});

describe("hintOverride (plan.hint_overridden)", () => {
  it("a soft hint whose role is not the Response Owner is reported", () => {
    expect(hintOverride({ responseOwner: "backend" }, { source: "offer", role: "frontend" })).toEqual({ hinted: "frontend", planned: "backend", source: "offer" });
  });

  it("nothing when it matches, when hard, without a role, or without an owner", () => {
    expect(hintOverride({ responseOwner: "frontend" }, { source: "offer", role: "frontend" })).toBeNull();
    expect(hintOverride({ responseOwner: "backend" }, { source: "mention", role: "frontend", hard: true })).toBeNull();
    expect(hintOverride({ responseOwner: "backend" }, { source: "offer" })).toBeNull();
    expect(hintOverride({}, { source: "offer", role: "frontend" })).toBeNull();
    expect(hintOverride({ responseOwner: "backend" }, null)).toBeNull();
  });
});
