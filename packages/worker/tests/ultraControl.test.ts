import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_LLM_MAX_TOKENS,
  OpenAICompatibleProvider,
  effectiveLlmTimeoutMs,
  llmMaxTokens,
  type GlobalLLMConfig,
  type LLMCallOptions,
  type LLMProvider,
} from "@/llm";
import { llmCallEffect, type FallbackHandle } from "@/effects/llmCall";
import { Effect } from "effect";
import { canAffordRetry, executeSubtask, llmCallTimeoutMs, type SubtaskExecutionInput } from "@/execution/agentExecutor";
import { loadPolicy, policyForComplexity } from "@/orchestrator/policy";
import { classifyCommand, extractConcerns } from "@/orchestrator/classifier";
import { createPlan } from "@/orchestrator/planner";
import { splitMultiConcernNodes, splitTimedOutNodes, timedOutKeys } from "@/orchestrator/concernSplit";
import { runScheduler } from "@/scheduler/dagScheduler";
import type { AgentDefinition, ExecutionPlan, PlanSubtask } from "@/orchestrator/types";

const ULTRA = "Tambahkan dark mode dengan toggle di header, refactor header jadi komponen terpisah, tambah test, dan update README";

const ENV_KEYS = [
  "ORCHESTRATOR_LLM_MAX_TOKENS",
  "ORCHESTRATOR_LLM_TIMEOUT_MS",
  "ORCHESTRATOR_SUBTASK_TIMEOUT_MS",
  "ORCHESTRATOR_SUBTASK_TIMEOUT_HIGH_MS",
  "ORCHESTRATOR_TASK_TIMEOUT_MS",
  "ORCHESTRATOR_TASK_TIMEOUT_HIGH_MS",
];
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
});

// ─── (a) max output tokens + per-call timeout ──────────────────────────────

