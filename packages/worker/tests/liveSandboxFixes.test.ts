import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { classifyCommand, isVagueBugHunt } from "@/orchestrator/classifier";
import { buildPlanningPrompt, heuristicPlan } from "@/orchestrator/planner";
import { loadPolicy } from "@/orchestrator/policy";
import type { AgentDefinition } from "@/orchestrator/types";
import { filesInOutput, isPreExistingFailure, runVerification } from "@/execution/verification";
import { attributeFinding } from "@/services/runner/verifyLoop";
import { newFilesOnlyFixWarning } from "@/services/runner/noTargetGuard";
import { brokerCheckAndApply } from "@/services/runner/applyStage";
import { IMPLEMENTATION_RULES, NO_TARGET_RULE } from "@/prompts/codeChange";
import type { RunContext } from "@/services/runner/types";

/**
 * Live sandbox run fixes: "search bug" planned a code_change that invented
 * a search feature (6a / 8), a bare file list failed as invalid JSON (6b,
 * covered in ultraControl.test.ts with 6c), and a lint error in an untouched
 * component failed verification and was pinned on the new file (7).
 */

const policy = loadPolicy();
const frontend: AgentDefinition = { _id: "f", name: "Frontend", role: "frontend", capabilities: ["frontend-development"] };
const reviewer: AgentDefinition = { _id: "r", name: "Reviewer", role: "reviewer", capabilities: ["code-review"] };
const qa: AgentDefinition = { _id: "q", name: "QA", role: "qa", capabilities: ["qa-testing", "browser-testing"] };

// ─── 6a: a vague bug hunt is a read-only Reviewer investigation ────────────

describe("6a vague bug hunt", () => {
  it("detects hunts without a symptom (EN/ID)", () => {
    for (const command of ["search bug", "find bugs", "cari bug", "temukan bug di src/", "cek error di project ini", "look for potential issues", "cari bug lalu perbaiki"]) {
      expect(isVagueBugHunt(command), command).toBe(true);
    }
  });

  it("a described symptom or a change request is not a vague hunt", () => {
    for (const command of [
      "cari bug: login gagal saat password kosong",
      "find the bug when the form doesn't submit",
      "fix the search page",
      "tambahkan fitur search",
      "find bugs and add tests for them",
      'cari bug "TypeError: x is undefined"',
      "explain the approval flow",
    ]) {
      expect(isVagueBugHunt(command), command).toBe(false);
    }
  });

  it("classifies as a research investigation with code-review first", () => {
    const result = classifyCommand("search bug");
    expect(result.kind).toBe("research");
    expect(result.investigation).toBe(true);
    expect(result.suggestedCapabilities[0]).toBe("code-review");
  });

  it("the heuristic plan is ONE read-only Reviewer subtask, no code_change and no QA", () => {
    const command = "cari bug";
    const plan = heuristicPlan({
      command,
      classification: classifyCommand(command),
      agents: [frontend, reviewer, qa],
      policy: { ...policy, qaMode: "auto" as const },
      hasQaUrl: true,
    });
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0]).toMatchObject({ key: "investigate", kind: "research", capability: "code-review" });
    expect(plan.subtasks[0].description).toMatch(/Read-only bug investigation/);
    expect(plan.requiresApproval).toBe(false);
  });

  it("falls back to research when no Reviewer is on the team", () => {
    const command = "find bugs";
    const plan = heuristicPlan({ command, classification: classifyCommand(command), agents: [frontend], policy });
    expect(plan.subtasks.map((s) => [s.kind, s.capability])).toEqual([["research", "research"]]);
  });

  it("the LLM planning prompt tells it to plan exactly one Reviewer subtask", () => {
    const command = "search bug";
    const prompt = buildPlanningPrompt({ command, classification: classifyCommand(command), agents: [frontend, reviewer], policy });
    expect(prompt).toContain("vague bug hunt with no symptom: plan exactly ONE research subtask with capability code-review");
  });
});

// ─── 7: verification is scoped to the changed files ────────────────────────

