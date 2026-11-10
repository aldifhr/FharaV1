import { describe, expect, it, vi } from "vitest";
import {
  checkCommitDependencies,
  checkDependencyChanges,
  dependencyWarning,
  typosquatTarget,
  type DepFileChange,
} from "@/execution/depHardening";
import { applyOrRequestFixApproval } from "@/services/runner/fixApply";
import { brokerCheckAndApply } from "@/services/runner/applyStage";
import type { RunContext } from "@/services/runner/types";

/** O8: dependency check fixtures (no network, no npm). */

const pkg = (deps: Record<string, string>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "app", version: "1.0.0", dependencies: deps, ...extra }, null, 2);

const manifest = (before: Record<string, string> | null, after: Record<string, string>, extra?: Record<string, unknown>): DepFileChange => ({
  filePath: "package.json",
  changeType: before ? "modified" : "new",
  ...(before ? { oldContent: pkg(before) } : {}),
  newContent: pkg(after, extra),
});

const lockChange: DepFileChange = { filePath: "package-lock.json", changeType: "modified", oldContent: "", newContent: "" };
const withLock = { fileExists: (p: string) => p === "package-lock.json" };

describe("typosquatTarget", () => {
  it("flags names one edit away from a popular package", () => {
    expect(typosquatTarget("lodahs")).toBe("lodash");
    expect(typosquatTarget("expresss")).toBe("express");
    expect(typosquatTarget("crossenv")).toBe("cross-env");
  });
  it("leaves popular names and scoped type packages alone", () => {
    expect(typosquatTarget("lodash")).toBeNull();
    expect(typosquatTarget("@types/react")).toBeNull();
    expect(typosquatTarget("left-pad-utilities")).toBeNull();
  });
});