describe("(a) LLM max tokens and per-call timeout are configurable", () => {
  it("defaults to 8192 output tokens and honours ORCHESTRATOR_LLM_MAX_TOKENS", async () => {
    expect(DEFAULT_LLM_MAX_TOKENS).toBe(8192);
    expect(llmMaxTokens({})).toBe(8192);
    expect(llmMaxTokens({ ORCHESTRATOR_LLM_MAX_TOKENS: "16000" })).toBe(16000);

    const bodies: Array<{ max_tokens?: number }> = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    });
    const provider = new OpenAICompatibleProvider("k", "m", "http://127.0.0.1:9/v1");
    await provider.complete([{ role: "user", content: "hi" }]);
    process.env.ORCHESTRATOR_LLM_MAX_TOKENS = "12000";
    await provider.complete([{ role: "user", content: "hi" }]);
    expect(bodies.map((b) => b.max_tokens)).toEqual([8192, 12000]);
  });

  it("a per-call timeout aborts the request, bounded by ORCHESTRATOR_LLM_TIMEOUT_MS", async () => {
    process.env.ORCHESTRATOR_LLM_TIMEOUT_MS = "60000";
    expect(effectiveLlmTimeoutMs()).toBe(60000);
    expect(effectiveLlmTimeoutMs(5_000)).toBe(5_000);
    expect(effectiveLlmTimeoutMs(10 * 60_000)).toBe(60000);

    vi.stubGlobal("fetch", (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })
    );
    const provider = new OpenAICompatibleProvider("k", "m", "http://127.0.0.1:9/v1");
    const started = Date.now();
    await expect(provider.complete([{ role: "user", content: "hi" }], undefined, { timeoutMs: 50 })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("llmCallEffect forwards its timeout to the provider so the HTTP call is aborted", async () => {
    const seen: Array<LLMCallOptions | undefined> = [];
    const provider: LLMProvider = {
      complete: async (_m, _model, opts) => {
        seen.push(opts);
        return { content: "ok" };
      },
    };
    await Effect.runPromise(llmCallEffect(provider, [{ role: "user", content: "x" }], undefined, { timeoutMs: 1234 }));
    expect(seen[0]?.timeoutMs).toBe(1234);
  });

  it("an executor call is bounded by the subtask's remaining time", () => {
    const now = 1_000_000;
    expect(llmCallTimeoutMs({ deadlineAt: undefined }, now)).toBeUndefined();
    expect(llmCallTimeoutMs({ deadlineAt: now + 90_000 }, now)).toBe(88_000);
    expect(llmCallTimeoutMs({ deadlineAt: now + 500 }, now)).toBe(1_000);
  });

  it("the scheduler hands each attempt its deadline", async () => {
    let info: { deadlineAt: number } | undefined;
    const before = Date.now();
    await runScheduler(
      [{ id: "a", dependencies: [] }],
      async (_node, _signal, runInfo) => {
        info = runInfo;
        return { status: "completed" };
      },
      { maxConcurrency: 1, timeoutMs: 120_000, retries: 0, onStart: async () => undefined, onOutcome: async () => undefined }
    );
    expect(info!.deadlineAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(info!.deadlineAt).toBeLessThanOrEqual(Date.now() + 120_000);
  });
});

// ─── (b) invalid-JSON retry respects the remaining subtask time ────────────

describe("(b) invalid-JSON retry checks the remaining subtask time", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-ultra-"));
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "hello.ts"), "export const hello = 1;\n");
  });
  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const config: GlobalLLMConfig = { provider: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9", apiKey: "k" };
  function input(provider: LLMProvider, deadlineAt: number | undefined, events: unknown[]): SubtaskExecutionInput {
    const handle: FallbackHandle = { connectionId: "c", connectionName: "t", config, provider };
    return {
      workspacePath: workspace,
      command: "Update src/hello.ts",
      plan: { version: 1, goal: "g", strategy: "single", requiresApproval: false, maxConcurrency: 1, subtasks: [] },
      subtask: { key: "implement", title: "Implement", description: "Update src/hello.ts", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0 },
      agent: { _id: "a", name: "Frontend", role: "frontend", capabilities: ["frontend-development"] },
      llmHandles: [handle],
      priorOutputs: new Map(),
      fileChanges: [],
      signal: new AbortController().signal,
      deadlineAt,
      onEvent: async (type, payload) => {
        events.push({ type, ...payload });
      },
      onMessage: async () => undefined,
      onChunk: async () => undefined,
      saveFileChange: async () => undefined,
    };
  }

  it("canAffordRetry needs at least the first call's duration (+25%)", () => {
    const now = 0;
    expect(canAffordRetry(undefined, 99_999, now).ok).toBe(true);
    expect(canAffordRetry(now + 200_000, 100_000, now).ok).toBe(true);
    expect(canAffordRetry(now + 110_000, 100_000, now).ok).toBe(false);
    expect(canAffordRetry(now + 10_000, 1_000, now).ok).toBe(false);
  });

  it("skips the retry when the subtask cannot fit a second call", async () => {
    const calls: number[] = [];
    const provider: LLMProvider = {
      complete: async () => {
        calls.push(Date.now());
        return { content: "Here is my plan, not JSON." };
      },
    };
    const events: Array<Record<string, unknown>> = [];
    const result = await executeSubtask(input(provider, Date.now() + 5_000, events));
    expect(calls).toHaveLength(1);
    expect(result.status).toBe("failed");
    expect((result as { error: string }).error).toMatch(/retry skipped/);
    expect(events.some((e) => e.skipped === "insufficient-time")).toBe(true);
  });

  it("still retries once when there is time", async () => {
    let n = 0;
    const provider: LLMProvider = {
      complete: async () => {
        n += 1;
        return n === 1
          ? { content: "not json" }
          : { content: JSON.stringify({ files: [{ filePath: "src/hello.ts", newContent: "export const hello = 2;\n" }] }) };
      },
    };
    const result = await executeSubtask(input(provider, Date.now() + 10 * 60_000, []));
    expect(n).toBe(2);
    expect(result.status).not.toBe("failed");
  });
});

// ─── (c) subtask timeout configurable, larger for high/ultra ───────────────

