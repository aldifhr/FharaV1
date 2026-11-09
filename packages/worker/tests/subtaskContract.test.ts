import { describe, expect, it, vi } from "vitest";
import { validatePlan, validateStoredPlan } from "@/orchestrator/planValidator";
import { withDefaultContracts } from "@/orchestrator/planner";
import {
  acceptanceFromGates,
  defaultGatesForKind,
  evaluateGates,
  routeEscalation,
  type Escalation,
} from "@/api/convex/lib/subtaskContract";
import { applyModelTier, tierForRole } from "@/api/convex/lib/modelTiers";
import { detectEscalation, escalationFromAnswer, isEscalatedError, escalatedError } from "@/execution/escalation";
import { isPermanentSubtaskError } from "@/scheduler/dagScheduler";
import { handleEscalation, seedAllowedEscalations } from "@/services/runner/escalation";
import { TaskLlmResolver, type PoolConnection } from "@/llm/resolver";
import { ProviderHealthRegistry } from "@/llm/health";
import { tool_call } from "@/governance/registry";
import type { ToolContext } from "@/governance/tools";
import type { RunState } from "@/services/runner/types";
import type { ExecutionPlan } from "@/types/plan";

const base = {
  goal: "Add a header",
  strategy: "single",
  requiresApproval: true,
  maxConcurrency: 1,
};

describe("contract parse with back-compat (plan 022)", () => {
  it("an old plan without contract fields still validates and gets gates derived from the kind", () => {
    const result = validatePlan(
      {
        ...base,
        subtasks: [
          { key: "implement", title: "Implement", description: "d", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0 },
          { key: "research", title: "Research", description: "d", kind: "research", capability: "research", dependencies: [], order: 1 },
          { key: "qa", title: "QA", description: "d", kind: "qa", capability: "browser-testing", dependencies: ["implement"], order: 2 },
        ],
      },
      8
    );
    expect(result.ok).toBe(true);
    const [implement, research, qa] = result.plan!.subtasks;
    expect(implement.acceptance?.map((g) => g.check)).toEqual(["typecheck", "test"]);
    expect(research.acceptance?.map((g) => g.target)).toEqual(["output", "output:sources"]);
    expect(qa.acceptance).toEqual([]);
    expect(implement.objective).toBeUndefined();
  });

  it("parses an explicit contract; `scope` is an alias of allowedPaths", () => {
    const result = validatePlan(
      {
        ...base,
        subtasks: [
          {
            key: "implement",
            title: "Implement",
            description: "d",
            kind: "code_change",
            capability: "frontend-development",
            dependencies: [],
            order: 0,
            scope: ["apps/web"],
            objective: "Header renders the project name",
            constraints: ["Do not change the footer"],
            deliverable: "Updated Header.tsx",
            acceptance: [
              { id: "typecheck", criterion: "Typecheck passes", check: "typecheck" },
              { id: "header", criterion: "Header exists", check: "file_exists", target: "apps/web/Header.tsx" },
            ],
          },
        ],
      },
      8
    );
    expect(result.ok).toBe(true);
    const subtask = result.plan!.subtasks[0];
    expect(subtask.allowedPaths).toEqual(["apps/web"]);
    expect(subtask.objective).toBe("Header renders the project name");
    expect(subtask.constraints).toEqual(["Do not change the footer"]);
    expect(subtask.acceptance?.map((g) => g.id)).toEqual(["typecheck", "header"]);
  });

  it("plain-string gates become optional manual gates; a code_change keeps the default verification gates in front", () => {
    const result = validatePlan(
      {
        ...base,
        subtasks: [
          { key: "implement", title: "I", description: "d", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0, acceptance: ["Looks right on mobile"] },
        ],
      },
      8
    );
    expect(result.ok).toBe(true);
    const gates = result.plan!.subtasks[0].acceptance!;
    expect(gates.map((g) => g.check)).toEqual(["typecheck", "test", "manual"]);
    expect(gates[2].required).toBe(false);
  });

  it("rejects unknown checks and a file_exists gate without a target", () => {
    const result = validatePlan(
      {
        ...base,
        subtasks: [
          {
            key: "implement",
            title: "I",
            description: "d",
            kind: "code_change",
            capability: "frontend-development",
            dependencies: [],
            order: 0,
            acceptance: [
              { criterion: "x", check: "vibes" },
              { criterion: "y", check: "file_exists" },
            ],
          },
        ],
      },
      8
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/check must be one of/);
    expect(result.errors.join("\n")).toMatch(/needs a target path/);
  });

  it("a stored plan keeps its contract through validateStoredPlan (resume / recovery)", () => {
    const stored = validateStoredPlan(
      {
        ...base,
        subtasks: [
          { key: "implement", title: "I", description: "d", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0, objective: "O", acceptance: [{ id: "t", criterion: "c", check: "test" }] },
        ],
      },
      1
    );
    expect(stored.plan!.subtasks[0].objective).toBe("O");
    expect(stored.plan!.subtasks[0].acceptance).toEqual([{ id: "t", criterion: "c", check: "test" }]);
  });

  it("withDefaultContracts fills nodes the planner added itself (hints, heuristic plans)", () => {
    const plan = withDefaultContracts({
      version: 1,
      ...base,
      strategy: "dag",
      subtasks: [
        { key: "implement", title: "I", description: "d", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0 },
        { key: "review", title: "R", description: "d", kind: "review", capability: "code-review", dependencies: ["implement"], order: 1 },
      ],
    } as ExecutionPlan);
    expect(plan.subtasks.map((s) => s.acceptance?.map((g) => g.id))).toEqual([["typecheck", "tests"], ["verdict"]]);
  });
});

