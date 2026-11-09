import { describe, expect, it } from "vitest";
import {
  buildAgentExecutionContext,
  formatAgentContextForPrompt,
  formatSiblingsSection,
  type SiblingSubtask,
} from "@/execution/agentContext";
import { createSiblingTracker } from "@/services/runner/runNodes";
import { nodesConflict, runScheduler, type SchedulerNode } from "@/scheduler/dagScheduler";
import { assertPushAllowed, pushCommitToGithub, type ExecGit } from "@/tools/gitPush";
import { defaultParallelism } from "@/orchestrator/policy";
import type { PlanSubtask } from "@/types";

const sibling = (over: Partial<SiblingSubtask> = {}): SiblingSubtask => ({
  key: "s1",
  role: "frontend",
  title: "Build the login form",
  allowedPaths: ["apps/web/app/login"],
  status: "running",
  ...over,
});

describe("Running alongside you section", () => {
  it("lists role, title, owned files and status plus the ownership rule", () => {
    const text = formatSiblingsSection([
      sibling({ status: "queued", key: "s2", role: "backend", title: "Auth API", allowedPaths: ["apps/api/convex/auth.ts"] }),
      sibling(),
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^Running alongside you/);
    // Running siblings come first.
    expect(lines[1]).toBe("- [running] frontend: Build the login form — owns apps/web/app/login");
    expect(lines[2]).toBe("- [queued] backend: Auth API — owns apps/api/convex/auth.ts");
    expect(text).toMatch(/Do not edit files owned by another subtask/);
    expect(text).toMatch(/escalation|ask/);
  });

  it("is empty with no siblings", () => {
    expect(formatSiblingsSection(undefined)).toBe("");
    expect(formatSiblingsSection([])).toBe("");
  });

  it("stays token-bounded", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      sibling({
        key: `k${i}`,
        title: `A very long title that keeps going ${"x".repeat(200)}`,
        allowedPaths: Array.from({ length: 20 }, (_, j) => `apps/web/very/deep/path/${i}/${j}.ts`),
      })
    );
    const text = formatSiblingsSection(many);
    expect(text.length).toBeLessThanOrEqual(1_200 + 60);
    expect(text).toMatch(/\(\+\d+ more not listed\)/);
    expect(text).toMatch(/\(\+16 more\)/);
    expect(text).toMatch(/Do not edit files owned/);
  });

  it("marks unscoped siblings", () => {
    expect(formatSiblingsSection([sibling({ allowedPaths: undefined })])).toMatch(/owns no declared files/);
  });

  it("is rendered into the agent prompt", () => {
    const ctx = buildAgentExecutionContext({
      taskContext: {
        taskId: "t1",
        classification: { suggestedCapabilities: [] },
        agentExecutions: [],
        artifacts: [],
        outstandingIssues: [],
        decisions: [],
      } as never,
      agent: { _id: "a1", name: "Frontend", role: "frontend", capabilities: [] } as never,
      assignment: "x",
      siblings: [sibling()],
    });
    expect(formatAgentContextForPrompt(ctx)).toMatch(/Running alongside you[\s\S]*\[running\] frontend: Build the login form/);
  });
});

describe("sibling tracker", () => {
  const sub = (key: string, paths?: string[]): PlanSubtask =>
    ({ key, title: `T ${key}`, description: "", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0, allowedPaths: paths }) as PlanSubtask;

  it("reports running / queued and drops self, settled and completed", () => {
    const tracker = createSiblingTracker(["a", "b", "c", "d"]);
    const plan = [sub("a", ["x"]), sub("b"), sub("c"), sub("d"), sub("outside")];
    tracker.started("a");
    tracker.started("b");
    tracker.settled("b");
    const completed = new Set(["d"]);
    const list = tracker.siblingsOf("c", plan, completed, (key) => (key === "a" ? "frontend" : undefined));
    expect(list).toEqual([
      { key: "a", role: "frontend", title: "T a", allowedPaths: ["x"], status: "running" },
    ]);
    const forA = tracker.siblingsOf("a", plan, completed, () => undefined);
    expect(forA.map((s) => [s.key, s.status, s.role])).toEqual([["c", "queued", "frontend-development"]]);
  });
});