describe("(c) subtask timeout is configurable and larger for high/ultra", () => {
  it("is no longer clamped to 300s", () => {
    process.env.ORCHESTRATOR_SUBTASK_TIMEOUT_MS = "900000";
    expect(loadPolicy().subtaskTimeoutMs).toBe(900_000);
  });

  it("high/ultra get the high timeout and deadline, low/medium keep the base", () => {
    const policy = loadPolicy();
    expect(policy.subtaskTimeoutMs).toBe(300_000);
    expect(policyForComplexity(policy, "low").subtaskTimeoutMs).toBe(300_000);
    expect(policyForComplexity(policy, "medium").subtaskTimeoutMs).toBe(300_000);
    expect(policyForComplexity(policy, "high").subtaskTimeoutMs).toBe(600_000);
    expect(policyForComplexity(policy, "ultra").subtaskTimeoutMs).toBe(600_000);
    expect(policyForComplexity(policy, "ultra").taskTimeoutMs).toBe(40 * 60_000);
    process.env.ORCHESTRATOR_SUBTASK_TIMEOUT_HIGH_MS = "1200000";
    expect(policyForComplexity(loadPolicy(), "ultra").subtaskTimeoutMs).toBe(1_200_000);
  });

  it("the ULTRA e2e prompt classifies as ultra", () => {
    expect(classifyCommand(ULTRA).complexity).toBe("ultra");
  });
});

// ─── (d) per-concern planning + timeout split ──────────────────────────────

const frontend: AgentDefinition = { _id: "f", name: "Frontend", role: "frontend", capabilities: ["frontend-development"] };
const reviewer: AgentDefinition = { _id: "r", name: "Reviewer", role: "reviewer", capabilities: ["code-review"] };
const support: AgentDefinition = { _id: "s", name: "Support", role: "support", capabilities: ["documentation-support"] };