describe("validator gate rule (plan 022)", () => {
  it("every code subtask needs at least one acceptance gate", () => {
    const result = validatePlan(
      {
        ...base,
        subtasks: [
          { key: "implement", title: "I", description: "d", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0, acceptance: [] },
        ],
      },
      8
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("subtask implement: code_change needs at least one acceptance gate");
  });

  it("non-code subtasks may have none", () => {
    const result = validatePlan(
      {
        ...base,
        subtasks: [{ key: "audit", title: "A", description: "d", kind: "audit", capability: "code-review", dependencies: [], order: 0, acceptance: [] }],
      },
      8
    );
    expect(result.ok).toBe(true);
  });
});

describe("gate evaluation mapping (plan 022)", () => {
  const gates = [
    ...defaultGatesForKind("code_change"),
    { id: "header", criterion: "Header exists", check: "file_exists" as const, target: "src/Header.tsx" },
    { id: "lint", criterion: "Lint passes", check: "command" as const, target: "npm run lint" },
    { id: "review", criterion: "Reviewer approves", check: "review" as const },
    { id: "looks", criterion: "Looks right", check: "manual" as const },
  ];

  it("maps verification checks, the reviewer verdict and the workspace to gates", () => {
    const results = evaluateGates({
      kind: "code_change",
      gates,
      verification: {
        ran: true,
        checks: [
          { name: "root:typecheck", status: "passed" },
          { name: "root:test", status: "failed", details: "1 failing: header.test.ts" },
          { name: "root:lint", status: "passed" },
        ],
      },
      review: { verdict: "approved", reviewKey: "review" },
      fileExists: (target) => target === "src/Header.tsx",
    });
    expect(Object.fromEntries(results.map((r) => [r.gateId, r.status]))).toEqual({
      typecheck: "pass",
      tests: "fail",
      header: "pass",
      lint: "pass",
      review: "pass",
      looks: "skipped",
    });
    expect(results.find((r) => r.gateId === "tests")?.evidence).toEqual({
      kind: "verification",
      ref: "root:test",
      summary: "1 failing: header.test.ts",
    });
    const verdict = acceptanceFromGates(gates, results);
    expect(verdict.status).toBe("rejected");
    expect(verdict.failed).toEqual(["tests"]);
  });

  it("no script / no verification is skipped, not failed: the subtask is accepted", () => {
    const results = evaluateGates({ kind: "code_change", gates: defaultGatesForKind("code_change"), verification: { ran: true, checks: [{ name: "verification", status: "skipped" }] } });
    expect(results.map((r) => r.status)).toEqual(["skipped", "skipped"]);
    expect(acceptanceFromGates(defaultGatesForKind("code_change"), results).status).toBe("accepted");
  });

  it("research: the deliverable must be non-empty and cite sources", () => {
    const gates = defaultGatesForKind("research");
    const cited = evaluateGates({ kind: "research", gates, output: "The lease is renewed in apps/api/convex/orchestration.ts:301." });
    expect(cited.map((r) => r.status)).toEqual(["pass", "pass"]);
    const uncited = evaluateGates({ kind: "research", gates, output: "It is renewed by the heartbeat." });
    expect(uncited.map((r) => r.status)).toEqual(["pass", "fail"]);
    const empty = evaluateGates({ kind: "research", gates, output: "  " });
    expect(acceptanceFromGates(gates, empty).status).toBe("rejected");
  });

  it("a changes_requested review fails the review gate", () => {
    const results = evaluateGates({ kind: "review", gates: defaultGatesForKind("review"), review: { verdict: "changes_requested", reviewKey: "review" } });
    expect(results[0].status).toBe("fail");
  });
});

describe("escalation (plan 022)", () => {
  it("reads an escalation from a JSON answer or a trailing JSON object", () => {
    expect(
      escalationFromAnswer('{"files":[],"escalation":{"kind":"new_dependency","reason":"Needs zod","detail":"zod"}}')
    ).toMatchObject({ kind: "new_dependency", detail: "zod", source: "executor" });
    expect(
      escalationFromAnswer('FILE: a.ts\n````\nconst x = {a: 1};\n````\n{"escalation":{"kind":"ambiguous","reason":"Two readings","options":["A","B"]}}')
    ).toMatchObject({ kind: "ambiguous", options: ["A", "B"] });
    expect(escalationFromAnswer('{"files":[{"filePath":"a","newContent":"escalation"}]}')).toBeNull();
  });

  it("detects a file outside scope, an unlisted schema file and an unnamed new dependency", async () => {
    const subtask = { key: "s", title: "Add header", description: "Add a header", allowedPaths: ["apps/web"] };
    const read = async (path: string) => (path === "apps/web/package.json" ? JSON.stringify({ dependencies: { react: "19" } }) : null);
    expect(
      await detectEscalation({ subtask, files: [{ filePath: "apps/api/x.ts", newContent: "" }], currentContent: read })
    ).toMatchObject({ kind: "out_of_scope", detail: "apps/api/x.ts", source: "detected" });
    expect(
      await detectEscalation({
        subtask: { ...subtask, allowedPaths: ["apps"] },
        files: [{ filePath: "apps/api/convex/schema.ts", newContent: "" }],
        currentContent: read,
      })
    ).toMatchObject({ kind: "schema_change" });
    expect(
      await detectEscalation({
        subtask: { ...subtask, allowedPaths: ["apps/api/convex/schema.ts"] },
        files: [{ filePath: "apps/api/convex/schema.ts", newContent: "" }],
        currentContent: read,
      })
    ).toBeNull();
    const pkg = { filePath: "apps/web/package.json", newContent: JSON.stringify({ dependencies: { react: "19", zod: "3" } }) };
    expect(await detectEscalation({ subtask, files: [pkg], currentContent: read })).toMatchObject({ kind: "new_dependency", detail: "zod" });
    expect(await detectEscalation({ subtask: { ...subtask, description: "Validate input with zod" }, files: [pkg], currentContent: read })).toBeNull();
    expect(await detectEscalation({ subtask, files: [pkg], currentContent: read, allowed: [{ kind: "new_dependency", detail: "zod" }] })).toBeNull();
  });

  it("escalated errors are permanent (never blindly retried)", () => {
    const error = escalatedError({ kind: "security", reason: "Needs a new auth scope" });
    expect(isEscalatedError(error)).toBe(true);
    expect(isPermanentSubtaskError(error)).toBe(true);
  });

  const dep: Escalation = { kind: "new_dependency", reason: "Needs zod", detail: "zod" };
  it("routes: supervised new dependency → ask the user; auto modes → CTO replans with a note", () => {
    expect(routeEscalation(dep, { subtaskKey: "s", permissionMode: "supervised", replansLeft: 2, repeated: false })).toMatchObject({
      route: "ask_user",
      options: ["Allow the dependency", "Do it without a new dependency"],
    });
    const auto = routeEscalation(dep, { subtaskKey: "s", permissionMode: "auto_edits", replansLeft: 2, repeated: false });
    expect(auto.route).toBe("replan");
    if (auto.route === "replan") expect(auto.note).toMatch(/^Escalation from subtask s: New dependency \(zod\)/);
  });

  it("routes: schema / scope → replan; ambiguous / security → user; repeated or no replans left → user", () => {
    const schema: Escalation = { kind: "schema_change", reason: "Needs a column" };
    expect(routeEscalation(schema, { subtaskKey: "s", permissionMode: "full_access", replansLeft: 1, repeated: false }).route).toBe("replan");
    expect(routeEscalation(schema, { subtaskKey: "s", permissionMode: "full_access", replansLeft: 0, repeated: false }).route).toBe("ask_user");
    expect(routeEscalation(schema, { subtaskKey: "s", permissionMode: "full_access", replansLeft: 3, repeated: true }).route).toBe("ask_user");
    expect(routeEscalation({ kind: "out_of_scope", reason: "r" }, { subtaskKey: "s", permissionMode: "supervised", replansLeft: 1, repeated: false }).route).toBe("replan");
    expect(routeEscalation({ kind: "ambiguous", reason: "r", options: ["A", "B"] }, { subtaskKey: "s", permissionMode: "full_access", replansLeft: 3, repeated: false })).toMatchObject({ route: "ask_user", options: ["A", "B"] });
    expect(routeEscalation({ kind: "security", reason: "r" }, { subtaskKey: "s", permissionMode: "full_access", replansLeft: 3, repeated: false }).route).toBe("ask_user");
  });

  function fakeCtx(permissionMode: string, replansLeft: number) {
    const calls: Record<string, any[]> = { pauseForInput: [], logEvent: [], recordSubtaskAcceptance: [] };
    const api = {
      pauseForInput: vi.fn(async (input: any) => {
        calls.pauseForInput.push(input);
        return { applied: true };
      }),
      logEvent: vi.fn(async (input: any) => {
        calls.logEvent.push(input);
      }),
      recordSubtaskAcceptance: vi.fn(async (input: any) => {
        calls.recordSubtaskAcceptance.push(input);
        return { applied: true };
      }),
    };
    const state: RunState = {
      priorOutputs: new Map(),
      qaVerdicts: {},
      reviewVerdicts: {},
      fileChanges: new Map(),
      appliedFilesBySubtask: new Map(),
      feedback: [],
    };
    const ctx = {
      deps: { api, workerId: "w1" },
      task: { _id: "t1", permissionMode },
      project: { _id: "p1" },
      taskId: "t1",
      state,
      input: { replansLeft },
      inStageLoop: false,
      escalated: false,
      decisionTerminal: false,
      replanFeedback: null as string | null,
      waitingForInput: null as string | null,
    };
    return { ctx, calls, state };
  }

  it("the runner asks the user through ask_user and records subtask.escalated (supervised)", async () => {
    const { ctx, calls } = fakeCtx("supervised", 2);
    await handleEscalation(ctx as any, "implement", dep, "e1");
    expect(calls.pauseForInput).toHaveLength(1);
    expect(calls.pauseForInput[0].options).toEqual(["Allow the dependency", "Do it without a new dependency"]);
    expect(ctx.waitingForInput).toMatch(/Allow the new dependency\?/);
    expect(ctx.decisionTerminal).toBe(true);
    expect(calls.logEvent[0]).toMatchObject({ type: "subtask.escalated", payload: { kind: "new_dependency", route: "ask_user" } });
    expect(calls.recordSubtaskAcceptance[0]).toMatchObject({ key: "implement", acceptanceStatus: "escalated", escalation: dep });
  });

  it("the runner routes to the CTO (replan with note) and records the allowance (auto edits)", async () => {
    const { ctx, calls, state } = fakeCtx("auto_edits", 2);
    await handleEscalation(ctx as any, "implement", dep);
    expect(calls.pauseForInput).toHaveLength(0);
    expect(ctx.replanFeedback).toMatch(/^Escalation from subtask implement/);
    expect(state.allowedEscalations).toEqual([{ kind: "new_dependency", detail: "zod" }]);
    // The same escalation again after the replan goes to the user.
    await handleEscalation(ctx as any, "implement", dep);
    expect(calls.pauseForInput).toHaveLength(1);
  });

  it("a positive answer to the escalation question allows it on the next run; a declining one does not", () => {
    const rows = [{ acceptanceStatus: "escalated", escalation: { kind: "new_dependency", detail: "zod" } }];
    const yes: RunState = { priorOutputs: new Map(), qaVerdicts: {}, reviewVerdicts: {}, fileChanges: new Map(), appliedFilesBySubtask: new Map(), feedback: [] };
    seedAllowedEscalations(yes, rows, "Allow the dependency");
    expect(yes.allowedEscalations).toEqual([{ kind: "new_dependency", detail: "zod" }]);
    const no: RunState = { ...yes, allowedEscalations: undefined };
    seedAllowedEscalations(no, rows, "Do it without a new dependency");
    expect(no.allowedEscalations).toBeUndefined();
  });
});

describe("model tier precedence (plan 022)", () => {
  const pool: PoolConnection[] = [
    {
      _id: "conn",
      name: "Conn",
      provider: "openai-compatible",
      baseUrl: "https://llm.example/v1",
      apiKeyEnv: "",
      apiKey: "k",
      priority: 1,
      weight: 1,
      models: [
        { _id: "row-cheap", modelId: "cheap", isAvailable: true, inputPricePer1k: 0.1, outputPricePer1k: 0.2 },
        { _id: "row-strong", modelId: "strong", isAvailable: true, inputPricePer1k: 1, outputPricePer1k: 2 },
        { _id: "row-mid", modelId: "mid", isAvailable: true },
      ],
    },
  ];
  const tiers = { planner: "row-strong", reviewer: "row-strong", worker: "row-mid" };

  it("roles map to tiers: CTO → planner, Reviewer → reviewer, the rest → worker", () => {
    expect(tierForRole("cto")).toBe("planner");
    expect(tierForRole("reviewer")).toBe("reviewer");
    for (const role of ["frontend", "backend", "qa", "devops", "designer", "support", "researcher"]) {
      expect(tierForRole(role)).toBe("worker");
    }
  });

  it("explicit agent model > tier > default", () => {
    const resolver = new TaskLlmResolver(pool, new ProviderHealthRegistry(), { tiers });
    const resolvedDefault = new TaskLlmResolver(pool, new ProviderHealthRegistry()).resolutionFor({ role: "cto" }).primary.model;
    expect(resolvedDefault).toBe("cheap");
    expect(resolver.resolutionFor({ role: "cto", name: "CTO" }).primary.model).toBe("strong");
    expect(resolver.resolutionFor({ role: "reviewer" }).primary.model).toBe("strong");
    expect(resolver.resolutionFor({ role: "frontend" }).primary.model).toBe("mid");
    expect(resolver.resolutionFor({ role: "frontend", llmModelId: "row-cheap" }).primary.model).toBe("cheap");
    expect(applyModelTier({ role: "backend", llmProviderId: "conn" }, tiers).source).toBe("agent");
  });

  it("a tier model missing from the pool resolves like no tier", () => {
    const resolver = new TaskLlmResolver(pool, new ProviderHealthRegistry(), { tiers: { worker: "row-gone" } });
    expect(resolver.resolutionFor({ role: "backend" }).primary.model).toBe("cheap");
  });

  it("the estimator's expectedModelFor respects the tiers", () => {
    const resolver = new TaskLlmResolver(pool, new ProviderHealthRegistry(), { tiers });
    expect(resolver.expectedModelFor({ role: "cto" })).toMatchObject({ model: "strong", inputPricePer1k: 1 });
    expect(resolver.expectedModelFor({ role: "qa" })?.model).toBe("mid");
  });
});

describe("reviewer is read-only (plan 022)", () => {
  const ctx: ToolContext = { workspaceRoot: "/tmp/ws", actor: "test", agentRole: "reviewer", audit: async () => undefined } as ToolContext;
  it("the broker denies write_file and run_command for the reviewer role", async () => {
    const write = await tool_call({ ctx, supportedTools: ["write_file", "run_command", "read_file"], name: "write_file", args: { path: "a.ts", content: "x" } });
    expect(write.ok).toBe(false);
    expect(write.reason).toBe("denied:reviewer:write_file:read-only-role");
    const run = await tool_call({ ctx, supportedTools: ["write_file", "run_command", "read_file"], name: "run_command", args: { command: "npm run test" } });
    expect(run.ok).toBe(false);
    expect(run.reason).toBe("denied:reviewer:run_command:read-only-role");
  });
});
