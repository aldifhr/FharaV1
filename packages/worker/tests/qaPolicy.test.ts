import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  chromiumLaunchOptions,
  devServerPortArgs,
  isBrowserRunnable,
  isLoopbackUrl,
  runResponsiveQa,
} from "@/execution/qa";
import { resolveIssuesForQaPass, type OutstandingIssue } from "@/orchestrator/taskContext";
import { carryForwardState } from "@/services/runner/state";
import { evaluateDelegation } from "@/orchestrator/delegation";
import { BudgetTracker } from "@/orchestrator/budget";
import { loadPolicy } from "@/orchestrator/policy";
import { classifyCommand } from "@/orchestrator/classifier";
import { pickQaFixOwner } from "@/services/runner/qaLoop";
import type { AgentDefinition, ExecutionPlan } from "@/orchestrator/types";
import type { RunState } from "@/services/runner/types";

const issue = (overrides: Partial<OutstandingIssue> = {}): OutstandingIssue => ({
  id: "i1",
  description: "SQL injection in handler",
  severity: "high",
  status: "open",
  raisedBy: "Reviewer",
  source: "code-review",
  relatedFiles: ["a.ts"],
  ...overrides,
});

describe("QA pass scope (QA audit P0-2)", () => {
  it("a QA pass never resolves reviewer findings, even on applied files", () => {
    const result = resolveIssuesForQaPass([issue()], new Set(["a.ts"]), {
      qaAgentNames: new Set(["QA"]),
    });
    expect(result[0].status).toBe("open");
  });

  it("a QA pass resolves issues QA itself raised", () => {
    const bySource = issue({ id: "q1", raisedBy: "QA", source: "browser-testing", description: "console error" });
    const byName = issue({ id: "q2", raisedBy: "QA", source: undefined, relatedFiles: undefined });
    const byText = issue({ id: "q3", raisedBy: undefined, source: undefined, description: "QA structural check: boom", relatedFiles: undefined });
    const result = resolveIssuesForQaPass([bySource, byName, byText], new Set(["a.ts"]), {
      qaAgentNames: new Set(["QA"]),
    });
    expect(result.map((i) => i.status)).toEqual(["resolved", "resolved", "resolved"]);
  });
});

describe("QA verdicts never carry across a replan (QA audit P1-7)", () => {
  it("drops QA verdicts and does not mark the new QA node completed", () => {
    const sub = (key: string, kind: "code_change" | "qa", description: string) => ({
      key,
      title: key,
      description,
      kind,
      capability: kind === "qa" ? "browser-testing" : "frontend-development",
      dependencies: [],
      order: 0,
    });
    const oldPlan: ExecutionPlan = {
      version: 1, goal: "g", strategy: "dag", requiresApproval: true, maxConcurrency: 1,
      subtasks: [sub("implement", "code_change", "write it"), sub("qa", "qa", "Validate the page")],
    };
    const newPlan: ExecutionPlan = {
      ...oldPlan,
      subtasks: [sub("implement", "code_change", "write it"), sub("qa", "qa", "Validate the page")],
    };
    const state: RunState = {
      priorOutputs: new Map([["implement", "done"], ["qa", "QA verdict: passed"]]),
      qaVerdicts: { qa: "passed" },
      reviewVerdicts: {},
      fileChanges: new Map(),
      appliedFilesBySubtask: new Map(),
      feedback: [],
    };
    const { state: carried, completedKeys } = carryForwardState(oldPlan, state, newPlan);
    expect(carried.qaVerdicts).toEqual({});
    expect(completedKeys.has("qa")).toBe(false);
    expect(completedKeys.has("implement")).toBe(true);
  });
});

describe("qaMode=never blocks browser-testing delegation (QA audit P0-3)", () => {
  const agents: AgentDefinition[] = [
    { _id: "fe", name: "Frontend", role: "frontend", capabilities: ["frontend-development"], isEnabled: true },
    { _id: "qa", name: "QA", role: "qa", capabilities: ["browser-testing"], isEnabled: true },
  ];
  const evaluate = (qaMode: "never" | "auto") =>
    evaluateDelegation({
      result: {
        agentName: "Frontend",
        capability: "frontend-development",
        success: true,
        summary: "done",
        delegationRecommendation: { targetCapability: "browser-testing", reason: "QA it" },
      },
      classification: classifyCommand("build the page"),
      agents,
      budget: new BudgetTracker({ ...loadPolicy(), qaMode }),
      previousAgents: [],
      delegationDepth: 0,
      alreadyDelegatedCapabilities: [],
      chainCapabilities: ["frontend-development"],
    } as any);

  it("rejects the recommendation under never, allows it under auto", () => {
    expect(evaluate("never").decision).toBe("REJECT");
    expect(evaluate("auto").decision).toBe("APPROVE");
  });
});

describe("QA fix owner (QA audit P1-5)", () => {
  it("prefers the UI owner over a later backend code_change", () => {
    const owner = pickQaFixOwner(
      [
        { key: "ui", kind: "code_change", capability: "frontend-development", allowedPaths: ["apps/web"] },
        { key: "api", kind: "code_change", capability: "backend-development", allowedPaths: ["apps/api"] },
      ],
      [{ filePath: "" }]
    );
    expect(owner?.key).toBe("ui");
  });
});

