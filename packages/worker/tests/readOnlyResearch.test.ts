import { describe, expect, it } from "vitest";
import { classifyCommand, isExplicitNoCode } from "@/orchestrator/classifier";
import { validatePlan } from "@/orchestrator/planValidator";
import { requiresScaffold } from "@/orchestrator/decision";
import { evaluateDelegation } from "@/orchestrator/delegation";
import { BudgetTracker } from "@/orchestrator/budget";
import { loadPolicy } from "@/orchestrator/policy";
import { buildPlanningPrompt } from "@/orchestrator/planner";
import { readOnlyInstruction } from "@/prompts/readOnly";
import type { AgentDefinition, Classification } from "@/types";

const POLICY = loadPolicy();

// e2e B3: "riset … jangan ubah kode" was classified code_change, got a
// Frontend code_change subtask and failed with "no file changes".
describe("classifier: explicit no-code phrasing is research", () => {
  const research = [
    "Riset kenapa halaman dashboard lambat, jangan ubah kode",
    "riset arsitektur auth di backend, jangan ubah kode apapun",
    "Tolong cek bagaimana header dibuat tanpa ubah kode",
    "Bandingkan opsi state management untuk frontend, analisa saja",
    "Tambahkan dark mode? analisa saja dulu kemungkinannya",
    "Investigate why the build is slow, don't change code",
    "Look at how we could refactor the navbar component - research only",
    "Explain the payment flow and do not modify any files",
    "Please update the README? no, just research what is missing. Do not change the code.",
    "riset library chart yang cocok untuk dashboard",
    "Research which auth provider fits the API",
    "Jangan diubah kodenya, cukup jelaskan cara kerja webhook",
  ];
  for (const command of research) {
    it(`research: ${command}`, () => {
      expect(classifyCommand(command).kind).toBe("research");
    });
  }

  it("names the reason and keeps domain capabilities", () => {
    const result = classifyCommand("Riset komponen header di frontend, jangan ubah kode");
    expect(result.reasons.join(" ")).toMatch(/no-code/);
    expect(result.suggestedCapabilities).toContain("frontend-development");
    expect(result.suggestedCapabilities).toContain("research");
    expect(result.complexity).toBeUndefined();
  });

  it("a security audit phrased with no-code stays read-only (research) with the auditor first", () => {
    const result = classifyCommand("audit the auth flow for security issues, don't change code");
    expect(result.kind).toBe("research");
    expect(result.suggestedCapabilities[0]).toBe("security-audit");
  });

  it("change requests without no-code phrasing are unchanged", () => {
    expect(classifyCommand("Tambahkan dark mode toggle di header").kind).toBe("code_change");
    expect(classifyCommand("fix the login button styling").kind).toBe("code_change");
    expect(classifyCommand("make the email field read-only in the settings form").kind).toBe("code_change");
    expect(classifyCommand("riset library chart lalu perbaiki grafik di dashboard").kind).not.toBe("research");
    expect(classifyCommand("audit the authentication flow for security issues").kind).toBe("audit");
  });

  it("only the user's own words count, not attached file contexts", () => {
    const command =
      "Tambahkan tombol logout di navbar\n\nAttached file context:\n- @notes.md\n\n--- File: notes.md ---\nriset saja, jangan ubah kode";
    expect(isExplicitNoCode(command)).toBe(false);
    expect(classifyCommand(command).kind).toBe("code_change");
  });
});

const researchClassification: Classification = {
  kind: "research",
  strategy: "single",
  reasons: ["explicit no-code request (research/question only)"],
  suggestedCapabilities: ["research"],
};