describe("checkDependencyChanges", () => {
  it("skips a diff that touches no dependency file", async () => {
    const result = await checkDependencyChanges([{ filePath: "src/a.ts", changeType: "modified", oldContent: "a", newContent: "b" }]);
    expect(result).toMatchObject({ status: "skipped", high: 0 });
    expect(dependencyWarning(result)).toBeNull();
  });

  it("passes a pinned, registry dependency with its lockfile updated", async () => {
    const result = await checkDependencyChanges([manifest({ react: "18.2.0" }, { react: "18.2.0", zod: "3.23.8" }), lockChange], withLock);
    expect(result.status).toBe("passed");
    expect(result.high).toBe(0);
    expect(result.findings.map((f) => f.code)).toEqual(["audit-skipped"]);
    expect(dependencyWarning(result)).toBeNull();
  });

  it("fails on a known-compromised version", async () => {
    const result = await checkDependencyChanges([manifest({}, { "event-stream": "3.3.6" }), lockChange], withLock);
    expect(result.status).toBe("failed");
    expect(result.findings.find((f) => f.code === "known-bad")).toMatchObject({ severity: "high", package: "event-stream" });
  });

  it("fails on a range that admits a compromised version", async () => {
    const result = await checkDependencyChanges([manifest({}, { "ua-parser-js": "^0.7.28" }), lockChange], withLock);
    expect(result.findings.some((f) => f.code === "known-bad")).toBe(true);
    expect(result.findings.some((f) => f.code === "non-exact-range" && f.severity === "medium")).toBe(true);
  });

  it("fails on a typosquatted new dependency", async () => {
    const result = await checkDependencyChanges([manifest({ react: "18.2.0" }, { react: "18.2.0", lodahs: "4.17.21" }), lockChange], withLock);
    expect(result.status).toBe("failed");
    expect(result.findings.find((f) => f.code === "typosquat")?.message).toContain('"lodash"');
    expect(dependencyWarning(result)).toContain("high-risk");
  });

  it("fails when dependencies change and no lockfile exists", async () => {
    const result = await checkDependencyChanges([manifest({}, { zod: "3.23.8" })], { fileExists: () => false });
    expect(result.findings.find((f) => f.code === "lockfile-missing")?.severity).toBe("high");
    expect(result.status).toBe("failed");
  });

  it("warns (medium) on lockfile drift, git sources and install scripts", async () => {
    const result = await checkDependencyChanges(
      [manifest({}, { mylib: "github:someone/mylib" }, { scripts: { postinstall: "node evil.js" } })],
      withLock
    );
    const codes = result.findings.map((f) => `${f.severity}:${f.code}`);
    expect(codes).toContain("medium:non-registry-source");
    expect(codes).toContain("medium:install-script");
    expect(codes).toContain("medium:lockfile-drift");
    expect(result.status).toBe("passed");
    expect(dependencyWarning(result)).toContain("changes to review");
  });

  it("finds the lockfile of a nested workspace package by walking up", async () => {
    const nested: DepFileChange = { ...manifest({}, { zod: "3.23.8" }), filePath: "packages/web/package.json" };
    const result = await checkDependencyChanges([nested], withLock);
    expect(result.findings.find((f) => f.code === "lockfile-drift")?.file).toBe("package-lock.json");
  });

  it("a package.json that does not parse is high", async () => {
    const result = await checkDependencyChanges([{ filePath: "package.json", changeType: "modified", oldContent: "{}", newContent: "{ nope" }]);
    expect(result.findings[0]).toMatchObject({ code: "parse-error", severity: "high" });
  });

  it("flags lockfile-only changes as low", async () => {
    const result = await checkDependencyChanges([lockChange], withLock);
    expect(result.findings).toEqual([expect.objectContaining({ code: "lockfile-only", severity: "low" })]);
    expect(result.status).toBe("passed");
  });

  it("flags a CI workflow that installs without the lockfile", async () => {
    const result = await checkDependencyChanges([
      { filePath: ".github/workflows/ci.yml", changeType: "modified", oldContent: "steps:\n", newContent: "steps:\n  - run: npm install\n" },
    ]);
    expect(result.findings[0]).toMatchObject({ code: "ci-deterministic-install", severity: "medium" });
    const ok = await checkDependencyChanges([
      { filePath: ".github/workflows/ci.yml", changeType: "modified", oldContent: "steps:\n", newContent: "steps:\n  - run: npm ci\n" },
    ]);
    expect(ok.findings).toHaveLength(0);
  });

  it("uses an injected npm audit runner; a high advisory fails the check", async () => {
    const runAudit = vi.fn(async () => ({ high: 1, critical: 0, moderate: 2 }));
    const result = await checkDependencyChanges([manifest({}, { zod: "3.23.8" }), lockChange], { ...withLock, runAudit });
    expect(runAudit).toHaveBeenCalledOnce();
    expect(result.findings.find((f) => f.code === "audit")).toMatchObject({ severity: "high" });
  });
});

describe("checkCommitDependencies", () => {
  it("skips when the base branch is not available locally", async () => {
    const git = vi.fn(async () => ({ stdout: "" }));
    const result = await checkCommitDependencies(git, { commitSha: "c".repeat(40), baseBranch: "main" });
    expect(result).toMatchObject({ status: "skipped", summary: "base branch main is not available locally" });
  });

  it("never throws when git fails mid-diff", async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse") return { stdout: "a".repeat(40) };
      throw new Error("fatal: bad object");
    });
    const result = await checkCommitDependencies(git, { commitSha: "c".repeat(40), baseBranch: "main" });
    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("bad object");
  });
});

