import { promises as fs, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_PROMPT_MESSAGE,
  OPENCODE_KEY_ENV,
  buildOpencodeConfig,
  executionRuntimeFromEnv,
  nativeArgv,
  nativeTimeoutMs,
  parseOpencodeEvent,
  resolveExecutionRuntime,
  runNativeProvider,
  type SpawnImpl,
} from "@/execution/nativeProvider";
import { executeSubtask, type SubtaskExecutionInput } from "@/execution/agentExecutor";
import type { AgentDefinition, ExecutionPlan, PlanSubtask } from "@/orchestrator/types";
import { spawnReturning } from "./helpers/spawn";
import { createTempGitRepo } from "./helpers/tempRepo";

const SECRET = "sk-test-SECRET-value-123456";
const LLM = { provider: "openai-compatible", model: "nous", baseUrl: "http://llm.local:20128/v1", apiKey: SECRET };

// Real `opencode run --format json` lines (opencode-ai 1.19.5), trimmed.
const EVENTS = [
  { type: "step_start", sessionID: "s", part: { type: "step-start" } },
  {
    type: "tool_use",
    sessionID: "s",
    part: {
      type: "tool",
      tool: "write",
      callID: "c1",
      state: { status: "completed", input: { filePath: "/w/hello.txt", content: "hi" }, output: "Wrote file successfully.", title: "hello.txt" },
    },
  },
  { type: "step_finish", sessionID: "s", part: { type: "step-finish", reason: "tool-calls", tokens: { total: 12094, input: 12079, output: 15, reasoning: 0, cache: { write: 0, read: 0 } } } },
  { type: "text", sessionID: "s", part: { type: "text", text: "done" } },
  { type: "step_finish", sessionID: "s", part: { type: "step-finish", reason: "stop", tokens: { total: 7357, input: 7352, output: 4, reasoning: 1 } } },
].map((e) => JSON.stringify(e));

describe("opencode argv + config", () => {
  it("builds argv with --format json, --auto and -m, message before -f", () => {
    const { args } = nativeArgv("opencode", [NATIVE_PROMPT_MESSAGE, "-f", "/tmp/p.md"], { model: "openrouter/anthropic/claude" });
    expect(args).toEqual(["run", "--format", "json", "--auto", "-m", "openrouter/anthropic/claude", NATIVE_PROMPT_MESSAGE, "-f", "/tmp/p.md"]);
    expect(nativeArgv("opencode", ["m"], { json: false, auto: false }).args).toEqual(["run", "m"]);
  });

  it("generates a Fhara provider config that references the key via env only", () => {
    const { config, model, env } = buildOpencodeConfig({ llm: LLM });
    expect(model).toBe("fhara/nous");
    expect(env).toEqual({ [OPENCODE_KEY_ENV]: SECRET });
    const provider = (config.provider as Record<string, any>).fhara;
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.options.baseURL).toBe(LLM.baseUrl);
    expect(provider.options.apiKey).toBe(`{env:${OPENCODE_KEY_ENV}}`);
    expect(provider.models).toHaveProperty("nous");
    expect(JSON.stringify(config)).not.toContain(SECRET);
    expect((config.permission as any).external_directory).toBe("deny");
  });

  it("an explicit OpenCode model wins and carries no Fhara provider/key", () => {
    const { config, model, env } = buildOpencodeConfig({ model: " anthropic/claude-sonnet ", llm: LLM });
    expect(model).toBe("anthropic/claude-sonnet");
    expect(env).toEqual({});
    expect(config.provider).toBeUndefined();
  });

  it("falls back to OpenCode's default model for unsupported providers", () => {
    const { model, config } = buildOpencodeConfig({ llm: { ...LLM, provider: "bedrock" } });
    expect(model).toBeUndefined();
    expect(config.provider).toBeUndefined();
  });

  it("writes the temp config 0600, passes key only via env, deletes it after", async () => {
    let seen: { args: string[]; env: NodeJS.ProcessEnv | undefined; configPath?: string; mode?: number; content?: string } = { args: [], env: undefined };
    const spawnImpl: SpawnImpl = async (_cmd, args, opts) => {
      const configPath = opts.env?.OPENCODE_CONFIG;
      seen = {
        args,
        env: opts.env,
        configPath,
        mode: configPath ? statSync(configPath).mode & 0o777 : undefined,
        content: configPath ? await fs.readFile(configPath, "utf-8") : undefined,
      };
      return { stdout: EVENTS.join("\n"), stderr: "", code: 0 };
    };
    const result = await runNativeProvider({ workspacePath: os.tmpdir(), prompt: "p", llm: LLM, spawnImpl });
    expect(result.status).toBe("completed");
    expect(result.model).toBe("fhara/nous");
    expect(seen.args).toContain("-m");
    expect(seen.args[seen.args.indexOf("-m") + 1]).toBe("fhara/nous");
    expect(seen.args.join(" ")).not.toContain(SECRET);
    expect(seen.env?.[OPENCODE_KEY_ENV]).toBe(SECRET);
    // Pinned to the worktree: OpenCode prefers $PWD over cwd.
    expect(seen.args[seen.args.indexOf("--dir") + 1]).toBe(os.tmpdir());
    expect(seen.env?.PWD).toBe(os.tmpdir());
    expect(seen.content).toBeDefined();
    expect(seen.content).not.toContain(SECRET);
    if (process.platform !== "win32") expect(seen.mode).toBe(0o600);
    await expect(fs.stat(seen.configPath!)).rejects.toThrow();
  });
});

