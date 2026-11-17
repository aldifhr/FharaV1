import { schemaDefault } from "@fhara/config";
import { wenv } from "@fhara/config/worker";
import { spawn } from "node:child_process";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import { NATIVE_PROMPT_MESSAGE, workspaceHeader } from "@/prompts/native";
import { addNativeUsage, type NativeEvent, type NativeRunResult, type NativeUsage } from "./nativeProvider";
import { opencodeAllowUnisolated } from "./opencodeDetect";

/**
 * Plan 057: the second provider-native runtime. `codex exec --json` runs the
 * subtask with Codex's own tools in the task workspace, mirroring the
 * OpenCode driver (`nativeProvider.ts`) but using the operator's local
 * `codex login` session instead of Fhara's LLM credentials.
 *
 * The run is intentionally NOT given a scoped home: Codex reads its auth
 * from `~/.codex`, so the process keeps the operator's HOME. Per plan 014
 * native sessions already run at full access inside the task workspace;
 * this driver adds no new privilege beyond that recorded decision, but it
 * does mean the machine's Codex login (and anything the shell can reach)
 * is in scope. It is a trusted-machine runtime, like OpenCode's default.
 */

export type NativeProviderDriver = "opencode" | "codex" | "acp";

/** `ORCHESTRATOR_NATIVE_DRIVER`: which CLI the native-provider runtime spawns. */
export function nativeDriverFromEnv(env?: Record<string, string | undefined>): NativeProviderDriver {
  const value = String(wenv("ORCHESTRATOR_NATIVE_DRIVER", env));
  return value === "codex" ? "codex" : value === "acp" ? "acp" : "opencode";
}

export function codexCommand(env?: Record<string, string | undefined>): string {
  return String(wenv("ORCHESTRATOR_CODEX_COMMAND", env) ?? "codex");
}

/**
 * Plan 057: the same two guards the OpenCode driver has, for Codex. It must
 * be detected on this worker, and it may not run in the real checkout when
 * worktree isolation is off (the native path edits files with its own tools,
 * outside the approval gate). `ORCHESTRATOR_OPENCODE_ALLOW_UNISOLATED=1` is
 * the shared explicit opt-out.
 */
export function codexGateFor(input: {
  available: boolean;
  worktreeIsolation?: boolean;
  env?: Record<string, string | undefined>;
}): { available: boolean; reason?: string } {
  if (!input.available) {
    return { available: false, reason: "Codex CLI not detected on this worker" };
  }
  if (!input.worktreeIsolation && !opencodeAllowUnisolated(input.env)) {
    return {
      available: false,
      reason:
        "worktree isolation is off (ORCHESTRATOR_WORKTREE_ISOLATION), so Codex would run in the real repo; set ORCHESTRATOR_WORKTREE_ISOLATION=1, or ORCHESTRATOR_OPENCODE_ALLOW_UNISOLATED=1 to accept that",
    };
  }
  return { available: true };
}

/** Codex's own model id (never an OpenCode `provider/model`). */
export function codexModel(env?: Record<string, string | undefined>): string | undefined {
  const value = String(wenv("ORCHESTRATOR_CODEX_MODEL", env) ?? "").trim();
  return value || undefined;
}

export const CODEX_ARGS_BASE = ["exec", "--json", "--skip-git-repo-check", "--color", "never", "-s", "danger-full-access"] as const;

/** Exact argv for one run; the prompt travels on stdin (arg `-`), never argv. */
export function codexArgv(options: { model?: string } = {}): string[] {
  const args: string[] = [...CODEX_ARGS_BASE];
  if (options.model?.trim()) args.push("-m", options.model.trim());
  args.push("-");
  return args;
}

// ── availability ─────────────────────────────────────────────────────

let availabilityCache: { command: string; ok: boolean } | undefined;

export function resetCodexAvailabilityCache(): void {
  availabilityCache = undefined;
}

export async function isCodexAvailable(command = codexCommand(), spawnImpl?: CodexSpawnImpl): Promise<boolean> {
  if (spawnImpl) {
    try {
      const result = await spawnImpl(command, ["--version"], { cwd: process.cwd(), stdin: "" });
      return result.code === 0;
    } catch {
      return false;
    }
  }
  if (availabilityCache?.command === command) return availabilityCache.ok;
  const ok = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, ["--version"], {
        env: buildChildEnv(),
        shell: process.platform === "win32",
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(false);
    }, 5_000);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
  availabilityCache = { command, ok };
  return ok;
}

// ── JSON event parsing ───────────────────────────────────────────────

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : undefined;
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function clip(value: unknown, max = 200): string | undefined {
  return typeof value === "string" && value ? value.slice(0, max) : undefined;
}

