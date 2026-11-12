/**
 * P2: the system-built cross-role summary in the final report
 * (services/runner/reportSummary.ts), and the finalize message that carries it.
 */
import { describe, expect, it } from "vitest";
import {
  buildQaLine,
  buildReportSummary,
  buildReviewLine,
  buildRoleLines,
  buildUnfinishedLine,
  MAX_ROLE_LINES,
  type ReportSummaryInput,
} from "@/services/runner/reportSummary";
import { finalize } from "@/services/runner/finalize";
import { ROLES } from "@/api/convex/lib/roles";
import type { AgentDefinition, ExecutionPlan, PlanSubtask } from "@/types";

const agent = (role: string, capabilities: string[]): AgentDefinition => ({
  _id: `agent-${role}`,
  name: `@${ROLES[role as keyof typeof ROLES]?.label ?? role}Bot`,
  role,
  capabilities,
  isEnabled: true,
  priority: 5,
});

const TEAM: AgentDefinition[] = [
  agent("cto", ["architecture"]),
  agent("designer", ["ui-ux-design"]),
  agent("frontend", ["frontend-development"]),
  agent("backend", ["backend-development"]),
  agent("qa", ["browser-testing"]),
  agent("support", ["documentation-support"]),
  agent("devops", ["github", "shell-execution"]),
  agent("reviewer", ["code-review"]),
  agent("researcher", ["research"]),
];

const node = (key: string, kind: PlanSubtask["kind"], capability: string): PlanSubtask => ({
  key,
  title: key,
  description: key,
  kind,
  capability,
  dependencies: [],
  order: 0,
});

const plan = (subtasks: PlanSubtask[]): ExecutionPlan =>
  ({ version: 1, maxConcurrency: 1, goal: "g", strategy: "dag", requiresApproval: false, subtasks: subtasks.map((s, i) => ({ ...s, order: i })) }) as ExecutionPlan;

const state = (over: Partial<ReportSummaryInput["state"]> = {}): ReportSummaryInput["state"] => ({
  qaVerdicts: {},
  qaChecks: {},
  reviewVerdicts: {},
  fileChanges: new Map(),
  appliedFilesBySubtask: new Map(),
  ...over,
});

describe("reportSummary: one line per role", () => {
  it("code task: per-role subtasks, files changed and fixes, built from rows and applied changes", () => {
    const p = plan([
      node("ui", "code_change", "frontend-development"),
      node("api", "code_change", "backend-development"),
      node("review", "review", "code-review"),
      node("qa", "qa", "browser-testing"),
    ]);
    const lines = buildRoleLines({
      plan: p,
      agents: TEAM,
      subtasks: [
        { key: "ui", kind: "code_change", status: "completed" },
        { key: "ui-fix", kind: "code_change", status: "completed", origin: "review_fix", capability: "frontend-development" },
        { key: "api", kind: "code_change", status: "completed" },
        { key: "review", kind: "review", status: "completed" },
        { key: "qa", kind: "qa", status: "completed" },
      ],
      state: state({ appliedFilesBySubtask: new Map([["api", ["server/routes.ts"]]]) }),
      changes: [
        { filePath: "web/index.html", subtaskKey: "ui", appliedAt: 1 },
        { filePath: "web/app.css", subtaskKey: "ui-fix", appliedAt: 2 },
        { filePath: "web/a.ts", subtaskKey: "ui", appliedAt: 3 },
        { filePath: "web/b.ts", subtaskKey: "ui", appliedAt: 4 },
        { filePath: "web/never-applied.ts", subtaskKey: "ui" },
      ],
    });
    expect(lines).toEqual([
      "Frontend: 2 subtasks done, incl. 1 fix, 4 files changed (index.html, app.css, a.ts, +1 more).",
      "Backend: 1 subtask done, 1 file changed (routes.ts).",
    ]);
  });

  it("uses the assigned agent's role over the capability, and never @mentions", () => {
    const lines = buildRoleLines({
      plan: plan([node("x", "analysis", "frontend-development")]),
      agents: TEAM,
      subtasks: [{ key: "x", kind: "analysis", status: "completed", assignedAgentId: "agent-backend" }],
      state: state(),
    });
    expect(lines).toEqual(["Backend: 1 subtask done."]);
    expect(lines.join(" ")).not.toContain("@");
  });

  it("docs task is reported by Support; research by the Researcher", () => {
    expect(
      buildRoleLines({
        plan: plan([node("doc", "code_change", "documentation-support")]),
        agents: TEAM,
        subtasks: [{ key: "doc", kind: "code_change", status: "completed" }],
        state: state({ appliedFilesBySubtask: new Map([["doc", ["README.md"]]]) }),
      })
    ).toEqual(["Support: 1 subtask done, 1 file changed (README.md)."]);
    expect(
      buildRoleLines({
        plan: plan([node("a", "research", "research"), node("b", "research", "research")]),
        agents: TEAM,
        subtasks: [
          { key: "a", kind: "research", status: "completed" },
          { key: "b", kind: "research", status: "failed" },
        ],
        state: state(),
      })
    ).toEqual(["Researcher: 1 of 2 subtasks done."]);
  });

  it("caps the role lines and names the rest", () => {
    const caps = ["frontend-development", "backend-development", "documentation-support", "research", "ui-ux-design"];
    const nodes = caps.map((c, i) => node(`n${i}`, "analysis", c));
    const lines = buildRoleLines({
      plan: plan(nodes),
      agents: TEAM,
      subtasks: nodes.map((n) => ({ key: n.key, kind: n.kind, status: "completed" })),
      state: state(),
    });
    expect(lines).toHaveLength(MAX_ROLE_LINES);
    expect(lines[MAX_ROLE_LINES - 1]).toBe("Also worked: Support, Researcher, Designer.");
  });
});

