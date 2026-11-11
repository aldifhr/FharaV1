/**
 * Orchestrator/CTO split O2: the Response Owner (the plan's primary role,
 * chosen deterministically), code-only QA/Reviewer gates, the final report
 * posted as the Response Owner, and Support's docs-only write scope.
 */
import { describe, expect, it } from "vitest";
import {
  changesCode,
  finishPlanOwnership,
  pickResponseOwner,
  responseOwnerAgent,
  stripNonCodeGates,
} from "@/orchestrator/responseOwner";
import { finalize, persistPlan } from "@/services/runner/finalize";
import { planSystemLine } from "@/services/runner/systemLines";
import { canWritePath, ROLES } from "@/api/convex/lib/roles";
import { writeDenial } from "@/utils/rolePolicy";
import { tool_call } from "@/governance/registry";
import type { AgentDefinition, ExecutionPlan, PlanSubtask } from "@/types";

const agent = (role: string, capabilities: string[], priority = 5): AgentDefinition => ({
  _id: `agent-${role}`,
  name: ROLES[role as keyof typeof ROLES]?.label ?? role,
  role,
  capabilities,
  isEnabled: true,
  priority,
});

const TEAM: AgentDefinition[] = [
  agent("cto", ["architecture"], 9),
  agent("designer", ["ui-ux-design"]),
  agent("frontend", ["frontend-development"]),
  agent("backend", ["backend-development"]),
  agent("qa", ["browser-testing"]),
  agent("support", ["documentation-support"]),
  agent("devops", ["github", "shell-execution"]),
  agent("reviewer", ["code-review", "security-audit"]),
  agent("researcher", ["research"]),
];

let order = 0;
const node = (key: string, kind: PlanSubtask["kind"], capability: string, extra: Partial<PlanSubtask> = {}): PlanSubtask => ({
  key,
  title: key,
  description: key,
  kind,
  capability,
  dependencies: [],
  order: order++,
  ...extra,
});

const plan = (subtasks: PlanSubtask[]): ExecutionPlan => ({
  version: 1,
  goal: "g",
  strategy: "dag",
  requiresApproval: false,
  maxConcurrency: 2,
  subtasks,
});

describe("Response Owner rule", () => {
  it("code plan: the implementing role (code_change counts double)", () => {
    const p = plan([
      node("design", "analysis", "ui-ux-design"),
      node("build", "code_change", "frontend-development", { dependencies: ["design"] }),
      node("review", "review", "code-review", { dependencies: ["build"] }),
      node("qa", "qa", "browser-testing", { dependencies: ["build"] }),
    ]);
    expect(pickResponseOwner(p, TEAM)).toBe("frontend");
  });

  it("backend + frontend code: the role with more code nodes, ties to the earliest", () => {
    expect(
      pickResponseOwner(plan([node("api", "code_change", "backend-development"), node("ui", "code_change", "frontend-development")]), TEAM)
    ).toBe("backend");
    expect(
      pickResponseOwner(
        plan([
          node("ui", "code_change", "frontend-development"),
          node("api", "code_change", "backend-development"),
          node("api2", "code_change", "backend-development"),
        ]),
        TEAM
      )
    ).toBe("backend");
  });

  it("bug fix: the implementing role reports, not QA (QA evidence goes in the report)", () => {
    const p = plan([
      node("investigate", "qa", "browser-testing"),
      node("fix", "code_change", "frontend-development", { dependencies: ["investigate"] }),
      node("retest", "qa", "browser-testing", { dependencies: ["fix"] }),
    ]);
    expect(pickResponseOwner(p, TEAM)).toBe("frontend");
  });

  it("docs plan: Support", () => {
    const p = plan([node("readme", "code_change", "documentation-support", { allowedPaths: ["README.md"] })]);
    expect(pickResponseOwner(p, TEAM)).toBe("support");
  });

  it("research plan: Researcher", () => {
    const p = plan([node("a1", "research", "research"), node("a2", "research", "research"), node("synth", "analysis", "research")]);
    expect(pickResponseOwner(p, TEAM)).toBe("researcher");
  });

  it("gate-only plan ('Review PR #12'): the gate's role", () => {
    expect(pickResponseOwner(plan([node("review", "review", "code-review")]), TEAM)).toBe("reviewer");
  });

  it("the CTO decision node is a gate: the CTO is never the RO of a flagged code plan", () => {
    const p = plan([
      node("arch-decision", "analysis", "architecture"),
      node("schema", "code_change", "backend-development", { dependencies: ["arch-decision"] }),
    ]);
    expect(pickResponseOwner(p, TEAM)).toBe("backend");
  });

  it("works without a roster (fixed-team defaults)", () => {
    expect(pickResponseOwner(plan([node("ui", "code_change", "frontend-development")]))).toBe("frontend");
    expect(pickResponseOwner(plan([]))).toBeNull();
  });

  it("responseOwnerAgent picks the enabled agent of that role", () => {
    expect(responseOwnerAgent("frontend", TEAM)?._id).toBe("agent-frontend");
    expect(responseOwnerAgent("frontend", [{ ...TEAM[2], isEnabled: false }])).toBeUndefined();
    expect(responseOwnerAgent(null, TEAM)).toBeUndefined();
  });
});

