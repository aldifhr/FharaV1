import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyCommand, requestText, unwrapSandboxBrief } from "@/orchestrator/classifier";
import { DEFAULT_SUBTASK_TIMEOUT_MS, loadPolicy, subtaskTimeoutFor } from "@/orchestrator/policy";
import { observedLlmLatencyMs, recordLlmLatency, resetLlmLatency } from "@/llm/latency";
import { withPlanningWatchdog } from "@/services/runner/planning";
import { commitAndMergeWorktree, mergeAcceptance } from "@/services/runner/applyStage";
import { runScheduler } from "@/scheduler/dagScheduler";
import { executeSubtask, type SubtaskExecutionInput } from "@/execution/agentExecutor";
import type { SpawnImpl } from "@/execution/nativeProvider";
import type { AgentDefinition, ExecutionPlan, PlanSubtask } from "@/orchestrator/types";
import type { RunContext } from "@/services/runner/types";
import { extractRequirementsFallback } from "@/api/convex/lib/requirements";
import { sandboxInstructionSpan } from "@/api/convex/lib/sandboxBrief";
import { approvalDeciderLabel } from "../../../apps/web/lib/approvalDecider";
import { createTempGitRepo } from "./helpers/tempRepo";

/**
 * Sandbox lane fixes from live tests 3/4 (2026-11-10): classifier on the
 * user's own text, latency-aware subtask timeouts, idle bumps during
 * planning, merge only after acceptance, filename-safe requirement
 * extraction, empty code_change never "met", OpenCode file tracking.
 */

/** The Sandbox brief format (the Sandbox page is gone; tasks it started still carry this wrapper). */
function brief(instruction: string, mode: "supervised" | "auto_edits" | "full_access" = "auto_edits"): string {
  return (
    `Sandbox experiment "live" (isolated from production, ${mode} mode).\n` +
    `Instruction: ${instruction.trim()}\n` +
    "Guardrails: do not touch production code paths or secrets; never push to a remote or open a PR. Advisory time box: 30 minutes.\n" +
    "Everything you change stays in this worktree until a human approves it."
  );
}

// ─── 1. classifier reads the user's request, not the wrapper ─────────────

describe("1 classifier on the user's own text", () => {
  it('"jalankan tes" is a command run, raw and wrapped in every sandbox mode', () => {
    const raw = classifyCommand("jalankan tes");
    expect(raw.kind).toBe("command");
    expect(raw.commands).toEqual(["npm run test"]);
    for (const mode of ["supervised", "auto_edits", "full_access"] as const) {
      const wrapped = classifyCommand(brief("jalankan tes", mode));
      expect(wrapped.kind, mode).toBe("command");
      expect(wrapped.commands, mode).toEqual(["npm run test"]);
    }
  });

  it("a wrapped change request is still a code_change, and a wrapped question is not", () => {
    expect(classifyCommand(brief("tambahkan tombol reset di simple.html")).kind).toBe("code_change");
    expect(classifyCommand(brief("kenapa counter di script.js lambat?")).kind).not.toBe("code_change");
  });

  it("unwraps only the instruction, keeping attached file context after the brief", () => {
    const command = `${brief("perbaiki\nsimple.html")}\n\nAttached file context:\n--- File: a.ts ---\nx`;
    const unwrapped = unwrapSandboxBrief(command);
    expect(unwrapped.startsWith("perbaiki\nsimple.html\n\nAttached file context:")).toBe(true);
    expect(unwrapped).not.toContain("Guardrails");
    expect(requestText(command)).toBe("perbaiki\nsimple.html");
    expect(unwrapSandboxBrief("plain request")).toBe("plain request");
    const span = sandboxInstructionSpan(brief("jalankan tes"));
    expect(span && brief("jalankan tes").slice(span.start, span.end)).toBe("jalankan tes");
  });
});

// ─── 2. latency-aware subtask timeouts ─────────────────────────────────────