describe("reportSummary: review, QA and unfinished evidence", () => {
  it("review verdict: approved with files, or changes requested with the findings count", () => {
    expect(buildReviewLine(state())).toBe("");
    expect(
      buildReviewLine(state({ reviewVerdicts: { r: { verdict: "approved", findings: [] } }, fileChanges: new Map([["a", {} as any]]) }))
    ).toBe("Review: approved (1 file reviewed, no blocking findings).");
    const finding = { severity: "high", filePath: "a", description: "d", suggestion: "s" } as const;
    expect(buildReviewLine(state({ reviewVerdicts: { r: { verdict: "changes_requested", findings: [finding, finding] } } }))).toBe(
      "Review: changes requested (2 findings)."
    );
  });

  it("QA: passed lists what was tested; failed and inconclusive name the checks; blocked gives the reason", () => {
    const checks = [
      { label: "page-loads", status: "passed" },
      { label: "no-console-errors", status: "failed" },
    ];
    expect(buildQaLine(state({ qaVerdicts: { qa: "passed" }, qaChecks: { qa: [{ label: "page-loads", status: "passed" }] } })).line).toBe(
      "QA: structural browser checks passed. Tested 1 check: page-loads."
    );
    expect(buildQaLine(state({ qaVerdicts: { qa: "passed" } })).line).toBe("QA: structural browser checks passed.");
    expect(buildQaLine(state({ qaVerdicts: { qa: "failed" }, qaChecks: { qa: checks } })).line).toBe("QA: failed (no-console-errors).");
    expect(
      buildQaLine(state({ qaVerdicts: { qa: "inconclusive" }, qaChecks: { qa: [{ label: "nav", status: "inconclusive" }] } })).line
    ).toBe("QA: inconclusive (nav).");
    const blocked = buildQaLine(
      state({ qaVerdicts: { qa: "blocked" }, qaChecks: { qa: [{ label: "qa-environment", status: "failed", details: "No Chromium" }] } })
    );
    expect(blocked).toEqual({ line: "QA blocked — No Chromium. Browser checks did not run.", blocked: true, blockedDetail: "No Chromium" });
  });

  it("unfinished: failed/blocked/skipped nodes with their reason, declined commands left out, capped", () => {
    expect(
      buildUnfinishedLine([
        { key: "a", kind: "shell", status: "skipped", error: "Declined by user: npm test" },
        { key: "b", kind: "analysis", status: "completed" },
      ])
    ).toBe("");
    const line = buildUnfinishedLine([
      { key: "deploy", title: "Deploy preview", kind: "shell", status: "blocked", error: "needs approval\nmore" },
      { key: "x", kind: "research", status: "failed", error: "timeout" },
      { key: "y", kind: "research", status: "skipped" },
      { key: "z", kind: "research", status: "failed" },
    ]);
    expect(line).toBe("Not finished: Deploy preview (blocked: needs approval); x (failed: timeout); y (skipped); +1 more.");
  });

  it("buildReportSummary bundles every part", () => {
    const summary = buildReportSummary({
      plan: plan([node("ui", "analysis", "frontend-development")]),
      agents: TEAM,
      subtasks: [{ key: "ui", kind: "analysis", status: "completed" }],
      state: state({ qaVerdicts: { qa: "passed" } }),
    });
    expect(summary).toMatchObject({ roleLines: ["Frontend: 1 subtask done."], qaLine: "QA: structural browser checks passed.", qaBlocked: false });
  });
});