describe("QA and Reviewer only for code changes", () => {
  it("docs-only plan: review/qa dropped, plan flagged, note added", () => {
    const notes: string[] = [];
    const p = finishPlanOwnership(
      plan([
        node("readme", "code_change", "documentation-support", { allowedPaths: ["README.md", "docs/setup.md"] }),
        node("review", "review", "code-review", { dependencies: ["readme"] }),
        node("qa", "qa", "browser-testing", { dependencies: ["readme"] }),
      ]),
      TEAM,
      notes
    );
    expect(p.subtasks.map((s) => s.key)).toEqual(["readme"]);
    expect(p.gatesSkipped).toBe(true);
    expect(p.responseOwner).toBe("support");
    expect(notes.join(" ")).toContain("QA and review skipped: no code changes");
    expect(planSystemLine(p, 1)).toBe("Planned 1 subtask · QA and review skipped: no code changes");
  });

  it("research plan: review/qa dropped and dependencies rewired", () => {
    const { plan: p, dropped } = stripNonCodeGates(
      plan([
        node("research", "research", "research"),
        node("review", "review", "code-review", { dependencies: ["research"] }),
        node("summary", "analysis", "research", { dependencies: ["research", "review"] }),
      ])
    );
    expect(dropped).toEqual(["review"]);
    expect(p.subtasks.find((s) => s.key === "summary")?.dependencies).toEqual(["research"]);
  });

  it("code plan: review/qa kept", () => {
    const p = finishPlanOwnership(
      plan([
        node("build", "code_change", "frontend-development", { allowedPaths: ["src/App.tsx"] }),
        node("review", "review", "code-review", { dependencies: ["build"] }),
        node("qa", "qa", "browser-testing", { dependencies: ["build"] }),
      ]),
      TEAM
    );
    expect(p.subtasks.map((s) => s.kind)).toEqual(["code_change", "review", "qa"]);
    expect(p.gatesSkipped).toBeUndefined();
    expect(p.responseOwner).toBe("frontend");
  });

  it("gate-only plans keep their gate", () => {
    expect(stripNonCodeGates(plan([node("review", "review", "code-review")])).dropped).toEqual([]);
  });

  it("a code_change scoped to Markdown/docs is a docs change; source paths are code", () => {
    expect(changesCode(node("a", "code_change", "frontend-development", { allowedPaths: ["README.md", "docs/a.md"] }))).toBe(false);
    expect(changesCode(node("b", "code_change", "frontend-development", { allowedPaths: ["src/a.ts"] }))).toBe(true);
    expect(changesCode(node("c", "code_change", "frontend-development"))).toBe(true);
    expect(changesCode(node("d", "code_change", "documentation-support"))).toBe(false);
  });
});

function finalizeDeps(messages: Array<{ content: string; agentId?: string }>) {
  return {
    policy: { verificationEnabled: false },
    api: {
      getApprovals: async () => [],
      getFileChanges: async () => [],
      recordEvaluation: async () => undefined,
      logEvent: async () => undefined,
      appendAgentMessage: async (m: { content: string; agentId?: string }) => void messages.push(m),
      completeTask: async () => undefined,
    },
  };
}

