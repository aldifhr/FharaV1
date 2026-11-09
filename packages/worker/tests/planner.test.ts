import { describe, expect, it } from "vitest";
import { classifyCommand } from "@/orchestrator/classifier";
import { buildPlanningPrompt, createPlan, ensureRequiredSubtasks, heuristicPlan, wantsVisualQa } from "@/orchestrator/planner";
import type { AgentDefinition, ExecutionPlan } from "@/orchestrator/types";
import { loadPolicy } from "@/orchestrator/policy";

const policy = loadPolicy();

const frontend: AgentDefinition = {
  _id: "f",
  name: "Frontend",
  role: "frontend",
  capabilities: ["frontend-development"],
};
const backend: AgentDefinition = {
  _id: "b",
  name: "Backend",
  role: "backend",
  capabilities: ["backend-development"],
};
const reviewer: AgentDefinition = {
  _id: "r",
  name: "Reviewer",
  role: "cto",
  capabilities: ["code-review", "architecture"],
};
const qa: AgentDefinition = {
  _id: "q",
  name: "QA",
  role: "qa",
  capabilities: ["browser-testing"],
};

describe("planner", () => {
  it("falls back to a deterministic plan when no LLM planner is available", async () => {
    const command = "fix the login button";
    const result = await createPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer],
      policy,
    });
    expect(result.createdBy).toBe("fallback");
    expect(result.plan.subtasks.map((subtask) => subtask.kind)).toContain("code_change");
    expect(result.plan.requiresApproval).toBe(true);
  });

  it("adds a QA subtask only when a QA signal fires and a capable agent exists", () => {
    const autoPolicy = { ...policy, qaMode: "auto" as const };
    // Tightened auto: a backend-only change with only a configured QA URL
    // (no UI work, no browser-QA request) gets no QA node.
    const backendCommand = "update the billing api endpoint";
    const withoutQa = heuristicPlan({
      command: backendCommand,
      classification: classifyCommand(backendCommand),
      agents: [backend, reviewer, qa],
      policy: autoPolicy,
      hasQaUrl: true,
    });
    expect(withoutQa.subtasks.some((subtask) => subtask.kind === "qa")).toBe(false);

    // A UI change warrants browser QA.
    const command = "update the dashboard page";
    const withQa = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer, qa],
      policy: autoPolicy,
    });
    expect(withQa.subtasks.some((subtask) => subtask.kind === "qa")).toBe(true);

    const noAgent = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer],
      policy: autoPolicy,
      hasQaUrl: true,
    });
    expect(noAgent.subtasks.some((subtask) => subtask.kind === "qa")).toBe(false);
    expect(withoutQa.requiresApproval).toBe(true);
  });

  it("reviewMode/qaMode 'always' restore the legacy mandate", () => {
    const command = "update the dashboard page";
    const plan = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer, qa],
      policy: { ...policy, reviewMode: "always", qaMode: "always" },
    });
    expect(plan.subtasks.some((subtask) => subtask.kind === "review")).toBe(true);
    expect(plan.subtasks.some((subtask) => subtask.kind === "qa")).toBe(true);
  });

  it("reviewMode/qaMode 'never' add neither hint even on a risk signal", () => {
    const command = "add oauth login";
    const plan = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer, qa],
      policy: { ...policy, reviewMode: "never", qaMode: "never" },
      hasQaUrl: true,
    });
    expect(plan.subtasks.some((subtask) => subtask.kind === "review")).toBe(false);
    expect(plan.subtasks.some((subtask) => subtask.kind === "qa")).toBe(false);
  });

  it("risk signal (auth) adds review and qa to an auto plan", () => {
    const command = "add oauth login";
    const plan = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer, qa],
      policy: { ...policy, qaMode: "auto" as const },
    });
    expect(plan.subtasks.some((subtask) => subtask.kind === "review")).toBe(true);
    expect(plan.subtasks.some((subtask) => subtask.kind === "qa")).toBe(true);
  });

  it("adds review and qa to an LLM plan that omits them for code changes (legacy mandate)", () => {
    const plan: ExecutionPlan = {
      version: 1,
      goal: "create flow.txt",
      strategy: "single",
      requiresApproval: true,
      maxConcurrency: 2,
      subtasks: [
        {
          key: "implement",
          title: "Implement",
          description: "create flow.txt",
          kind: "code_change",
          capability: "frontend-development",
          dependencies: [],
          order: 0,
        },
      ],
    };
    const enforced = ensureRequiredSubtasks(plan, [frontend, reviewer, qa]);
    const review = enforced.subtasks.find((subtask) => subtask.kind === "review");
    const qaTask = enforced.subtasks.find((subtask) => subtask.kind === "qa");
    expect(review?.dependencies).toEqual(["implement"]);
    expect(qaTask?.dependencies).toEqual([review?.key]);
    expect(enforced.strategy).toBe("dag");
  });

  it("does not duplicate review or qa when the plan already has them", () => {
    const plan: ExecutionPlan = {
      version: 1,
      goal: "create flow.txt",
      strategy: "dag",
      requiresApproval: true,
      maxConcurrency: 2,
      subtasks: [
        {
          key: "implement",
          title: "Implement",
          description: "create flow.txt",
          kind: "code_change",
          capability: "frontend-development",
          dependencies: [],
          order: 0,
        },
        {
          key: "review",
          title: "Review",
          description: "review",
          kind: "review",
          capability: "code-review",
          dependencies: ["implement"],
          order: 1,
        },
        {
          key: "qa",
          title: "QA",
          description: "qa",
          kind: "qa",
          capability: "browser-testing",
          dependencies: ["review"],
          order: 2,
        },
      ],
    };
    const enforced = ensureRequiredSubtasks(plan, [frontend, reviewer, qa]);
    expect(enforced.subtasks).toHaveLength(3);
  });

  it("does not add qa when no browser-testing agent exists", () => {
    const plan: ExecutionPlan = {
      version: 1,
      goal: "create flow.txt",
      strategy: "single",
      requiresApproval: true,
      maxConcurrency: 2,
      subtasks: [
        {
          key: "implement",
          title: "Implement",
          description: "create flow.txt",
          kind: "code_change",
          capability: "frontend-development",
          dependencies: [],
          order: 0,
        },
      ],
    };
    const enforced = ensureRequiredSubtasks(plan, [frontend]);
    expect(enforced.subtasks.some((subtask) => subtask.kind === "review")).toBe(true);
    expect(enforced.subtasks.some((subtask) => subtask.kind === "qa")).toBe(false);
  });

  it("single-domain change with no risk signal stays direct with one node", () => {
    // Backend work: the default qaMode=auto adds browser QA only for UI work.
    const command = "fix the api endpoint validation";
    const plan = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [backend, reviewer, qa],
      policy,
    });
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0].kind).toBe("code_change");
    expect(plan.strategy).toBe("direct");
  });

  it("plans parallel frontend and backend work for multi-domain requests", () => {
    const command =
      "add a new settings page in the frontend and a settings API endpoint in the backend";
    const plan = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, backend, reviewer],
      policy,
    });
    const implementFront = plan.subtasks.find((subtask) => subtask.key === "implement_frontend");
    const implementBack = plan.subtasks.find((subtask) => subtask.key === "implement_backend");
    expect(implementFront?.dependencies).toEqual([]);
    expect(implementBack?.dependencies).toEqual([]);
    const review = plan.subtasks.find((subtask) => subtask.key === "review");
    expect(review?.dependencies).toEqual(["implement_frontend", "implement_backend"]);
  });

  it("does not require approval for read-only work", () => {
    const command = "audit the authentication module";
    const plan = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [reviewer],
      policy,
    });
    expect(plan.requiresApproval).toBe(false);
  });
});