describe("7 verification scoped to changed files", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-scope-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("filesInOutput reads tsc and ESLint paths, workspace-relative, no node_modules", () => {
    const tsc = "src/app/page.tsx(3,1): error TS2322: nope\nsrc/lib/a.ts:4:2 - error TS1005";
    expect(filesInOutput(tsc, root)).toEqual(["src/app/page.tsx", "src/lib/a.ts"]);
    const eslint = `\n${path.join(root, "src/components/ThreeColumnLayout.tsx")}\n  12:5  error  react-hooks/exhaustive-deps\n`;
    expect(filesInOutput(eslint, root)).toEqual(["src/components/ThreeColumnLayout.tsx"]);
    expect(filesInOutput("node_modules/x/index.d.ts(1,1): error\n/etc/other.ts(1,1): error", root)).toEqual([]);
    // The package manager's script echo is not a failing file.
    expect(filesInOutput("> app@1.0.0 lint\n> node scripts/lint.mjs\n\nError: config missing", root)).toEqual([]);
    // Relative to the package directory a step ran in.
    expect(filesInOutput("src/a.ts(1,1): error", root, path.join(root, "apps/web"))).toEqual(["apps/web/src/a.ts"]);
  });

  it("isPreExistingFailure: only when every named file is outside the change", () => {
    expect(isPreExistingFailure(["src/old.tsx"], ["src/new.tsx"])).toBe(true);
    expect(isPreExistingFailure(["src/old.tsx", "src/new.tsx"], ["./src/new.tsx"])).toBe(false);
    expect(isPreExistingFailure([], ["src/new.tsx"])).toBe(false);
    expect(isPreExistingFailure(["src/old.tsx"], [])).toBe(false);
  });

  async function pkg(scripts: Record<string, string>) {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "app", scripts }), "utf-8");
    await fs.writeFile(
      path.join(root, "lint-old.js"),
      'console.error("src/components/Old.tsx:12:5  error  react-hooks/rules-of-hooks");\nprocess.exit(1);\n'
    );
    await fs.writeFile(path.join(root, "lint-new.js"), 'console.error("src/app/new.tsx:1:1  error  no-unused-vars");\nprocess.exit(1);\n');
    await fs.writeFile(path.join(root, "ok.js"), "process.exit(0);\n");
  }

  it("a lint failure only in an untouched file passes as pre-existing and verification moves on", async () => {
    await pkg({ lint: "node lint-old.js", test: "node ok.js" });
    const result = await runVerification({ workspacePath: root, changedFiles: ["src/app/new.tsx"], includeBuild: false });
    const lint = result.checks.find((c) => c.name.endsWith(":lint"));
    expect(lint?.status).toBe("passed");
    expect(lint?.details).toMatch(/pre-existing, ignored\): src\/components\/Old\.tsx/);
    expect(result.checks.some((c) => c.name.endsWith(":test"))).toBe(true);
  });

  it("a lint failure in a changed file still fails, with the file attached", async () => {
    await pkg({ lint: "node lint-new.js" });
    const result = await runVerification({ workspacePath: root, changedFiles: ["src/app/new.tsx"], includeBuild: false });
    const lint = result.checks.find((c) => c.name.endsWith(":lint"));
    expect(lint?.status).toBe("failed");
    expect(lint?.files).toEqual(["src/app/new.tsx"]);
  });

  it("scopeFiles [] disables the scoping", async () => {
    await pkg({ lint: "node lint-old.js" });
    const result = await runVerification({ workspacePath: root, changedFiles: ["src/app/new.tsx"], scopeFiles: [], includeBuild: false });
    expect(result.checks.find((c) => c.name.endsWith(":lint"))?.status).toBe("failed");
  });

  it("attributeFinding prefers a changed file the output names, then any named file", () => {
    const changed = ["src/app/search/page.tsx", "src/lib/a.ts"];
    expect(attributeFinding({ files: ["src/components/X.tsx", "src/lib/a.ts"] }, changed)).toBe("src/lib/a.ts");
    expect(attributeFinding({ files: ["src/components/ThreeColumnLayout.tsx"] }, changed)).toBe("src/components/ThreeColumnLayout.tsx");
    expect(attributeFinding({ details: "error in src/lib/a.ts" }, changed)).toBe("src/lib/a.ts");
    expect(attributeFinding({ details: "boom" }, changed)).toBe("src/app/search/page.tsx");
    expect(attributeFinding({}, [])).toBe("");
  });
});

