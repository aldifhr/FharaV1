import { describe, expect, it } from "vitest";
import { verificationPhase, verifyFixKey, verifyFixesInPhase } from "@/services/runner/verifyLoop";
import { createPlan, pickPlanner } from "@/orchestrator/planner";
import { classifyCommand } from "@/orchestrator/classifier";
import { loadPolicy } from "@/orchestrator/policy";
import type { AgentDefinition } from "@/types";
import type { TaskLlmResolver } from "@/llm/resolver";
import { classifyConsoleErrors, isHydrationMismatch, sourcePathsIn } from "@/execution/qa";
import { isPermanentSubtaskError } from "@/scheduler/dagScheduler";
import { qaFindings } from "@/services/runner/setup";
import { withUsageEstimate } from "@/effects/llmCall";
import { codeChangePrompt } from "@/prompts/codeChange";
import { buildNativePrompt } from "@/prompts/native";
import { buildPlanningPrompt } from "@/orchestrator/planner";
import { QA_FIX_INTRO, VERIFY_FIX_INTRO } from "@/prompts/fix";
import { nextDeterministicDecision } from "@/orchestrator/decision";

const policy = loadPolicy();
const frontend: AgentDefinition = { _id: "fe", name: "Frontend", role: "frontend", capabilities: ["frontend-development"] };
const cto: AgentDefinition = { _id: "cto", name: "CTO", role: "cto", capabilities: ["architecture"] };

/** Resolver whose only provider answers with a fixed plan JSON. */
function resolverAnswering(content: string, calls: string[]): TaskLlmResolver {
  return {
    handlesFor: (agent: AgentDefinition) => {
      calls.push(agent.name);
      return [
        {
          connectionId: "",
          connectionName: "fake",
          config: { provider: "openai-compatible", model: "nous", apiKey: "x", baseUrl: "http://x" } as never,
          provider: { complete: async () => ({ content }) },
        },
      ];
    },
  } as unknown as TaskLlmResolver;
}

describe("1. planner fallback: global CTO plans when the team lacks one", () => {
  it("pickPlanner prefers the run's own CTO, else the (enabled) fallback", () => {
    expect(pickPlanner([frontend, cto], { ...cto, _id: "global" })?._id).toBe("cto");
    expect(pickPlanner([frontend], cto)?._id).toBe("cto");
    expect(pickPlanner([frontend], { ...cto, isEnabled: false })).toBeNull();
    expect(pickPlanner([frontend], null)).toBeNull();
  });

  it("createPlan uses the fallback CTO as planner (not degraded) and never routes it a subtask", async () => {
    const calls: string[] = [];
    const plan = JSON.stringify({
      goal: "Implement Tiga Kolom",
      strategy: "single",
      requiresApproval: true,
      maxConcurrency: 1,
      subtasks: [
        { key: "implement", title: "Tiga Kolom", description: "add component and render it in app/page.tsx", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0 },
      ],
    });
    const command = "Implement Tiga Kolom";
    const result = await createPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend],
      plannerAgent: cto,
      plannerFallbackReason: "CTO not in project team",
      policy: { ...policy, reviewMode: "never", qaMode: "never" },
      llmResolver: resolverAnswering(plan, calls),
    });
    expect(calls).toEqual(["CTO"]);
    expect(result.createdBy).toBe("orchestrator");
    expect(result.degradedReason).toBeUndefined();
    expect(result.plan.subtasks.every((s) => s.capability !== "architecture")).toBe(true);
  });

  it("without a CTO the planner runs on a team member's chain (O1); the note says why", async () => {
    const command = "Implement Tiga Kolom";
    const result = await createPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend],
      plannerFallbackReason: "CTO not in project team; no enabled CTO agent exists",
      policy,
    });
    expect(result.createdBy).toBe("fallback");
    expect(result.degradedReason).toContain("CTO not in project team");
  });
});

describe("2. verification fix budget per phase", () => {
  it("phase = QA fix rounds in the plan; keys are unique per phase", () => {
    const keys = (list: string[]) => list.map((key) => ({ key }));
    expect(verificationPhase(keys(["implement"]))).toBe(0);
    expect(verificationPhase(keys(["implement", "fix_qa_1", "fix_qa_2"]))).toBe(2);
    expect(verifyFixKey(0, 1)).toBe("fix_verify_1");
    expect(verifyFixKey(1, 1)).toBe("fix_verify_qa1_1");
    const plan = keys(["fix_verify_1", "fix_verify_2", "fix_qa_1", "fix_verify_qa1_1", "fix_verify_qa1_1_2"]);
    expect(verifyFixesInPhase(plan, 0)).toBe(2);
    expect(verifyFixesInPhase(plan, 1)).toBe(2);
    expect(verifyFixesInPhase(plan, 2)).toBe(0);
  });
});