/**
 * Parse one `codex exec --json` line. Null for non-JSON output (Codex can
 * print a plain banner on stderr, and older builds may not be in JSON mode).
 * Tool events carry the tool name, status and a short target — never the
 * full command output.
 */
export function parseCodexEvent(line: string): NativeEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let raw: Rec;
  try {
    const parsed = JSON.parse(trimmed);
    const rec = asRecord(parsed);
    if (!rec) return null;
    raw = rec;
  } catch {
    return null;
  }
  const type = String(raw.type ?? "");
  if (type === "thread.started") {
    return { kind: "other", type: "thread.started" };
  }
  if (type === "error" || type === "turn.failed") {
    const error = asRecord(raw.error);
    const message =
      clip(error?.message, 2000) ?? clip(raw.message, 2000) ?? "Codex error";
    return { kind: "error", message };
  }
  if (type === "turn.completed") {
    // Codex reports total input tokens (cached is a subset) and output that
    // already includes reasoning, unlike OpenCode's additive shapes.
    const usage = asRecord(raw.usage) ?? {};
    return {
      kind: "step_finish",
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      ...(usage.cached_input_tokens !== undefined ? { cachedInputTokens: num(usage.cached_input_tokens) } : {}),
      ...(usage.reasoning_output_tokens !== undefined ? { reasoningTokens: num(usage.reasoning_output_tokens) } : {}),
    };
  }
  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
    const item = asRecord(raw.item);
    if (!item) return { kind: "other", type };
    const itemType = String(item.type ?? "");
    const status = item.completed === true || type === "item.completed" ? "completed" : "running";
    if (itemType === "agent_message") {
      const text = clip(item.text, 100_000) ?? "";
      return type === "item.completed" ? { kind: "text", text } : { kind: "other", type };
    }
    if (itemType === "command_execution") {
      return { kind: "tool", tool: "shell", status, ...(clip(item.command) ? { target: clip(item.command) } : {}) };
    }
    if (itemType === "file_change") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes
        .map((change) => clip(asRecord(change)?.path, 120))
        .filter((path): path is string => Boolean(path));
      return { kind: "tool", tool: "apply_patch", status, ...(paths.length > 0 ? { target: paths.join(", ").slice(0, 200) } : {}) };
    }
    if (itemType === "mcp_tool_call") {
      const server = clip(item.server, 60);
      const tool = clip(item.tool, 60);
      return {
        kind: "tool",
        tool: server && tool ? `mcp:${server}/${tool}` : "mcp_tool_call",
        status,
      };
    }
    if (itemType === "web_search") {
      return { kind: "tool", tool: "web_search", status, ...(clip(item.query) ? { target: clip(item.query) } : {}) };
    }
    return { kind: "other", type: itemType || type };
  }
  return { kind: "other", type: type || "unknown" };
}

export function parseCodexUsage(stdout: string): NativeUsage {
  let usage: NativeUsage = { inputTokens: 0, outputTokens: 0 };
  for (const line of stdout.split(/\r?\n/)) {
    const event = parseCodexEvent(line);
    if (event?.kind === "step_finish") usage = addNativeUsage(usage, event);
  }
  return usage;
}

// ── process handling ─────────────────────────────────────────────────

export interface CodexSpawnOptions {
  cwd: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Prompt written to stdin and closed; `-` tells Codex to read it. */
  stdin?: string;
  onStdout?: (chunk: string) => void;
}

export type CodexSpawnImpl = (
  command: string,
  args: string[],
  options: CodexSpawnOptions
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

export async function defaultCodexSpawn(
  command: string,
  args: string[],
  options: CodexSpawnOptions
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? buildChildEnv(),
      shell: process.platform === "win32",
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const onAbort = () => killTreeLocal(child);
    if (options.signal?.aborted) killTreeLocal(child);
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      try {
        options.onStdout?.(text);
      } catch {}
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      endGroupLocal(child);
      resolve({ stdout, stderr, code });
    });
    // Codex accepts `-` as "prompt from stdin". Always close it.
    try {
      child.stdin?.end(options.stdin ?? "", "utf-8");
    } catch {}
  });
}

