import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { setSettingOverrides } from "@/api/convex/lib/appSettings";
import { backendLocality } from "@/api/convex/lib/backendLocality";
import { loadPolicy, type ExecutionPolicy } from "@/orchestrator/policy";
import {
  DIRTY_CHECKOUT_LINE,
  decideAutoIsolation,
  hasUncommittedChanges,
  policyForIsolation,
  policyForResume,
  probeIsolation,
  resolveTaskIsolation,
  type IsolationProbe,
} from "@/services/runner/isolationPolicy";
import type { RunnerDeps } from "@/services/runner/types";

afterEach(() => setSettingOverrides({}));

const clean: IsolationProbe = { backend: "local", readiness: "ready", dirty: false };

describe("ORCHESTRATOR_WORKTREE_ISOLATION=auto: the decision", () => {
  test("turns on for a clean repo with a commit on a local or self-hosted backend", () => {
    expect(decideAutoIsolation(clean)).toEqual({ isolate: true, reason: "ready" });
    expect(decideAutoIsolation({ ...clean, backend: "self_hosted" })).toEqual({ isolate: true, reason: "ready" });
  });

  test("turns off for no git, no commits, a dirty checkout, cloud and an unknown backend", () => {
    expect(decideAutoIsolation({ backend: "local", readiness: "not_git" })).toEqual({ isolate: false, reason: "not_git" });
    expect(decideAutoIsolation({ backend: "local", readiness: "no_commits" })).toEqual({ isolate: false, reason: "no_commits" });
    expect(decideAutoIsolation({ ...clean, dirty: true })).toEqual({ isolate: false, reason: "dirty", notice: DIRTY_CHECKOUT_LINE });
    expect(decideAutoIsolation({ backend: "cloud" })).toEqual({ isolate: false, reason: "cloud_backend" });
    expect(decideAutoIsolation({ backend: "unknown" })).toEqual({ isolate: false, reason: "unknown_backend" });
    // A dirty checkout on cloud is sequential for the cloud reason: no line.
    expect(decideAutoIsolation({ backend: "cloud", readiness: "ready", dirty: true }).notice).toBeUndefined();
  });

  test("the status line copy", () => {
    expect(DIRTY_CHECKOUT_LINE).toBe("Running steps one at a time: the folder has uncommitted changes.");
  });

  test("backend locality follows the deployment URL; anything unparseable is unknown", () => {
    expect(backendLocality("http://127.0.0.1:3210")).toBe("local");
    expect(backendLocality("http://localhost:3210")).toBe("local");
    expect(backendLocality("https://happy-otter-123.convex.cloud")).toBe("cloud");
    expect(backendLocality("https://convex.example.com")).toBe("self_hosted");
    expect(backendLocality(undefined)).toBe("unknown");
    expect(backendLocality("not a url")).toBe("unknown");
  });
});