describe("conflict guard (overlap serialization)", () => {
  const run = async (graph: SchedulerNode[], maxConcurrency = 3) => {
    const active = new Set<string>();
    const pairs: string[] = [];
    let peak = 0;
    const result = await runScheduler(
      graph,
      async (node) => {
        for (const other of active) pairs.push([node.id, other].sort().join("+"));
        active.add(node.id);
        peak = Math.max(peak, active.size);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active.delete(node.id);
        return { status: "completed" };
      },
      { maxConcurrency, timeoutMs: 2000, retries: 0, onStart: async () => undefined, onOutcome: async () => undefined }
    );
    return { result, pairs, peak };
  };

  it("serializes two ready nodes with overlapping allowedPaths", async () => {
    const { result, pairs, peak } = await run([
      { id: "a", dependencies: [], paths: ["apps/web/lib"], writes: true },
      { id: "b", dependencies: [], paths: ["apps/web/lib/auth.ts"], writes: true },
      { id: "c", dependencies: [], paths: ["apps/api"], writes: true },
    ]);
    expect(result.status).toBe("completed");
    expect(pairs).not.toContain("a+b");
    expect(peak).toBe(2);
  });

  it("serializes two unscoped writers but lets unscoped readers overlap", async () => {
    const writers = await run([
      { id: "w1", dependencies: [], writes: true },
      { id: "w2", dependencies: [], writes: true },
    ]);
    expect(writers.peak).toBe(1);
    const readers = await run([
      { id: "r1", dependencies: [] },
      { id: "r2", dependencies: [] },
    ]);
    expect(readers.peak).toBe(2);
  });

  it("nodesConflict rules", () => {
    expect(nodesConflict({ id: "a", dependencies: [], paths: ["a"] }, { id: "b", dependencies: [], paths: ["b"] })).toBe(false);
    expect(nodesConflict({ id: "a", dependencies: [], paths: ["a"] }, { id: "b", dependencies: [] })).toBe(true);
    expect(nodesConflict({ id: "a", dependencies: [], writes: true }, { id: "b", dependencies: [], writes: false })).toBe(false);
    expect(nodesConflict({ id: "a", dependencies: [] }, undefined)).toBe(false);
  });
});

describe("push guard", () => {
  it("blocks the base branch and main/master unless allowed", () => {
    expect(() => assertPushAllowed({ branchName: "develop", baseBranch: "develop", allowBaseBranch: false })).toThrow(/base branch/);
    expect(() => assertPushAllowed({ branchName: "main", allowBaseBranch: false })).toThrow(/base branch/);
    expect(() => assertPushAllowed({ branchName: "refs/heads/master", allowBaseBranch: false })).toThrow(/base branch/);
    expect(() => assertPushAllowed({ branchName: "main", allowBaseBranch: true })).not.toThrow();
    expect(() => assertPushAllowed({ branchName: "fhara/t1/x", baseBranch: "main" })).not.toThrow();
  });

  it("blocks force pushes unless allowed", () => {
    expect(() => assertPushAllowed({ branchName: "fhara/t1/x", force: true, allowForce: false })).toThrow(/force push/);
    expect(() => assertPushAllowed({ branchName: "fhara/t1/x", force: true, allowForce: true })).not.toThrow();
  });

  it("honors the env overrides", () => {
    const prev = { b: process.env.FHARA_ALLOW_BASE_BRANCH_PUSH, f: process.env.FHARA_ALLOW_FORCE_PUSH };
    try {
      process.env.FHARA_ALLOW_BASE_BRANCH_PUSH = "true";
      process.env.FHARA_ALLOW_FORCE_PUSH = "1";
      expect(() => assertPushAllowed({ branchName: "main", baseBranch: "main", force: true })).not.toThrow();
    } finally {
      if (prev.b === undefined) delete process.env.FHARA_ALLOW_BASE_BRANCH_PUSH; else process.env.FHARA_ALLOW_BASE_BRANCH_PUSH = prev.b;
      if (prev.f === undefined) delete process.env.FHARA_ALLOW_FORCE_PUSH; else process.env.FHARA_ALLOW_FORCE_PUSH = prev.f;
    }
  });

  it("pushCommitToGithub never runs git push to the base branch", async () => {
    const calls: string[][] = [];
    const execGit: ExecGit = async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    };
    const base = { repoPath: "/r", owner: "o", repo: "r", commitSha: "abcdef1", token: "t", execGit };
    await expect(pushCommitToGithub({ ...base, branchName: "release", baseBranch: "release" })).rejects.toThrow(/Push blocked/);
    await expect(pushCommitToGithub({ ...base, branchName: "fhara/t1/x", force: true })).rejects.toThrow(/Push blocked/);
    expect(calls.some((args) => args[0] === "push")).toBe(false);
    await pushCommitToGithub({ ...base, branchName: "fhara/t1/x", baseBranch: "main" });
    const push = calls.find((args) => args[0] === "push")!;
    expect(push[push.length - 1]).toBe("abcdef1:refs/heads/fhara/t1/x");
  });
});

describe("parallel default", () => {
  it("is sequential without worktree isolation and 2 with it (env 1–3)", () => {
    const prev = process.env.ORCHESTRATOR_PARALLEL_DEFAULT;
    try {
      delete process.env.ORCHESTRATOR_PARALLEL_DEFAULT;
      expect(defaultParallelism(false)).toBe(1);
      expect(defaultParallelism(true)).toBe(2);
      process.env.ORCHESTRATOR_PARALLEL_DEFAULT = "9";
      expect(defaultParallelism(true)).toBe(3);
      expect(defaultParallelism(false)).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.ORCHESTRATOR_PARALLEL_DEFAULT; else process.env.ORCHESTRATOR_PARALLEL_DEFAULT = prev;
    }
  });
});