describe("(d) multi-concern changes become one node per concern", () => {
  it("extracts the four concerns of the ULTRA prompt in order", () => {
    expect(extractConcerns(ULTRA).map((c) => c.category)).toEqual(["theme", "refactor", "tests", "docs"]);
  });

  it("the planner (fallback path) emits sequential per-concern nodes and wires review after all", async () => {
    const policy = { ...loadPolicy(), qaMode: "never" as const, reviewMode: "auto" as const };
    const result = await createPlan({ command: ULTRA, classification: classifyCommand(ULTRA), agents: [frontend, reviewer, support], policy });
    const code = result.plan.subtasks.filter((s) => s.kind === "code_change");
    expect(code.length).toBe(4);
    expect(code.map((s) => s.title.split(" — ").pop())).toEqual(["theme", "refactor", "tests", "docs"]);
    for (let i = 1; i < code.length; i += 1) expect(code[i].dependencies).toEqual([code[i - 1].key]);
    expect(code[3].capability).toBe("documentation-support");
    const review = result.plan.subtasks.find((s) => s.kind === "review");
    expect(review?.dependencies.sort()).toEqual(code.map((s) => s.key).sort());
  });

  it("an LLM node covering several concerns is split; dependents wait for every part", () => {
    const plan: ExecutionPlan = {
      version: 1,
      goal: "g",
      strategy: "dag",
      requiresApproval: true,
      maxConcurrency: 1,
      subtasks: [
        { key: "implement", title: "Dark mode + header refactor", description: "Add a dark mode toggle in the header and refactor the header into its own component", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0, allowedPaths: ["src/"] },
        { key: "tests-docs", title: "Tests and README", description: "Add tests and update README", kind: "code_change", capability: "frontend-development", dependencies: ["implement"], order: 1 },
        { key: "qa", title: "QA", description: "browser check", kind: "qa", capability: "browser-testing", dependencies: ["tests-docs"], order: 2 },
      ],
    };
    const { plan: out, split } = splitMultiConcernNodes(plan, classifyCommand(ULTRA), { maxSubtasks: 8 });
    expect(split).toEqual(["implement", "tests-docs"]);
    const keys = out.subtasks.map((s) => s.key);
    expect(keys).toEqual(["implement-theme", "implement-refactor", "tests-docs-tests", "tests-docs-docs", "qa"]);
    expect(out.subtasks[2].dependencies).toEqual(["implement-theme", "implement-refactor"]);
    expect(out.subtasks[4].dependencies).toEqual(["tests-docs-tests", "tests-docs-docs"]);
    expect(out.subtasks[0].allowedPaths).toEqual(["src/"]);
  });

  it("low/medium plans are left alone", () => {
    const plan: ExecutionPlan = {
      version: 1, goal: "g", strategy: "single", requiresApproval: true, maxConcurrency: 1,
      subtasks: [{ key: "implement", title: "Toggle + tests", description: "dark mode toggle with tests", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0 }],
    };
    expect(splitMultiConcernNodes(plan, { complexity: "medium", concerns: extractConcerns("add dark mode toggle and tests") }, { maxSubtasks: 8 }).split).toEqual([]);
  });

  it("after a timeout the replan's copy of the node is split, not retried as-is", () => {
    const node: PlanSubtask = { key: "implement-dark-mode", title: "Implement dark mode", description: "Add dark mode styles and the header toggle", kind: "code_change", capability: "frontend-development", dependencies: [], order: 0, allowedPaths: ["styles.css", "index.html", "src/header.js"] };
    const previous: ExecutionPlan = { version: 1, goal: "g", strategy: "single", requiresApproval: true, maxConcurrency: 1, subtasks: [node] };
    const summary = "implement-dark-mode (attempt 1): Subtask timed out after 600000ms";
    expect(timedOutKeys(summary)).toEqual(["implement-dark-mode"]);
    const replanned: ExecutionPlan = { ...previous, subtasks: [{ ...node }, { key: "qa", title: "QA", description: "q", kind: "qa", capability: "browser-testing", dependencies: ["implement-dark-mode"], order: 1 }] };
    const { plan, split } = splitTimedOutNodes(replanned, previous, timedOutKeys(summary), { concerns: [] }, { maxSubtasks: 8 });
    expect(split).toEqual(["implement-dark-mode"]);
    const code = plan.subtasks.filter((s) => s.kind === "code_change");
    expect(code.map((s) => s.allowedPaths)).toEqual([["styles.css"], ["index.html"], ["src/header.js"]]);
    expect(plan.subtasks.find((s) => s.key === "qa")?.dependencies).toEqual(code.map((s) => s.key));
    expect(plan.subtasks.some((s) => s.key === "implement-dark-mode")).toBe(false);
  });
});

// ─── (f) Indonesian verbs/nouns drive complexity and the review node ───────

describe("(f) Indonesian change requests: complexity and review", () => {
  it("recognises suffixed Indonesian verbs and UI nouns", () => {
    for (const command of ["Bikinin halaman about", "Buatkan tampilan profil", "Tambahkan tombol logout", "Perbaiki header", "Hapuskan footer lama"]) {
      const c = classifyCommand(command);
      expect(c.kind, command).toBe("code_change");
      expect(c.reasons, command).toContain("change request detected");
      expect(c.suggestedCapabilities[0], command).toBe("frontend-development");
    }
  });

  it("a HIGH Indonesian request gets a review node", async () => {
    const command = "Bikin halaman profil dengan form edit, ubah tampilan navbar, dan tambahkan test";
    const classification = classifyCommand(command);
    expect(classification.complexity).toBe("high");
    const policy = { ...loadPolicy(), qaMode: "never" as const, reviewMode: "auto" as const };
    const result = await createPlan({ command, classification, agents: [frontend, reviewer], policy });
    expect(result.plan.subtasks.some((s) => s.kind === "review")).toBe(true);
  });

  it("a LOW request still gets no review node", async () => {
    const command = "Ubah warna tombol jadi biru";
    const classification = classifyCommand(command);
    expect(classification.complexity).toBe("low");
    const policy = { ...loadPolicy(), qaMode: "never" as const, reviewMode: "auto" as const };
    const result = await createPlan({ command, classification, agents: [frontend, reviewer], policy });
    expect(result.plan.subtasks.some((s) => s.kind === "review")).toBe(false);
  });
});