describe("2 subtask timeout", () => {
  const saved = process.env.ORCHESTRATOR_SUBTASK_TIMEOUT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.ORCHESTRATOR_SUBTASK_TIMEOUT_MS;
    else process.env.ORCHESTRATOR_SUBTASK_TIMEOUT_MS = saved;
    resetLlmLatency();
  });

  it("defaults to 900s and keeps the env override", () => {
    delete process.env.ORCHESTRATOR_SUBTASK_TIMEOUT_MS;
    const policy = loadPolicy();
    expect(policy.subtaskTimeoutMs).toBe(DEFAULT_SUBTASK_TIMEOUT_MS);
    expect(policy.subtaskTimeoutFromEnv).toBe(false);
    process.env.ORCHESTRATOR_SUBTASK_TIMEOUT_MS = "300000";
    const env = loadPolicy();
    expect(env.subtaskTimeoutMs).toBe(300_000);
    // An explicit value is used as-is, however slow the model is.
    expect(subtaskTimeoutFor(env, { latencyMs: 400_000 })).toBe(300_000);
  });

  it("grows with observed LLM latency (base + 4 calls) and covers the native CLI timeout", () => {
    const policy = { subtaskTimeoutMs: 900_000, subtaskTimeoutFromEnv: false };
    expect(subtaskTimeoutFor(policy, { latencyMs: 0 })).toBe(900_000);
    expect(subtaskTimeoutFor(policy, { latencyMs: 60_000 })).toBe(900_000);
    // A 6-minute-per-call model (live test 3 replans took 5-8 min).
    expect(subtaskTimeoutFor(policy, { latencyMs: 360_000 })).toBe(120_000 + 4 * 360_000);
    expect(subtaskTimeoutFor({ subtaskTimeoutMs: 300_000, subtaskTimeoutFromEnv: true }, { nativeTimeoutMs: 600_000 })).toBe(660_000);
    expect(subtaskTimeoutFor(policy, { latencyMs: 3_000_000 })).toBe(3_600_000);
  });

  it("learns latency from recorded calls (p90 of a recent window)", () => {
    resetLlmLatency();
    expect(observedLlmLatencyMs()).toBe(0);
    for (let i = 0; i < 9; i++) recordLlmLatency(10_000);
    recordLlmLatency(400_000);
    expect(observedLlmLatencyMs()).toBe(400_000);
    expect(subtaskTimeoutFor({ subtaskTimeoutMs: 900_000 })).toBe(120_000 + 4 * 400_000);
  });

  it("the scheduler honours a per-node timeout", async () => {
    vi.useFakeTimers();
    try {
      const running = runScheduler(
        [
          { id: "slow", dependencies: [] },
          { id: "fast", dependencies: [] },
        ],
        (node: { id: string }) => new Promise<{ status: "completed" }>((resolve) => setTimeout(() => resolve({ status: "completed" }), node.id === "slow" ? 2_000 : 10)),
        {
          maxConcurrency: 2,
          timeoutMs: 1_000,
          nodeTimeoutMs: (node: { id: string }) => (node.id === "slow" ? 5_000 : 1_000),
          retries: 0,
          onStart: async () => undefined,
          onOutcome: async () => [],
        } as never
      );
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await running;
      expect(result.outcomes.get("slow")?.status).toBe("completed");
      expect(result.outcomes.get("fast")?.status).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── 3. idle watchdog during planning ─────────────────────────────────────

describe("3 idle bumps during planning", () => {
  afterEach(() => vi.useRealTimers());

  it("the planning watchdog is progress-based: LLM call progress resets it", async () => {
    vi.useFakeTimers();
    const task = new AbortController();
    const result = withPlanningWatchdog(task.signal, "replanning", 60_000, async (_signal, progress) => {
      // Two slow calls of 45 s each (90 s > the 60 s watchdog), with
      // progress marked at each call boundary.
      for (let i = 0; i < 2; i++) {
        progress();
        await new Promise((resolve) => setTimeout(resolve, 45_000));
        progress();
      }
      return "plan";
    });
    await vi.advanceTimersByTimeAsync(91_000);
    await expect(result).resolves.toBe("plan");
  });
});

// ─── 4. merge only after acceptance ─────────────────────────────────────────

describe("4 merge after acceptance", () => {
  const ctxFor = (input: Record<string, unknown>) => ({ input: { task: {}, approvalMode: "ask", ...input } }) as unknown as RunContext;

  it("acceptance comes from the user's approval or an auto-accepting mode", () => {
    expect(mergeAcceptance(ctxFor({ approvalResolved: true }))).toBe("user");
    expect(mergeAcceptance(ctxFor({ task: { permissionMode: "auto_edits" } }))).toBe("auto");
    expect(mergeAcceptance(ctxFor({ task: { permissionMode: "full_access" } }))).toBe("auto");
    expect(mergeAcceptance(ctxFor({ approvalMode: "auto" }))).toBe("auto");
    expect(mergeAcceptance(ctxFor({ task: { permissionMode: "supervised" } }))).toBeNull();
  });

  it("unaccepted work is committed on its branch, never merged", async () => {
    const repo = createTempGitRepo({ prefix: "fhara-merge-", files: { "a.txt": "a\n" } });
    try {
      await fs.writeFile(path.join(repo.dir, "a.txt"), "b\n");
      const mergeBranch = vi.fn(async () => undefined);
      const events: string[] = [];
      const ctx = {
        deps: {
          api: {
            mergeBranch,
            recordTaskCommit: vi.fn(async () => undefined),
            logEvent: vi.fn(async (e: { type: string }) => void events.push(e.type)),
            appendAgentMessage: vi.fn(async () => undefined),
          },
        },
        project: { _id: "p1", mainBranch: "main" },
        plan: { version: 1, subtasks: [] },
        state: { fileChanges: new Map([["a.txt", {}]]), feedback: [] },
        input: { agents: [], task: {} },
        taskId: "t1",
        task: { title: "t" },
      } as unknown as RunContext;
      const ok = await commitAndMergeWorktree(ctx, { branchName: "task/t1", worktreePath: repo.dir }, { accepted: null });
      expect(ok).toBe(true);
      expect(mergeBranch).not.toHaveBeenCalled();
      expect(events).toContain("branch.merge_deferred");
      await commitAndMergeWorktree(ctx, { branchName: "task/t1", worktreePath: repo.dir }, { accepted: "auto" });
      expect(mergeBranch).toHaveBeenCalledTimes(1);
      expect(events).toContain("branch.merged");
    } finally {
      await fs.rm(repo.dir, { recursive: true, force: true });
    }
  });

  it("an auto approval is labelled Auto, never You", () => {
    expect(approvalDeciderLabel("auto")).toBe("Auto");
    expect(approvalDeciderLabel("user")).toBe("You");
    expect(approvalDeciderLabel(undefined)).toBe("You");
  });
});

// ─── 5. requirements keep file names whole ─────────────────────────────────

describe("5 requirement extraction keeps file names", () => {
  it("does not split on dots inside file names", () => {
    const texts = extractRequirementsFallback("Buat simple.html + style.css + script.js dengan counter. Tambahkan tombol reset.").map((r) => r.text);
    expect(texts).toEqual(["Buat simple.html + style.css + script.js dengan counter", "Tambahkan tombol reset"]);
    for (const text of texts) expect(text).not.toMatch(/^(html|css|js)\b/);
  });

  it("still splits real sentences", () => {
    const texts = extractRequirementsFallback("Add a login page. Fix the header! Update v1.2 notes?").map((r) => r.text);
    expect(texts).toEqual(["Add a login page", "Fix the header", "Update v1.2 notes"]);
  });
});

// ─── 7. OpenCode file tracking ─────────────────────────────────────────────

const PLAN: ExecutionPlan = { version: 1, goal: "g", strategy: "single", requiresApproval: false, maxConcurrency: 1, subtasks: [] };
const SUBTASK: PlanSubtask = {
  key: "impl",
  title: "Implement",
  description: "Create simple.html",
  kind: "code_change",
  capability: "frontend-development",
  dependencies: [],
  order: 0,
};

describe("7 OpenCode writes are recorded even when the run fails", () => {
  let ws: string;
  beforeEach(() => {
    ws = createTempGitRepo({ prefix: "fhara-oc-track-", files: { "README.md": "readme\n" } }).dir;
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("stages the files a failed/timed-out OpenCode run left in the worktree", async () => {
    const spawnImpl: SpawnImpl = async (_c, _a, opts) => {
      await fs.writeFile(path.join(opts.cwd, "simple.html"), "<p>hi</p>\n");
      await fs.writeFile(path.join(opts.cwd, "style.css"), "p{}\n");
      return { stdout: "", stderr: "killed", code: 1 };
    };
    const saved: string[] = [];
    const agent: AgentDefinition = { _id: "a1", name: "FE", role: "frontend", executionRuntime: "opencode" };
    const input: SubtaskExecutionInput = {
      workspacePath: ws,
      command: "Create simple.html",
      plan: PLAN,
      subtask: SUBTASK,
      agent,
      llmConfig: { provider: "openai-compatible", model: "nous", baseUrl: "http://llm.local/v1", apiKey: "k" },
      runtime: "native-provider",
      nativeProviderCommand: process.execPath,
      nativeSpawnImpl: spawnImpl,
      priorOutputs: new Map(),
      fileChanges: [],
      signal: new AbortController().signal,
      onEvent: async () => undefined,
      onMessage: async () => undefined,
      onChunk: async () => undefined,
      saveFileChange: async (c) => void saved.push(`${c.filePath}:${c.changeType}`),
    };
    const result = await executeSubtask(input);
    expect(result.status).toBe("failed");
    expect(saved.sort()).toEqual(["simple.html:new", "style.css:new"]);
  });
});