function planWithCode() {
  return {
    goal: "Research dashboard performance",
    strategy: "dag",
    requiresApproval: true,
    maxConcurrency: 2,
    subtasks: [
      {
        key: "investigate",
        title: "Investigate",
        description: "Find the slow parts",
        kind: "research",
        capability: "research",
        dependencies: [],
        order: 0,
      },
      {
        key: "implement",
        title: "Optimize dashboard",
        description: "Memoize the chart",
        kind: "code_change",
        capability: "frontend-development",
        dependencies: ["investigate"],
        order: 1,
        allowedPaths: ["apps/web"],
        acceptance: [{ id: "typecheck", criterion: "tsc", check: "typecheck" }],
      },
      {
        key: "git",
        title: "Pull latest",
        description: "git pull --rebase",
        kind: "shell",
        capability: "shell-execution",
        dependencies: [],
        order: 2,
      },
      {
        key: "review",
        title: "Review",
        description: "Review the diff",
        kind: "review",
        capability: "code-review",
        dependencies: ["implement"],
        order: 3,
      },
      {
        key: "qa",
        title: "QA",
        description: "Browser check",
        kind: "qa",
        capability: "browser-testing",
        dependencies: ["review"],
        order: 4,
      },
      {
        key: "summary",
        title: "Summarize",
        description: "Write the report",
        kind: "analysis",
        capability: "research",
        dependencies: ["qa"],
        order: 5,
      },
    ],
  };
}

describe("validatePlan: read-only lock for research/question tasks", () => {
  for (const taskKind of ["research", "question", "conversation"]) {
    it(`${taskKind}: no code_change/shell/review/qa survive`, () => {
      const result = validatePlan(planWithCode(), 8, { taskKind });
      expect(result.ok).toBe(true);
      const plan = result.plan!;
      const kinds = plan.subtasks.map((subtask) => subtask.kind);
      expect(kinds).not.toContain("code_change");
      expect(kinds).not.toContain("shell");
      expect(kinds).not.toContain("review");
      expect(kinds).not.toContain("qa");
      expect(plan.requiresApproval).toBe(false);
    });
  }

  it("converts write nodes into read-only research nodes", () => {
    const result = validatePlan(planWithCode(), 8, { taskKind: "research" });
    const byKey = new Map(result.plan!.subtasks.map((subtask) => [subtask.key, subtask]));
    const implement = byKey.get("implement")!;
    expect(implement.kind).toBe("research");
    expect(implement.allowedPaths).toBeUndefined();
    expect(implement.description).toMatch(/^Read-only/);
    expect(implement.description).toMatch(/Memoize the chart/);
    expect(implement.acceptance?.map((gate) => gate.check)).toEqual(["review", "review"]);
    const git = byKey.get("git")!;
    expect(git.kind).toBe("research");
    expect(git.capability).toBe("research");
    expect(result.notes?.some((note) => /converted code_change subtask implement/.test(note))).toBe(true);
  });

  it("dropped review/qa nodes hand their dependencies to their dependents", () => {
    const result = validatePlan(planWithCode(), 8, { taskKind: "research" });
    const summary = result.plan!.subtasks.find((subtask) => subtask.key === "summary")!;
    expect(summary.dependencies).toEqual(["implement"]);
    expect(result.plan!.subtasks.map((subtask) => subtask.key)).toEqual(["investigate", "implement", "git", "summary"]);
    expect(result.notes?.filter((note) => /dropped/.test(note))).toHaveLength(2);
  });

  it("a code-change task keeps its plan exactly as before", () => {
    for (const taskKind of [undefined, "code_change", "multi", "audit"]) {
      const result = validatePlan(planWithCode(), 8, taskKind ? { taskKind } : {});
      expect(result.ok).toBe(true);
      expect(result.notes).toBeUndefined();
      expect(result.plan!.subtasks.map((subtask) => subtask.kind)).toEqual([
        "research",
        "code_change",
        "shell",
        "review",
        "qa",
        "analysis",
      ]);
      expect(result.plan!.requiresApproval).toBe(true);
    }
  });

  it("a plan made only of review nodes keeps one node (stays valid)", () => {
    const result = validatePlan(
      {
        goal: "g",
        subtasks: [
          { key: "review", title: "r", description: "d", kind: "review", capability: "code-review", dependencies: [], order: 0 },
        ],
      },
      8,
      { taskKind: "research" }
    );
    expect(result.ok).toBe(true);
    expect(result.plan!.subtasks).toHaveLength(1);
  });

  it("malformed plans are still rejected", () => {
    expect(validatePlan({ goal: "g", subtasks: [] }, 8, { taskKind: "research" }).ok).toBe(false);
    expect(validatePlan(null, 8, { taskKind: "research" }).ok).toBe(false);
  });
});