describe("wantsVisualQa", () => {
  it("is false when the request prohibits screenshots, baselines and viewports", () => {
    const command = [
      "Create structure-check-abc.html with a heading and a paragraph.",
      "Ask @QA to validate only the HTML structure, browser reachability,",
      "console errors and network errors.",
      "Do not take screenshots, do not compare baselines or pixels,",
      "and do not test responsive or desktop/tablet/mobile viewports.",
    ].join(" ");
    expect(wantsVisualQa(command)).toBe(false);
  });

  it("is false for an Indonesian prohibition", () => {
    const command =
      "Buat halaman struktur.html. Jangan jalankan screenshot, baseline, atau uji viewport responsive.";
    expect(wantsVisualQa(command)).toBe(false);
  });

  it("is true when visual regression is explicitly requested", () => {
    expect(wantsVisualQa("Run a visual regression check with screenshots of every viewport")).toBe(
      true
    );
  });

  it("records the structural-only intent on the plan and the QA node text", () => {
    const command = [
      "Create structure-check-abc.html.",
      "Ask @QA to validate only HTML structure and browser reachability.",
      "Do not take screenshots or test viewports.",
    ].join(" ");
    const plan = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer, qa],
      policy: { ...policy, qaMode: "auto" as const },
      hasQaUrl: true,
    });
    const qaTask = plan.subtasks.find((subtask) => subtask.kind === "qa");
    expect(qaTask).toBeDefined();
    expect(plan.visualQa).toBe(false);
    expect(qaTask?.title).toBe("Validate HTML and browser reachability");
    expect(qaTask?.description.toLowerCase()).not.toContain("screenshot");
  });
});

// Plan 013 step 6: the planner prompt follows reviewMode/qaMode.
describe("planner prompt modes (plan 013 step 6)", () => {
  const promptWith = (overrides: Partial<ReturnType<typeof loadPolicy>>) => {
    const command = "Build the marketing page";
    return buildPlanningPrompt({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer, qa],
      policy: { ...policy, ...overrides },
    });
  };

  it("always mandates review and QA", () => {
    const prompt = promptWith({ reviewMode: "always", qaMode: "always" });
    expect(prompt).toContain("for every code change");
    expect(prompt).toContain("policy reviewMode=always");
    expect(prompt).toContain("policy qaMode=always");
  });

  it("never forbids review and QA", () => {
    const prompt = promptWith({ reviewMode: "never", qaMode: "never" });
    expect(prompt).toContain("policy reviewMode=never");
    expect(prompt).toContain("policy qaMode=never");
    expect(prompt).not.toContain("for every code change");
  });

  it("auto describes the risk/verification signals instead of mandating", () => {
    const prompt = promptWith({});
    expect(prompt).toContain("policy reviewMode=auto");
    expect(prompt).toContain("policy qaMode=auto");
    expect(prompt).not.toContain("for every code change");
  });
});