describe("finalize: the report carries the cross-role summary", () => {
  it("posts one message under the Response Owner with the role lines and evidence", async () => {
    const messages: Array<{ content: string; agentId?: string }> = [];
    const events: Array<{ type: string; payload?: unknown }> = [];
    const deps = {
      policy: { verificationEnabled: false },
      api: {
        getApprovals: async () => [],
        getFileChanges: async () => [],
        recordEvaluation: async () => undefined,
        logEvent: async (e: { type: string; payload?: unknown }) => void events.push(e),
        appendAgentMessage: async (m: { content: string; agentId?: string }) => void messages.push(m),
        completeTask: async () => undefined,
      },
    };
    await finalize({
      deps: deps as any,
      task: { _id: "t1" } as any,
      project: { _id: "p1" } as any,
      workspacePath: "/tmp",
      plan: plan([
        node("ui", "analysis", "frontend-development"),
        node("notes", "analysis", "documentation-support"),
        node("qa", "qa", "browser-testing"),
      ]),
      planVersion: 1,
      agents: TEAM,
      subtasks: [
        { key: "ui", kind: "analysis", status: "completed" },
        { key: "notes", kind: "analysis", status: "completed" },
        { key: "qa", kind: "qa", status: "completed" },
      ] as any,
      state: {
        ...state({
          qaVerdicts: { qa: "passed" },
          qaChecks: { qa: [{ label: "page-loads", status: "passed" }] },
          appliedFilesBySubtask: new Map([["ui", ["index.html"]]]),
        }),
        priorOutputs: new Map(),
        feedback: [],
      } as any,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].agentId).toBe("agent-frontend");
    expect(messages[0].content).toBe(
      [
        "Done.",
        "Frontend: 1 subtask done, 1 file changed (index.html).\nSupport: 1 subtask done.",
        "QA: structural browser checks passed. Tested 1 check: page-loads.",
        "Verification: passed.",
      ].join("\n\n")
    );
    expect(messages[0].content).not.toContain("@");
    expect(events.find((e) => e.type === "task.summary")?.payload).toEqual({
      roles: ["Frontend: 1 subtask done, 1 file changed (index.html).", "Support: 1 subtask done."],
      qa: "QA: structural browser checks passed. Tested 1 check: page-loads.",
    });
  });

  it("a declined-only run says Not run and lists no role lines", async () => {
    const messages: Array<{ content: string }> = [];
    const deps = {
      policy: { verificationEnabled: false },
      api: {
        getApprovals: async () => [],
        getFileChanges: async () => [],
        recordEvaluation: async () => undefined,
        logEvent: async () => undefined,
        appendAgentMessage: async (m: { content: string }) => void messages.push(m),
        completeTask: async () => undefined,
      },
    };
    await finalize({
      deps: deps as any,
      task: { _id: "t1" } as any,
      project: { _id: "p1" } as any,
      workspacePath: "/tmp",
      plan: plan([node("run", "shell", "backend-development")]),
      planVersion: 1,
      agents: TEAM,
      subtasks: [{ key: "run", kind: "shell", status: "skipped", error: "Declined by user: `rm -rf dist`" }] as any,
      state: { ...state({}), priorOutputs: new Map(), feedback: [] } as any,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].content.startsWith("Not run.")).toBe(true);
    expect(messages[0].content).not.toMatch(/Backend:|Not finished:/);
  });
});