/** Minimal RunContext for the O8 apply hooks. */
function makeCtx(opts: { approvalMode?: string; permissionMode?: string; approvalResolved?: boolean } = {}) {
  const calls: Record<string, any[]> = { requestApproval: [], autoApprove: [], applyStaged: [], logEvent: [] };
  const api = {
    autoApprove: vi.fn(async (input: any) => {
      calls.autoApprove.push(input);
      return { autoApproved: true, reason: "test", mode: opts.permissionMode ?? "supervised" };
    }),
    requestApproval: vi.fn(async (input: any) => {
      calls.requestApproval.push(input);
      return "approval_1";
    }),
    // The backend broker allows once the user approved (approval row matched).
    checkPermission: vi.fn(async () => ({ decision: opts.approvalResolved ? "allow" : "ask", reason: "test" })),
    appendAgentMessage: vi.fn(async () => undefined),
    logEvent: vi.fn(async (input: any) => {
      calls.logEvent.push(input);
    }),
    recordAudit: vi.fn(async () => undefined),
  };
  const change = {
    filePath: "package.json",
    changeType: "modified",
    oldContent: pkg({ react: "18.2.0" }),
    newContent: pkg({ react: "18.2.0", lodahs: "4.17.21" }),
    diff: "",
  };
  const ctx = {
    deps: { api, workerId: "w1", workspaceRoot: "/nonexistent-o8-root" },
    taskId: "task_1",
    project: { _id: "project_1", workspacePath: "." },
    plan: { version: 1, subtasks: [] },
    agents: [],
    reviewNodes: [],
    qaNodes: [],
    input: {
      approvalMode: opts.approvalMode ?? "ask",
      approvalResolved: opts.approvalResolved ?? false,
      planVersion: 1,
      agents: [],
      task: { _id: "task_1", command: "add lodash", ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}) },
    },
    state: {
      fileChanges: new Map([[change.filePath, change]]),
      appliedFilesBySubtask: new Map([["verify_fix_1", [change.filePath]]]),
      verification: { status: "failed" },
      feedback: [],
    },
    pendingApproval: false,
    applyStaged: vi.fn(async (changes: any[]) => {
      calls.applyStaged.push(changes);
      return { applied: changes.map((c) => c.filePath) };
    }),
  } as unknown as RunContext;
  return { ctx, calls, change };
}

describe("O8 apply hooks", () => {
  it("a high finding blocks the permission-mode auto-approval and shows on the card", async () => {
    const { ctx, calls, change } = makeCtx({ permissionMode: "full_access" });
    const status = await brokerCheckAndApply(ctx, { preparedChanges: [change as any], reviewSnapshotId: "s1", approvedVerdicts: [] });
    expect(status).toBe("waiting_approval");
    expect(calls.autoApprove).toHaveLength(0);
    expect(calls.applyStaged).toHaveLength(0);
    expect(calls.requestApproval[0].summary).toContain("Dependency check: high-risk");
    expect(calls.requestApproval[0].payload.dependencyCheck).toMatchObject({ status: "failed" });
    expect(calls.logEvent.some((e) => e.payload?.stage === "dependency_check")).toBe(true);
  });

  it("a high finding blocks the auto-approval project mode too", async () => {
    const { ctx, calls, change } = makeCtx({ approvalMode: "auto" });
    const status = await brokerCheckAndApply(ctx, { preparedChanges: [change as any], reviewSnapshotId: "s1", approvedVerdicts: [] });
    expect(status).toBe("waiting_approval");
    expect(calls.applyStaged).toHaveLength(0);
  });

  it("the user's own approval still applies a flagged change", async () => {
    const { ctx, calls, change } = makeCtx({ approvalResolved: true });
    const status = await brokerCheckAndApply(ctx, { preparedChanges: [change as any], reviewSnapshotId: "s1", approvedVerdicts: [] });
    expect(status).toBeNull();
    expect(calls.applyStaged).toHaveLength(1);
  });

  it("a verification fix with a high finding is not auto-approved", async () => {
    const { ctx, calls } = makeCtx({ permissionMode: "auto_edits" });
    const fixSubtask = { key: "verify_fix_1", capability: "frontend-development", kind: "code_change" } as any;
    const result = await applyOrRequestFixApproval(ctx, fixSubtask, "verification");
    expect(result).toBe("waiting_approval");
    expect(calls.autoApprove).toHaveLength(0);
    expect(calls.requestApproval[0].summary).toContain("Dependency check");
  });
});