const emptyState = () =>
  ({ qaVerdicts: {}, reviewVerdicts: {}, fileChanges: new Map(), priorOutputs: new Map(), appliedFilesBySubtask: new Map(), feedback: [] }) as any;

describe("final report author = Response Owner", () => {
  it("a frontend plan is reported by Frontend, not the CTO, with the QA evidence inside", async () => {
    const messages: Array<{ content: string; agentId?: string }> = [];
    const p = plan([node("build", "analysis", "frontend-development"), node("qa", "qa", "browser-testing")]);
    await finalize({
      deps: finalizeDeps(messages) as any,
      task: { _id: "t1" } as any,
      project: { _id: "p1" } as any,
      workspacePath: "/tmp",
      plan: p,
      planVersion: 1,
      agents: TEAM,
      subtasks: [
        { key: "build", kind: "analysis", status: "completed" },
        { key: "qa", kind: "qa", status: "completed" },
      ] as any,
      state: { ...emptyState(), qaVerdicts: { qa: "passed" } },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].agentId).toBe("agent-frontend");
    expect(messages[0].content).toContain("QA: structural browser checks passed.");
  });

  it("a research plan is reported by the Researcher", async () => {
    const messages: Array<{ content: string; agentId?: string }> = [];
    await finalize({
      deps: finalizeDeps(messages) as any,
      task: { _id: "t1" } as any,
      project: { _id: "p1" } as any,
      workspacePath: "/tmp",
      plan: plan([node("r", "research", "research")]),
      planVersion: 1,
      agents: TEAM,
      subtasks: [{ key: "r", kind: "research", status: "completed" }] as any,
      state: emptyState(),
    });
    expect(messages[0].agentId).toBe("agent-researcher");
  });

  it("persistPlan stores the Response Owner on the task and posts the plan System line", async () => {
    const calls: Record<string, any[]> = { setPlanning: [], savePlan: [], appendSystemLine: [] };
    const api = new Proxy({}, { get: (_t, key: string) => async (input: unknown) => void (calls[key] ??= []).push(input) });
    await persistPlan({ api } as any, {
      taskId: "t1",
      projectId: "p1",
      plan: plan([node("api", "code_change", "backend-development")]),
      version: 1,
      createdBy: "orchestrator",
      classification: "code_change",
      agents: TEAM,
    });
    expect(calls.setPlanning[0]).toMatchObject({ responseOwner: "backend" });
    expect(calls.savePlan[0].payload.responseOwner).toBe("backend");
    expect(calls.appendSystemLine[0]).toEqual({ taskId: "t1", projectId: "p1", content: "Planned 1 subtask" });
  });
});

describe("Support writes Markdown and docs/** only", () => {
  const support = ROLES.support.permissions;
  it("README.md, nested Markdown and docs/x.md are allowed; src/ is not", () => {
    for (const ok of ["README.md", "CHANGELOG.md", "apps/web/README.md", "docs/x.md", "docs/guide/setup.md"]) {
      expect(canWritePath(support, ok), ok).toBe(true);
    }
    for (const no of ["src/index.ts", "src/README.ts", "package.json", "apps/api/convex/schema.ts", "docs/../src/a.ts"]) {
      expect(canWritePath(support, no), no).toBe(false);
    }
    expect(writeDenial("support", support, "src/index.ts")).toMatch(/may only write/);
    expect(writeDenial("support", support, "README.md")).toBeNull();
  });

  it("the governance broker refuses Support writes outside docs", async () => {
    const ctx = { workspacePath: "/tmp/none", agentRole: "support", audit: async () => undefined } as never;
    const denied = await tool_call({ ctx, supportedTools: ["write_file"], name: "write_file", args: { path: "src/a.ts", content: "x" } });
    expect(denied.ok).toBe(false);
    expect((denied as { reason?: string }).reason ?? "").toMatch(/path-not-allowed-for-role/);
  });
});