describe("ORCHESTRATOR_WORKTREE_ISOLATION=auto: parallelism", () => {
  const base = (over: Partial<ExecutionPolicy> = {}): ExecutionPolicy =>
    ({ ...loadPolicy(), worktreeIsolationAuto: true, parallelDefault: 2, ...over }) as ExecutionPolicy;

  test("on → PARALLEL_DEFAULT nodes and LLM calls; off → 1", () => {
    const on = policyForIsolation(base(), true);
    expect([on.worktreeIsolation, on.maxConcurrency, on.maxConcurrentLLMCalls]).toEqual([true, 2, 2]);
    const wide = policyForIsolation(base({ parallelDefault: 3 }), true);
    expect([wide.maxConcurrency, wide.maxConcurrentLLMCalls]).toEqual([3, 3]);
    const off = policyForIsolation(base(), false);
    expect([off.worktreeIsolation, off.maxConcurrency, off.maxConcurrentLLMCalls]).toEqual([false, 1, 1]);
  });

  test("explicit ORCHESTRATOR_MAX_CONCURRENCY / _MAX_CONCURRENT_LLM_CALLS win", () => {
    const policy = base({ maxConcurrency: 4, maxConcurrencyExplicit: true, maxConcurrentLLMCalls: 5, maxConcurrentLLMCallsExplicit: true });
    expect(policyForIsolation(policy, true)).toMatchObject({ maxConcurrency: 4, maxConcurrentLLMCalls: 5 });
    expect(policyForIsolation(policy, false)).toMatchObject({ maxConcurrency: 4, maxConcurrentLLMCalls: 5 });
  });

  test("loadPolicy: auto is the default; 1 and 0 keep their old meaning", () => {
    setSettingOverrides({ ORCHESTRATOR_WORKTREE_ISOLATION: "auto" });
    expect(loadPolicy()).toMatchObject({ worktreeIsolation: false, worktreeIsolationAuto: true, maxConcurrency: 1, maxConcurrentLLMCalls: 2, parallelDefault: 2 });
    setSettingOverrides({ ORCHESTRATOR_WORKTREE_ISOLATION: "1" });
    expect(loadPolicy()).toMatchObject({ worktreeIsolation: true, worktreeIsolationAuto: false, maxConcurrency: 2, maxConcurrentLLMCalls: 2 });
    setSettingOverrides({ ORCHESTRATOR_WORKTREE_ISOLATION: "0" });
    expect(loadPolicy()).toMatchObject({ worktreeIsolation: false, worktreeIsolationAuto: false, maxConcurrency: 1, maxConcurrentLLMCalls: 1 });
    setSettingOverrides({ ORCHESTRATOR_WORKTREE_ISOLATION: "auto" });
    vi.stubEnv("ORCHESTRATOR_MAX_CONCURRENCY", "3");
    try {
      expect(loadPolicy()).toMatchObject({ maxConcurrency: 3, maxConcurrencyExplicit: true, maxConcurrentLLMCallsExplicit: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a resumed auto task is isolated iff it has a worktree; explicit modes are untouched", () => {
    expect(policyForResume(base(), true)).toMatchObject({ worktreeIsolation: true, maxConcurrency: 2 });
    expect(policyForResume(base(), false)).toMatchObject({ worktreeIsolation: false, maxConcurrency: 1 });
    const explicitOn = base({ worktreeIsolationAuto: false, worktreeIsolation: true, maxConcurrency: 2 });
    expect(policyForResume(explicitOn, false)).toBe(explicitOn);
  });
});

describe("ORCHESTRATOR_WORKTREE_ISOLATION=auto: the worker-side probe", () => {
  test("porcelain: the task worktrees directory does not count as a change", () => {
    expect(hasUncommittedChanges("")).toBe(false);
    expect(hasUncommittedChanges("?? .moagent-worktrees/\n")).toBe(false);
    expect(hasUncommittedChanges(" M src/a.ts\n")).toBe(true);
    expect(hasUncommittedChanges("?? notes.md\n")).toBe(true);
  });

  test("cloud and unknown backends never run git", () => {
    const git = vi.fn(() => "");
    expect(probeIsolation("/nowhere", "https://x.convex.cloud", git)).toEqual({ backend: "cloud" });
    expect(probeIsolation("/nowhere", undefined, git)).toEqual({ backend: "unknown" });
    expect(git).not.toHaveBeenCalled();
  });

  test("a real folder: no git → no commits → clean → dirty", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fhara-iso-"));
    const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    try {
      const local = "http://127.0.0.1:3210";
      // A folder inside no repository (tmpdir is not one).
      expect(probeIsolation(dir, local).readiness).toBe("not_git");
      run("init", "-q");
      expect(probeIsolation(dir, local)).toEqual({ backend: "local", readiness: "no_commits" });
      writeFileSync(path.join(dir, "a.txt"), "a\n");
      run("add", "a.txt");
      run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
      expect(decideAutoIsolation(probeIsolation(dir, local)).isolate).toBe(true);
      writeFileSync(path.join(dir, "a.txt"), "changed\n");
      expect(probeIsolation(dir, local)).toEqual({ backend: "local", readiness: "ready", dirty: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ORCHESTRATOR_WORKTREE_ISOLATION=auto: per task in the runner", () => {
  function fakeDeps(policy: Partial<ExecutionPolicy>) {
    const lines: Array<{ taskId: string; content: string }> = [];
    const events: Array<{ type: string; payload: unknown }> = [];
    const deps = {
      policy: { ...loadPolicy(), parallelDefault: 2, ...policy },
      api: {
        appendSystemLine: async (args: { taskId: string; content: string }) => {
          lines.push({ taskId: args.taskId, content: args.content });
        },
        logEvent: async (args: { type: string; payload: unknown }) => {
          events.push({ type: args.type, payload: args.payload });
        },
      },
    } as unknown as RunnerDeps;
    return { deps, lines, events };
  }

  test("a dirty checkout posts the System line once per task and runs sequentially", async () => {
    const { deps, lines, events } = fakeDeps({ worktreeIsolationAuto: true });
    const dirty = () => ({ ...clean, dirty: true });
    const first = await resolveTaskIsolation(deps, { taskId: "t-dirty-1", projectId: "p", workspacePath: "/w" }, dirty);
    await resolveTaskIsolation(deps, { taskId: "t-dirty-1", projectId: "p", workspacePath: "/w" }, dirty);
    expect(first.policy).toMatchObject({ worktreeIsolation: false, maxConcurrency: 1, maxConcurrentLLMCalls: 1 });
    expect(lines).toEqual([{ taskId: "t-dirty-1", content: DIRTY_CHECKOUT_LINE }]);
    await resolveTaskIsolation(deps, { taskId: "t-dirty-2", projectId: "p", workspacePath: "/w" }, dirty);
    expect(lines.map((l) => l.taskId)).toEqual(["t-dirty-1", "t-dirty-2"]);
    expect(events[0]).toEqual({ type: "task.isolation", payload: { mode: "auto", isolate: false, reason: "dirty", maxConcurrency: 1 } });
  });

  test("a clean repo isolates this task at width 2 and posts nothing", async () => {
    const { deps, lines } = fakeDeps({ worktreeIsolationAuto: true });
    const next = await resolveTaskIsolation(deps, { taskId: "t-clean", projectId: "p", workspacePath: "/w" }, () => clean);
    expect(next.policy).toMatchObject({ worktreeIsolation: true, maxConcurrency: 2, maxConcurrentLLMCalls: 2 });
    expect(deps.policy.worktreeIsolation).toBe(false); // the worker-wide policy is not touched
    expect(lines).toEqual([]);
  });

  test("explicit 1 and 0 never probe and keep the policy as is", async () => {
    for (const worktreeIsolation of [true, false]) {
      const { deps, lines } = fakeDeps({ worktreeIsolationAuto: false, worktreeIsolation });
      const probe = vi.fn(() => clean);
      expect(await resolveTaskIsolation(deps, { taskId: "t-x", projectId: "p", workspacePath: "/w" }, probe)).toBe(deps);
      expect(probe).not.toHaveBeenCalled();
      expect(lines).toEqual([]);
    }
  });
});