// ─── 8: no-target rule and guard ────────────────────────────────────────────

describe("8 no-target rule", () => {
  it("the implementation rules carry the no-target rule", () => {
    expect(IMPLEMENTATION_RULES).toContain(NO_TARGET_RULE);
    expect(NO_TARGET_RULE).toContain('"findings":["Not found: <what the task refers to>. Checked:');
  });

  it("newFilesOnlyFixWarning flags a fix whose changes only create files", () => {
    const created = [
      { filePath: "src/app/search/page.tsx", changeType: "new" },
      { filePath: "src/components/search-form.tsx", changeType: "new" },
    ];
    const warning = newFilesOnlyFixWarning("fix the search bug", created);
    expect(warning).toMatch(/^Check before approving: this is a fix request, but every change creates a new file \(src\/app\/search\/page\.tsx, src\/components\/search-form\.tsx\)/);
    expect(newFilesOnlyFixWarning("perbaiki bug search", created)).not.toBeNull();
    // An edit to existing code, a non-fix request, or no changes: no warning.
    expect(newFilesOnlyFixWarning("fix the search bug", [...created, { filePath: "src/app/page.tsx", changeType: "modified" }])).toBeNull();
    expect(newFilesOnlyFixWarning("add a search page", created)).toBeNull();
    expect(newFilesOnlyFixWarning("fix the search bug", [])).toBeNull();
  });

  function ctxFor(command: string, changes: Array<{ filePath: string; changeType: string }>) {
    const api = {
      checkPermission: vi.fn(async () => ({ decision: "ask", reason: "test" })),
      autoApprove: vi.fn(async () => ({ autoApproved: true, reason: "test", mode: "full_access" })),
      requestApproval: vi.fn(async () => "approval_1"),
      appendAgentMessage: vi.fn(async () => undefined),
      logEvent: vi.fn(async () => undefined),
      recordAudit: vi.fn(async () => undefined),
    };
    const applyStaged = vi.fn(async (staged: any[]) => ({ applied: staged.map((c) => c.filePath) }));
    const ctx = {
      deps: { api, workerId: "w1", workspaceRoot: "/ws" },
      taskId: "task_1",
      project: { _id: "project_1", workspacePath: "/ws/app" },
      plan: { version: 1, subtasks: [] },
      input: { approvalMode: "ask", planVersion: 1, agents: [], task: { _id: "task_1", command, permissionMode: "full_access" } },
      state: { fileChanges: new Map(), verification: undefined },
      reviewNodes: [],
      qaNodes: [],
      applyStaged,
    } as unknown as RunContext;
    const prepared = {
      preparedChanges: changes.map((c) => ({ ...c, newContent: "x\n", diff: "" })),
      approvedVerdicts: [],
      reviewSnapshotId: undefined,
      dryRunSummary: undefined,
    } as any;
    return { ctx, api, applyStaged, prepared };
  }

  it("a new-files-only fix is never auto-approved: it asks, with the warning on the approval", async () => {
    const { ctx, api, applyStaged, prepared } = ctxFor("fix the search bug", [{ filePath: "src/app/search/page.tsx", changeType: "new" }]);
    expect(await brokerCheckAndApply(ctx, prepared)).toBe("waiting_approval");
    expect(api.autoApprove).not.toHaveBeenCalled();
    expect(applyStaged).not.toHaveBeenCalled();
    const request = (api.requestApproval.mock.calls[0] as any[])[0];
    expect(request.payload.warning).toMatch(/^Check before approving/);
    expect(request.summary).toContain("Check before approving");
  });

  it("a fix that edits existing code still goes through the permission mode", async () => {
    const { ctx, api, applyStaged, prepared } = ctxFor("fix the search bug", [{ filePath: "src/app/page.tsx", changeType: "modified" }]);
    expect(await brokerCheckAndApply(ctx, prepared)).toBeNull();
    expect(api.autoApprove).toHaveBeenCalledTimes(1);
    expect(applyStaged).toHaveBeenCalledTimes(1);
  });
});