describe("opencode JSON events", () => {
  it("parses text, tool, step_finish and error events", () => {
    expect(parseOpencodeEvent(EVENTS[3])).toEqual({ kind: "text", text: "done" });
    expect(parseOpencodeEvent(EVENTS[1])).toMatchObject({ kind: "tool", tool: "write", status: "completed", target: "/w/hello.txt", title: "hello.txt" });
    expect(parseOpencodeEvent(EVENTS[2])).toMatchObject({ kind: "step_finish", inputTokens: 12079, outputTokens: 15 });
    expect(
      parseOpencodeEvent(JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "Not Found" } } }))
    ).toEqual({ kind: "error", message: "Not Found" });
    expect(parseOpencodeEvent("plain text line")).toBeNull();
  });

  it("streams text to onChunk, tools to onEvent, sums tokens (chunks split mid-line)", async () => {
    const chunks: string[] = [];
    const events: Array<[string, Record<string, unknown>]> = [];
    const messages: string[] = [];
    const all = EVENTS.join("\n") + "\n";
    const spawnImpl: SpawnImpl = async (_c, _a, opts) => {
      for (let i = 0; i < all.length; i += 37) opts.onStdout?.(all.slice(i, i + 37));
      return { stdout: all, stderr: "", code: 0 };
    };
    const result = await runNativeProvider({
      workspacePath: os.tmpdir(),
      prompt: "p",
      spawnImpl,
      onChunk: async (d) => void chunks.push(d),
      onEvent: async (t, p) => void events.push([t, p]),
      onMessage: async (m) => void messages.push(m),
    });
    expect(result.status).toBe("completed");
    expect(result.output).toBe("done");
    expect(result.inputTokens).toBe(12079 + 7352);
    expect(result.outputTokens).toBe(15 + 4 + 1);
    // Whole text parts, newline-terminated so parts stay on their own lines.
    expect(chunks).toEqual(["done\n"]);
    expect(messages).toEqual(["done"]);
    const tool = events.find(([t]) => t === "native.tool");
    expect(tool?.[1]).toMatchObject({ tool: "write", status: "completed" });
    expect(JSON.stringify(tool?.[1])).not.toContain("Wrote file");
  });

  it("an error event fails the run even with exit 0, and redacts the key", async () => {
    const spawnImpl: SpawnImpl = async () => ({
      stdout: JSON.stringify({ type: "error", error: { data: { message: `bad key ${SECRET}` } } }),
      stderr: "",
      code: 0,
    });
    const result = await runNativeProvider({ workspacePath: os.tmpdir(), prompt: "p", llm: LLM, spawnImpl });
    expect(result.status).toBe("failed");
    expect(result.output).toContain("bad key");
    expect(result.output).not.toContain(SECRET);
  });

  it("falls back to plain text output", async () => {
    const spawnImpl: SpawnImpl = spawnReturning({ stdout: "Changed a.ts\nAll good\n" });
    const result = await runNativeProvider({ workspacePath: os.tmpdir(), prompt: "p", spawnImpl });
    expect(result.status).toBe("completed");
    expect(result.output).toBe("Changed a.ts\nAll good");
  });
});