function killTreeLocal(child: import("node:child_process").ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

function endGroupLocal(child: import("node:child_process").ChildProcess): void {
  if (process.platform === "win32" || !child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
}

// ── run ──────────────────────────────────────────────────────────────

export interface CodexRunInput {
  workspacePath: string;
  prompt: string;
  command?: string;
  /** Codex model id (`ORCHESTRATOR_CODEX_MODEL`); unset uses the CLI's own. */
  model?: string;
  timeoutMs?: number;
  spawnImpl?: CodexSpawnImpl;
  signal?: AbortSignal;
  onEvent?: (type: string, payload: Record<string, unknown>, severity?: "info" | "warn" | "error") => Promise<void> | void;
  onChunk?: (text: string) => Promise<void> | void;
  onMessage?: (text: string) => Promise<void> | void;
}

export async function runCodexProvider(input: CodexRunInput): Promise<NativeRunResult> {
  const command = input.command ?? codexCommand();
  const model = input.model?.trim() || codexModel();
  const timeoutMs = input.timeoutMs ?? (schemaDefault("ORCHESTRATOR_NATIVE_TIMEOUT_MS") as number);
  await input.onEvent?.(
    "native.run.started",
    {
      provider: command,
      driver: "codex",
      cwd: input.workspacePath,
      ...(model ? { model } : {}),
      llmSource: "codex-native",
      timeoutMs,
    },
    "info"
  );

  const controller = new AbortController();
  let timedOut = false;
  const onOuterAbort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const texts: string[] = [];
  const errors: string[] = [];
  let usage: NativeUsage = { inputTokens: 0, outputTokens: 0 };
  const startedAt = Date.now();
  let sawJson = false;
  let streamed = false;
  let pending = "";
  const plainLines: string[] = [];
  let chain: Promise<void> = Promise.resolve();
  const handleLine = (line: string) => {
    if (!line.trim()) return;
    const event = parseCodexEvent(line);
    if (!event) {
      plainLines.push(line);
      return;
    }
    sawJson = true;
    switch (event.kind) {
      case "text":
        if (event.text) {
          texts.push(event.text);
          const part = event.text.endsWith("\n") ? event.text : `${event.text}\n`;
          chain = chain.then(() => input.onChunk?.(part)).catch(() => {});
        }
        break;
      case "tool": {
        const { kind: _kind, ...payload } = event;
        chain = chain
          .then(() => input.onEvent?.("native.tool", { provider: command, driver: "codex", ...payload }, event.status === "completed" && event.error ? "warn" : "info"))
          .catch(() => {});
        break;
      }
      case "step_finish":
        usage = addNativeUsage(usage, event);
        break;
      case "error":
        errors.push(event.message);
        break;
      default:
        break;
    }
  };
  const feed = (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  };

  let ran: { stdout: string; stderr: string; code: number | null };
  try {
    ran = await (input.spawnImpl ?? defaultCodexSpawn)(command, codexArgv({ model }), {
      cwd: input.workspacePath,
      signal: controller.signal,
      env: buildChildEnv(),
      stdin: `${workspaceHeader(input.workspacePath)}\n${NATIVE_PROMPT_MESSAGE}\n\n${input.prompt}`,
      onStdout: (chunk) => {
        streamed = true;
        feed(chunk);
      },
    });
  } catch (error) {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onOuterAbort);
    return {
      status: "failed",
      output: `Codex failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
  clearTimeout(timer);
  input.signal?.removeEventListener("abort", onOuterAbort);
  if (!streamed) feed(ran.stdout);
  if (pending) {
    handleLine(pending);
    pending = "";
  }
  await chain;

  const { inputTokens, outputTokens } = usage;
  const ledger = { ...usage, durationMs: Date.now() - startedAt };
  const textOutput = sawJson ? texts.join("\n").trim() : ran.stdout.trim();
  const extraPlain = sawJson ? plainLines.join("\n").trim() : "";
  const stderr = ran.stderr.trim();
  const failed = ran.code !== 0 || timedOut || errors.length > 0;
  await input.onEvent?.(
    "native.run.finished",
    {
      provider: command,
      driver: "codex",
      exitCode: ran.code,
      inputTokens,
      outputTokens,
      ...(timedOut ? { timedOut: true, timeoutMs } : {}),
      ...(errors.length > 0 ? { errors: errors.slice(0, 3) } : {}),
    },
    failed ? "warn" : "info"
  );
  if (failed) {
    const reason = timedOut
      ? `Codex timed out after ${timeoutMs}ms`
      : input.signal?.aborted
        ? "Execution cancelled"
        : "";
    const output = [reason, ...errors, textOutput, extraPlain, ran.code !== 0 ? stderr : ""].filter(Boolean).join("\n").slice(0, 12000);
    return {
      status: "failed",
      output: output || `Codex exited with code ${ran.code ?? "unknown"}`,
      ...ledger,
      rawExitCode: ran.code ?? undefined,
      ...(timedOut ? { timedOut: true } : {}),
      ...(model ? { model } : {}),
    };
  }
  const output = (textOutput || [extraPlain, stderr].filter(Boolean).join("\n")).slice(0, 12000);
  if (output) await input.onMessage?.(output);
  return { status: "completed", output, ...ledger, ...(model ? { model } : {}) };
}
