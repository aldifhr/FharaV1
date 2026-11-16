import { describe, expect, it } from "vitest";
import {
  codexArgv,
  codexGateFor,
  isCodexAvailable,
  nativeDriverFromEnv,
  parseCodexEvent,
  parseCodexUsage,
  runCodexProvider,
  type CodexSpawnImpl,
} from "@/execution/codexProvider";

const line = (value: unknown) => JSON.stringify(value);

describe("parseCodexEvent", () => {
  it("reads an agent message only once it is complete", () => {
    expect(parseCodexEvent(line({ type: "item.started", item: { type: "agent_message", text: "hi" } }))).toEqual({
      kind: "other",
      type: "item.started",
    });
    expect(parseCodexEvent(line({ type: "item.completed", item: { type: "agent_message", text: "hi" } }))).toEqual({
      kind: "text",
      text: "hi",
    });
  });

  it("maps shell, patch, MCP and web items to short tool events", () => {
    expect(
      parseCodexEvent(
        line({ type: "item.started", item: { type: "command_execution", command: "npm test -- --run" } })
      )
    ).toMatchObject({ kind: "tool", tool: "shell", status: "running", target: "npm test -- --run" });
    expect(
      parseCodexEvent(
        line({
          type: "item.completed",
          item: { type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }, { path: "src/b.ts" }] },
        })
      )
    ).toMatchObject({ kind: "tool", tool: "apply_patch", status: "completed", target: "src/a.ts, src/b.ts" });
    expect(
      parseCodexEvent(line({ type: "item.completed", item: { type: "mcp_tool_call", server: "fs", tool: "read" } }))
    ).toMatchObject({ kind: "tool", tool: "mcp:fs/read", status: "completed" });
    expect(
      parseCodexEvent(line({ type: "item.completed", item: { type: "web_search", query: "convex docs" } }))
    ).toMatchObject({ kind: "tool", tool: "web_search", target: "convex docs" });
  });

  it("treats input tokens as total (cached is a subset) like Codex reports them", () => {
    const event = parseCodexEvent(
      line({
        type: "turn.completed",
        usage: { input_tokens: 900, cached_input_tokens: 400, output_tokens: 120, reasoning_output_tokens: 30 },
      })
    );
    expect(event).toEqual({
      kind: "step_finish",
      inputTokens: 900,
      outputTokens: 120,
      cachedInputTokens: 400,
      reasoningTokens: 30,
    });
  });

  it("reads failures from error and turn.failed", () => {
    expect(parseCodexEvent(line({ type: "error", message: "boom" }))).toEqual({ kind: "error", message: "boom" });
    expect(parseCodexEvent(line({ type: "turn.failed", error: { message: "bad key" } }))).toEqual({
      kind: "error",
      message: "bad key",
    });
  });

  it("ignores non-JSON output", () => {
    expect(parseCodexEvent("Codex v0.169.0")).toBeNull();
    expect(parseCodexEvent("")).toBeNull();
  });
});

describe("codexArgv", () => {
  it("runs exec in JSON mode at full access, reads the prompt from stdin, and only adds -m when set", () => {
    expect(codexArgv()).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--color",
      "never",
      "-s",
      "danger-full-access",
      "-",
    ]);
    expect(codexArgv({ model: " gpt-5-codex " })).toContain("gpt-5-codex");
  });
});

describe("nativeDriverFromEnv", () => {
  it("defaults to opencode and accepts codex", () => {
    expect(nativeDriverFromEnv({})).toBe("opencode");
    expect(nativeDriverFromEnv({ ORCHESTRATOR_NATIVE_DRIVER: "codex" })).toBe("codex");
  });
});