describe("runtime selection", () => {
  it("per-agent runtime overrides the global default", () => {
    expect(resolveExecutionRuntime({ executionRuntime: "opencode" }, "api")).toBe("native-provider");
    expect(resolveExecutionRuntime({ executionRuntime: "api" }, "native-provider")).toBe("api");
    expect(resolveExecutionRuntime({}, "native-provider")).toBe("native-provider");
    expect(resolveExecutionRuntime({}, undefined)).toBe("api");
    expect(resolveExecutionRuntime(undefined, "api")).toBe("api");
  });

  it("reads the global default from env (new name wins, opencode alias)", () => {
    expect(executionRuntimeFromEnv({})).toBe("api");
    expect(executionRuntimeFromEnv({ ORCHESTRATOR_EXECUTION_RUNTIME: "opencode" })).toBe("native-provider");
    expect(executionRuntimeFromEnv({ ORCHESTRATOR_RUNTIME: "native-provider" })).toBe("native-provider");
    expect(executionRuntimeFromEnv({ ORCHESTRATOR_EXECUTION_RUNTIME: "api", ORCHESTRATOR_RUNTIME: "native-provider" })).toBe("api");
    expect(nativeTimeoutMs({})).toBe(600_000);
    expect(nativeTimeoutMs({ ORCHESTRATOR_NATIVE_TIMEOUT_MS: "1500" })).toBe(1500);
    expect(nativeTimeoutMs({ ORCHESTRATOR_NATIVE_TIMEOUT_MS: "nope" })).toBe(600_000);
  });
});