describe("dev-server start helpers (QA audit P1-2/P1-4)", () => {
  it("passes port/host CLI args for Vite-family and Next", () => {
    expect(devServerPortArgs("vite", "4321")).toEqual(["--", "--port", "4321", "--host", "127.0.0.1", "--strictPort"]);
    expect(devServerPortArgs("svelte-kit dev", "4321")).toContain("--strictPort");
    expect(devServerPortArgs("astro dev", "4321")).toEqual(["--", "--port", "4321", "--host", "127.0.0.1"]);
    expect(devServerPortArgs("next dev", "4321")).toEqual(["--", "--port", "4321", "--hostname", "127.0.0.1"]);
    expect(devServerPortArgs("node server.js", "4321")).toEqual([]);
  });

  it("only auto-starts for loopback URLs", () => {
    expect(isLoopbackUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isLoopbackUrl("http://localhost:3000")).toBe(true);
    expect(isLoopbackUrl("https://staging.example.com")).toBe(false);
  });
});

describe("chromium launch options", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("honours QA_CHROMIUM_PATH, then PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", () => {
    delete process.env.QA_CHROMIUM_PATH;
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "/opt/b";
    expect(chromiumLaunchOptions().executablePath).toBe("/opt/b");
    process.env.QA_CHROMIUM_PATH = "/opt/a";
    expect(chromiumLaunchOptions().executablePath).toBe("/opt/a");
  });

  it("adds --no-sandbox when QA_CHROMIUM_NO_SANDBOX=1", () => {
    process.env.QA_CHROMIUM_NO_SANDBOX = "1";
    expect(chromiumLaunchOptions().args).toContain("--no-sandbox");
  });
});

describe("environment problems are 'blocked', not code defects (QA audit P1-1)", () => {
  let workspace: string;
  const saved = { ...process.env };
  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-qa-env-"));
  });
  afterEach(async () => {
    process.env = { ...saved };
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("a non-runnable project is blocked without starting anything", async () => {
    expect(await isBrowserRunnable(workspace)).toBe(false);
    const report = await runResponsiveQa(workspace);
    expect(report.verdict).toBe("blocked");
    expect(report.blockedReason).toMatch(/not browser-runnable/);
    expect(report.failures).toHaveLength(0);
  });

  it("a missing browser binary is blocked with an install hint", async () => {
    await fs.writeFile(path.join(workspace, "index.html"), "<h1>hi</h1>");
    process.env.QA_CHROMIUM_PATH = path.join(workspace, "no-such-chromium");
    const report = await runResponsiveQa(workspace);
    expect(report.verdict).toBe("blocked");
    expect(report.blockedReason).toMatch(/playwright install chromium|QA_CHROMIUM_PATH/);
  });

  it("missing node_modules for a project with dependencies is blocked", async () => {
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "^5" } })
    );
    const report = await runResponsiveQa(workspace, { preflight: false });
    expect(report.verdict).toBe("blocked");
    expect(report.blockedReason).toMatch(/node_modules/);
  });

  it("a dev server that exits early fails fast with its last log lines", async () => {
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ scripts: { dev: "node -e \"console.error('Cannot find module boom'); process.exit(3)\"" } })
    );
    const started = Date.now();
    const report = await runResponsiveQa(workspace, { preflight: false, startupTimeoutMs: 20_000 });
    expect(report.verdict).toBe("failed");
    expect(Date.now() - started).toBeLessThan(15_000);
    const detail = report.checks.find((c) => c.label === "application reachable")?.details ?? "";
    expect(detail).toMatch(/exited/);
    expect(detail).toMatch(/Cannot find module boom/);
  }, 30_000);
});

// Real browser runs: only where a Chromium is available (QA_CHROMIUM_PATH,
// e.g. /workspace/work/bin/chromium on linux-arm64 where Playwright's CDN
// has no build).
const chromiumPath = process.env.QA_CHROMIUM_PATH;
describe.skipIf(!chromiumPath || !existsSync(chromiumPath))("real browser QA (static site)", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-qa-real-"));
  });
  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("serves a plain index.html and passes structural checks", async () => {
    await fs.writeFile(path.join(workspace, "index.html"), "<!doctype html><html><body><h1>Pricing</h1></body></html>");
    const report = await runResponsiveQa(workspace);
    expect(report.verdict).toBe("passed");
    expect(report.checks.map((c) => c.label)).toEqual(["application reachable", "structural check"]);
    // Structural mode writes no artefacts into the repo.
    await expect(fs.access(path.join(workspace, ".qa"))).rejects.toThrow();
  }, 60_000);

  it("reports a same-origin sub-resource 404 with its URL (favicon ignored)", async () => {
    await fs.writeFile(
      path.join(workspace, "index.html"),
      '<!doctype html><html><body><h1>Hi</h1><script src="/missing.js"></script></body></html>'
    );
    const report = await runResponsiveQa(workspace);
    expect(report.verdict).toBe("failed");
    expect(report.failures.join(" ")).toMatch(/HTTP 404 .*missing\.js/);
    expect(report.failures.join(" ")).not.toMatch(/favicon/);
  }, 60_000);

  it("catches uncaught page exceptions (pageerror)", async () => {
    await fs.writeFile(
      path.join(workspace, "index.html"),
      "<!doctype html><html><body><h1>Hi</h1><script>throw new Error('kaboom')</script></body></html>"
    );
    const report = await runResponsiveQa(workspace);
    expect(report.verdict).toBe("failed");
    expect(report.failures.join(" ")).toMatch(/Uncaught: kaboom/);
  }, 60_000);
});