describe("3. QA: no blind retry, pre-existing console errors, file paths", () => {
  it("every deterministic QA check failure is permanent; a harness exception stays retryable", () => {
    expect(isPermanentSubtaskError("QA failed: structural check: Console errors: boom")).toBe(true);
    expect(isPermanentSubtaskError("QA failed: structural check: Network failures: HTTP 500 /api")).toBe(true);
    expect(isPermanentSubtaskError("QA failed: qa-run: browser crashed")).toBe(false);
  });

  it("detects React hydration-mismatch warnings", () => {
    expect(isHydrationMismatch("Warning: Text content did not match. Server: \"a\" Client: \"b\"")).toBe(true);
    expect(isHydrationMismatch("Hydration failed because the server rendered HTML didn't match the client.")).toBe(true);
    expect(isHydrationMismatch("A tree hydrated but some attributes of the server rendered HTML didn't match the client properties.")).toBe(true);
    expect(isHydrationMismatch("TypeError: x is undefined")).toBe(false);
  });

  it("extracts project source paths from Next/Vite stacks, dropping bundler and node_modules frames", () => {
    expect(
      sourcePathsIn(
        "at Foo (webpack-internal:///(app-pages-browser)/./components/TigaKolom.tsx:12:5)\n" +
          "at http://127.0.0.1:3000/_next/static/chunks/app/page.js:3:1\n" +
          "at x (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/x.js:1:1)"
      )
    ).toEqual(["components/TigaKolom.tsx"]);
    expect(sourcePathsIn("at http://127.0.0.1:5173/src/App.tsx?t=1:4:2")).toEqual(["src/App.tsx"]);
  });

  it("classifies hydration warnings and errors from unchanged files as pre-existing; derives the file of caused ones", () => {
    const split = classifyConsoleErrors(
      [
        { text: "Warning: Text content did not match. Server: \"a\" Client: \"b\"" },
        { text: "Uncaught: legacy broke", source: "at y (webpack-internal:///(app-pages-browser)/./components/Old.tsx:1:1)" },
        { text: "Uncaught: new broke", source: "at z (webpack-internal:///(app-pages-browser)/./components/TigaKolom.tsx:3:1)" },
        { text: "mystery error with no stack" },
      ],
      ["components/TigaKolom.tsx"]
    );
    expect(split.preExisting).toEqual(["Warning: Text content did not match. Server: \"a\" Client: \"b\"", "Uncaught: legacy broke"]);
    expect(split.caused).toEqual(["Uncaught: new broke", "mystery error with no stack"]);
    expect(split.filePath).toBe("components/TigaKolom.tsx");
  });

  it("QA findings carry the check's derived filePath", () => {
    const run = {
      status: "failed",
      outcomes: new Map([
        ["qa", { status: "failed", error: "QA failed", meta: { checks: [{ label: "structural check", status: "failed", details: "Console errors: x", filePath: "components/TigaKolom.tsx" }] } }],
      ]),
    } as never;
    const findings = qaFindings(run, [{ key: "qa" } as never]);
    expect(findings[0].filePath).toBe("components/TigaKolom.tsx");
  });
});

describe("4. implement / fix / planner prompt rules", () => {
  it("code_change and native prompts carry the wiring, type-definition, hydration and placeholder rules", () => {
    const code = codeChangePrompt({ command: "c", subtask: { title: "t", description: "d" }, context: "", staged: "", mcpFindings: "" });
    const native = buildNativePrompt({ title: "t", description: "d", command: "c" });
    for (const prompt of [code, native]) {
      expect(prompt).toContain("an unused component is not done");
      expect(prompt).toMatch(/node_modules\/<pkg>\/dist\/\*\.d\.ts/);
      expect(prompt).toMatch(/suppressHydrationWarning/);
      expect(prompt).toMatch(/placeholder comments/);
    }
    expect(VERIFY_FIX_INTRO).toMatch(/type definitions/);
    expect(QA_FIX_INTRO).toMatch(/pre-existing/);
  });

  it("the planner requires UI subtasks to name the integration file", () => {
    const command = "Implement Tiga Kolom";
    const prompt = buildPlanningPrompt({ command, classification: classifyCommand(command), agents: [frontend], policy, capabilityList: "" } as never);
    expect(prompt).toMatch(/integration file/);
  });
});

describe("5. decision naming", () => {
  it("a declined delegation proposal completes as delegation:declined", () => {
    const det = nextDeterministicDecision(
      { planVersion: 1 } as never,
      { outcome: "completed", decision: "REJECT", reason: "proposing agent can serve this capability" } as never
    );
    expect(det !== "ambiguous" && det.action).toBe("complete");
    expect(det !== "ambiguous" && det.expectedOutcome).toBe("delegation:declined");
  });
});

describe("6. token usage estimate", () => {
  it("missing usage becomes a flagged chars/4 estimate; reported usage is kept", () => {
    const messages = [{ role: "user" as const, content: "x".repeat(400) }];
    const estimated = withUsageEstimate(messages, { content: "y".repeat(40) });
    expect(estimated).toMatchObject({ inputTokens: 100, outputTokens: 10, usageEstimated: true });
    const reported = withUsageEstimate(messages, { content: "y", inputTokens: 7, outputTokens: 3 });
    expect(reported).toEqual({ content: "y", inputTokens: 7, outputTokens: 3 });
  });
});

describe("3b. QA flaky environment signals stay retryable", () => {
  it("5xx / navigation timeout / net errors are retried; console errors are not", () => {
    expect(isPermanentSubtaskError("QA failed: structural check: Page returned HTTP 503")).toBe(false);
    expect(isPermanentSubtaskError("QA failed: structural check: page.goto: Timeout 30000ms exceeded.")).toBe(false);
    expect(isPermanentSubtaskError("QA failed: structural check: page.goto: net::ERR_CONNECTION_REFUSED")).toBe(false);
    expect(isPermanentSubtaskError("QA failed: structural check: Page returned HTTP 404")).toBe(true);
    expect(isPermanentSubtaskError("QA failed: structural check: Page body is empty")).toBe(true);
  });
});