describe("timeout + process tree kill", () => {
  it("aborts the injected spawn on timeout and reports timedOut", async () => {
    let aborted = false;
    const spawnImpl: SpawnImpl = (_c, _a, opts) =>
      new Promise((resolve) => {
        opts.signal?.addEventListener("abort", () => {
          aborted = true;
          resolve({ stdout: "", stderr: "", code: null });
        });
      });
    const result = await runNativeProvider({ workspacePath: os.tmpdir(), prompt: "p", spawnImpl, timeoutMs: 30 });
    expect(aborted).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.timedOut).toBe(true);
    expect(result.output).toMatch(/timed out after 30ms/);
  });

  it.skipIf(process.platform === "win32")("kills the real process tree on timeout (stdin closed)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-oc-kill-"));
    const script = path.join(dir, "fake-opencode");
    // Proves stdin is closed (cat returns), then spawns a grandchild and hangs.
    await fs.writeFile(
      script,
      `#!/bin/sh\ncat > /dev/null\nsleep 30 &\necho $! > "${dir}/grandchild.pid"\necho '{"type":"text","part":{"text":"started"}}'\nwait\n`,
      { mode: 0o755 }
    );
    const started = Date.now();
    const result = await runNativeProvider({ workspacePath: dir, prompt: "p", command: script, timeoutMs: 1500 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.timedOut).toBe(true);
    const pid = Number((await fs.readFile(path.join(dir, "grandchild.pid"), "utf-8")).trim());
    await new Promise((r) => setTimeout(r, 100));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ── executor-level: per-agent model + staging gate ───────────────────

const PLAN: ExecutionPlan = { version: 1, goal: "g", strategy: "single", requiresApproval: false, maxConcurrency: 1, subtasks: [] };
const SUBTASK: PlanSubtask = {
  key: "impl",
  title: "Implement",
  description: "Update src/a.ts",
  kind: "code_change",
  capability: "frontend-development",
  dependencies: [],
  order: 0,
  allowedPaths: ["src"],
};

describe("executeSubtask on the OpenCode runtime", () => {
  let ws: string;
  beforeEach(async () => {
    ws = createTempGitRepo({
      prefix: "fhara-oc-exec-",
      files: { "src/a.ts": "export const a = 1;\n", "README.md": "readme\n" },
    }).dir;
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  function input(agent: AgentDefinition, spawnImpl: SpawnImpl, extra: Partial<SubtaskExecutionInput> = {}) {
    const saved: string[] = [];
    const events: string[] = [];
    const base: SubtaskExecutionInput = {
      workspacePath: ws,
      command: "Update src/a.ts",
      plan: PLAN,
      subtask: SUBTASK,
      agent,
      llmConfig: LLM,
      runtime: "native-provider",
      // `node --version` passes the cached availability probe.
      nativeProviderCommand: process.execPath,
      nativeModel: agent.opencodeModel,
      nativeSpawnImpl: spawnImpl,
      priorOutputs: new Map(),
      fileChanges: [],
      signal: new AbortController().signal,
      onEvent: async (t) => void events.push(t),
      onMessage: async () => undefined,
      onChunk: async () => undefined,
      saveFileChange: async (c) => void saved.push(c.filePath),
      ...extra,
    };
    return { base, saved, events };
  }

  it("stages in-scope changes and reverts out-of-scope/forbidden writes", async () => {
    let argv: string[] = [];
    const spawnImpl: SpawnImpl = async (_c, args, opts) => {
      argv = args;
      await fs.writeFile(path.join(opts.cwd, "src", "a.ts"), "export const a = 2;\n");
      await fs.writeFile(path.join(opts.cwd, "src", "b.ts"), "export const b = 1;\n");
      await fs.writeFile(path.join(opts.cwd, "README.md"), "hijacked\n");
      await fs.writeFile(path.join(opts.cwd, ".env"), "LEAK=1\n");
      return { stdout: EVENTS.join("\n"), stderr: "", code: 0 };
    };
    const agent: AgentDefinition = { _id: "a1", name: "FE", role: "frontend", executionRuntime: "opencode" };
    const { base, saved, events } = input(agent, spawnImpl);
    const result = await executeSubtask(base);
    expect(result.status).toBe("completed");
    expect(argv[argv.indexOf("-m") + 1]).toBe("fhara/nous");
    expect(saved.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(await fs.readFile(path.join(ws, "README.md"), "utf-8")).toBe("readme\n");
    await expect(fs.stat(path.join(ws, ".env"))).rejects.toThrow();
    expect(events).toContain("native.change.rejected");
    expect(result.meta).toMatchObject({ runtime: "native-provider", model: "fhara/nous" });
  });

  it("uses the agent's OpenCode model when set", async () => {
    let argv: string[] = [];
    let env: NodeJS.ProcessEnv | undefined;
    const spawnImpl: SpawnImpl = async (_c, args, opts) => {
      argv = args;
      env = opts.env;
      return { stdout: EVENTS.join("\n"), stderr: "", code: 0 };
    };
    const agent: AgentDefinition = { _id: "a2", name: "BE", role: "backend", executionRuntime: "opencode", opencodeModel: "anthropic/claude-sonnet-4" };
    const { base } = input(agent, spawnImpl);
    const onTokenUsage = vi.fn(async () => undefined);
    await executeSubtask({ ...base, onTokenUsage });
    expect(argv[argv.indexOf("-m") + 1]).toBe("anthropic/claude-sonnet-4");
    expect(env?.[OPENCODE_KEY_ENV]).toBeUndefined();
    expect(onTokenUsage).toHaveBeenCalledWith(19431, 20, "anthropic/claude-sonnet-4", undefined);
  });

  it("reverts every write from a read-only subtask", async () => {
    const spawnImpl: SpawnImpl = async (_c, _a, opts) => {
      await fs.writeFile(path.join(opts.cwd, "src", "a.ts"), "mutated\n");
      return { stdout: "analysis done", stderr: "", code: 0 };
    };
    const agent: AgentDefinition = { _id: "a3", name: "R", role: "research" };
    const { base, saved } = input(agent, spawnImpl, { subtask: { ...SUBTASK, kind: "analysis" } });
    const result = await executeSubtask(base);
    expect(result.status).toBe("completed");
    expect(saved).toEqual([]);
    expect(await fs.readFile(path.join(ws, "src", "a.ts"), "utf-8")).toBe("export const a = 1;\n");
  });
});