describe("codexGateFor", () => {
  it("refuses when Codex is missing", () => {
    expect(codexGateFor({ available: false, worktreeIsolation: true })).toEqual({
      available: false,
      reason: "Codex CLI not detected on this worker",
    });
  });

  it("refuses without worktree isolation unless the explicit opt-out is set", () => {
    expect(codexGateFor({ available: true, worktreeIsolation: false, env: {} }).available).toBe(false);
    expect(
      codexGateFor({
        available: true,
        worktreeIsolation: false,
        env: { ORCHESTRATOR_OPENCODE_ALLOW_UNISOLATED: "1" },
      })
    ).toEqual({ available: true });
  });

  it("allows a detected Codex with isolation", () => {
    expect(codexGateFor({ available: true, worktreeIsolation: true })).toEqual({ available: true });
  });
});

describe("runCodexProvider", () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const chunks: string[] = [];
  const spawnWith = (lines: string[], code = 0): CodexSpawnImpl => (_command, _args, options) => {
    const stdout = `${lines.join("\n")}\n`;
    options.onStdout?.(stdout);
    return Promise.resolve({ stdout, stderr: "", code });
  };
  const run = (spawnImpl: CodexSpawnImpl, signal?: AbortSignal) =>
    runCodexProvider({
      workspacePath: process.cwd(),
      prompt: "do the thing",
      spawnImpl,
      timeoutMs: 5_000,
      ...(signal ? { signal } : {}),
      onEvent: (type, payload) => {
        events.push({ type, payload });
      },
      onChunk: (text) => {
        chunks.push(text);
      },
    });

  it("streams text, tool events and usage, then reports a completed run", async () => {
    events.length = 0;
    chunks.length = 0;
    const result = await run(
      spawnWith([
        line({ type: "thread.started", thread_id: "t1" }),
        line({ type: "item.started", item: { type: "command_execution", command: "npm test" } }),
        line({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
        line({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }),
      ])
    );
    expect(result).toMatchObject({ status: "completed", output: "done", inputTokens: 10, outputTokens: 2 });
    expect(chunks.join("")).toBe("done\n");
    expect(events.map((event) => event.type)).toEqual(["native.run.started", "native.tool", "native.run.finished"]);
    expect(events[1]?.payload).toMatchObject({ driver: "codex", tool: "shell", target: "npm test" });
  });

  it("fails on a non-zero exit and keeps the error text", async () => {
    events.length = 0;
    const result = await run(spawnWith([line({ type: "error", message: "not logged in" })], 1));
    expect(result.status).toBe("failed");
    expect(result.output).toContain("not logged in");
  });

  it("reports a cancelled run when the killed process exits non-zero", async () => {
    const controller = new AbortController();
    controller.abort();
    // The real spawner kills the tree on abort; an injected spawner cannot,
    // so it reports the killed exit code instead.
    const result = await run(() => Promise.resolve({ stdout: "", stderr: "", code: 130 }), controller.signal);
    expect(result.status).toBe("failed");
    expect(result.output).toContain("Execution cancelled");
  });

  it("sums usage from injected stdout that never streamed", async () => {
    const spawnImpl: CodexSpawnImpl = () =>
      Promise.resolve({
        stdout: `${line({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } })}`,
        stderr: "",
        code: 0,
      });
    const result = await run(spawnImpl);
    expect(result.inputTokens).toBe(5);
    expect(result.outputTokens).toBe(1);
  });
});

describe("isCodexAvailable", () => {
  it("probes the binary and caches nothing when injected", async () => {
    const ok = await isCodexAvailable("codex", () => Promise.resolve({ stdout: "codex 1", stderr: "", code: 0 }));
    expect(ok).toBe(true);
    const missing = await isCodexAvailable("codex", () => Promise.reject(new Error("ENOENT")));
    expect(missing).toBe(false);
  });
});

describe("parseCodexUsage", () => {
  it("sums every turn.completed in a whole stdout dump", () => {
    const usage = parseCodexUsage(
      [
        line({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } }),
        line({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 2 } }),
      ].join("\n")
    );
    expect(usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });
});