describe("planner prompt and research instruction", () => {
  it("tells the planner a research task is read-only", () => {
    const prompt = buildPlanningPrompt({
      command: "riset kenapa dashboard lambat, jangan ubah kode",
      classification: researchClassification,
      agents: [],
      policy: POLICY,
    });
    expect(prompt).toMatch(/READ-ONLY TASK/);
    expect(prompt).toMatch(/NEVER emit code_change/);
    expect(prompt).toMatch(/Suggested follow-up tasks/);
  });

  it("a code-change task gets no read-only block", () => {
    const prompt = buildPlanningPrompt({
      command: "add a logout button",
      classification: { kind: "code_change", strategy: "single", reasons: [], suggestedCapabilities: [] },
      agents: [],
      policy: POLICY,
    });
    expect(prompt).not.toMatch(/READ-ONLY TASK/);
  });

  it("research answers may end with suggested follow-up tasks, never started", () => {
    const instruction = readOnlyInstruction("research");
    expect(instruction).toMatch(/Suggested follow-up tasks/);
    expect(instruction).toMatch(/do not start them/);
  });
});

describe("delegation: a research task never starts a code follow-up", () => {
  const researcher: AgentDefinition = { _id: "r1", name: "Researcher", role: "researcher", capabilities: ["research"] };
  const developer: AgentDefinition = {
    _id: "dev1",
    name: "Developer",
    role: "developer",
    capabilities: ["frontend-development", "backend-development"],
  };
  const agents = [researcher, developer];
  const evaluate = (result: unknown) =>
    evaluateDelegation({
      result: result as never,
      classification: researchClassification,
      agents,
      budget: new BudgetTracker(POLICY),
      previousAgents: [],
      delegationDepth: 0,
      alreadyDelegatedCapabilities: [],
    });

  it("rejects a code delegation recommendation", () => {
    const evaluation = evaluate({
      agentName: "Researcher",
      capability: "research",
      success: true,
      summary: "found it",
      delegationRecommendation: { targetCapability: "frontend-development", reason: "memoize chart" },
    });
    expect(evaluation.decision).toBe("REJECT");
    expect(evaluation.reason).toMatch(/suggestion, not started/);
  });

  it("does not send critical findings to an implementer", () => {
    const evaluation = evaluate({
      agentName: "Researcher",
      capability: "research",
      success: true,
      summary: "found it",
      findings: [{ severity: "high", description: "N+1 query" }],
    });
    expect(evaluation.decision).toBe("REJECT");
  });

  it("completes without a recommendation", () => {
    const evaluation = evaluate({ agentName: "Researcher", capability: "research", success: true, summary: "ok" });
    expect(evaluation.decision).toBe("COMPLETE");
  });
});

// e2e S4: the evaluator replanned with "objective unmet" (React scaffold
// incomplete) although all 4 requirements were covered.
describe("objective: no scaffold requirement the task did not ask for", () => {
  it("mentioning React is not a scaffold request", () => {
    expect(
      requiresScaffold({
        goal: "Add a React pricing card component with a toggle",
        requirements: [
          { text: "pricing card component" },
          { text: "monthly/yearly toggle" },
          { text: "highlight the recommended tier" },
          { text: "README section" },
        ],
      })
    ).toBe(false);
    expect(requiresScaffold({ goal: "Tambahkan tombol di halaman React dashboard" })).toBe(false);
  });

  it("an explicit migration or new app still requires the scaffold", () => {
    expect(requiresScaffold({ goal: "x", requirements: [{ text: "Migrate the static site to React with Vite" }] })).toBe(true);
    expect(requiresScaffold({ goal: "Create a new React app for the landing page" })).toBe(true);
    expect(requiresScaffold({ goal: "Scaffold a Next.js project" })).toBe(true);
  });
});
