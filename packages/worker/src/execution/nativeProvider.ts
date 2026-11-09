import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Provider-native runtime (plan 014): executes a subtask through a
 * provider CLI (OpenCode/ACP-compatible) running its own native tools
 * inside the task workspace. Returns structured output + usage for
 * observability. Provider sessions are per-call processes here — no
 * long-lived session id to persist yet.
 */

export interface NativeRunOptions {
  signal?: AbortSignal;
  onEvent?: (type: string, payload: Record<string, unknown>, level?: "info" | "warn" | "error") => Promise<void>;
  onChunk?: (delta: string) => Promise<void>;
  onMessage?: (text: string) => Promise<void>;
}

export interface NativeRunResult {
  status: "completed" | "failed";
  output: string;
  /** Best-effort token usage; 0 when the provider does not report it. */
  inputTokens: number;
  outputTokens: number;
  rawExitCode?: number;
}

export function nativeProviderCommand(): string {
  return process.env.ORCHESTRATOR_NATIVE_PROVIDER_COMMAND ?? "opencode";
}

/**
 * Totally injectable for tests: pass a spawn implementation to test
 * without a real CLI. Default is the real node:child_process spawn.
 */
export type SpawnImpl = (
  command: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; shell?: boolean }
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

/** Short message passed verbatim on the provider CLI argv; the full prompt
 *  travels via an attached file (`-f`) so argv stays well under the Windows
 *  limit (~32k) regardless of audit/repository context size. Message first,
 *  `-f` after: `--file` is an [array] and swallows the positional message
 *  when it comes first (`File not found: <first word>` on opencode 1.x). */
export const NATIVE_PROMPT_MESSAGE =
  "Read the attached prompt file and execute the instructions in it. When done, write a short summary: what you changed, files touched, and anything that needs follow-up.";

/** The argv actually executed (exact-argv construction, no string interpolation). */
export function nativeArgv(command: string, promptFileArgs: string[]): { command: string; args: string[] } {
  return { command, args: ["run", ...promptFileArgs] };
}

export async function isNativeProviderAvailable(command = nativeProviderCommand()): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      windowsHide: true,
      shell: process.platform === "win32",
      timeout: 10_000,
    });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(false);
    }, 10_000);
  });
}

export function buildNativePrompt(input: {
  title: string;
  description: string;
  command: string;
  systemPrompt?: string;
  priorContext?: string;
  fileContext?: string;
}): string {
  return [
    input.systemPrompt ? `Role: ${input.systemPrompt}` : "",
    `Task: ${input.command}`,
    `Your part: ${input.title} — ${input.description}`,
    input.priorContext ? `\nPrior context:\n${input.priorContext}` : "",
    input.fileContext ? `\nWorkspace context:\n${input.fileContext}` : "",
    "",
    "You have full workspace access. Make the changes yourself; do not ask for approval.",
    "When done, write a short summary: what you changed, files touched, and anything that needs follow-up.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Test helper: render JSON-ish usage fields if the CLI printed them. */
export function parseNativeUsage(stdout: string): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown> | unknown[];
      const events = Array.isArray(parsed) ? parsed : [parsed];
      for (const event of events) {
        if (typeof event === "object" && event !== null) {
          const usage = (event as Record<string, unknown>).usage as Record<string, unknown> | undefined;
          if (usage && typeof usage === "object") {
            const inTok = Number(usage.input_tokens ?? usage.input ?? 0);
            const outTok = Number(usage.output_tokens ?? usage.output ?? 0);
            if (Number.isFinite(inTok)) inputTokens += inTok;
            if (Number.isFinite(outTok)) outputTokens += outTok;
          }
          const tokens = (event as Record<string, unknown>).tokens as Record<string, unknown> | undefined;
          if (tokens && typeof tokens === "object") {
            const inTok = Number(tokens.input ?? tokens.input_tokens ?? 0);
            const outTok = Number(tokens.output ?? tokens.output_tokens ?? 0);
            if (Number.isFinite(inTok)) inputTokens += inTok;
            if (Number.isFinite(outTok)) outputTokens += outTok;
          }
        }
      }
    } catch {
      // Not JSONL output; ignore.
    }
  }
  return { inputTokens, outputTokens };
}

async function defaultSpawn(
  command: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; shell?: boolean }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child: import("node:child_process").ChildProcessWithoutNullStreams = spawn(command, args, {
      cwd: options.cwd,
      shell: options.shell ?? process.platform === "win32",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    const onAbort = () => killTree(child);
    if (options.signal?.aborted) {
      killTree(child);
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
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
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Kill a child process AND its whole process tree: on POSIX the child was
 * spawned `detached` (own process group) so SIGKILL targets the group; on
 * Windows `taskkill /T /F` walks the tree. Without this, aborting a native
 * run (subtask timeout / cancel) leaves `opencode.exe` orphaned and still
 * writing to the workspace, since with `shell: true` the abort only kills
 * the cmd wrapper. Same pattern as verification.ts `killTree`.
 */
export function killTree(child: import("node:child_process").ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
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

export interface NativeRunInput {
  workspacePath: string;
  prompt: string;
  command?: string;
  signal?: AbortSignal;
  onEvent?: (type: string, payload: Record<string, unknown>, level?: "info" | "warn" | "error") => Promise<void>;
  onChunk?: (delta: string) => Promise<void>;
  onMessage?: (text: string) => Promise<void>;
  spawnImpl?: SpawnImpl;
}

export async function runNativeProvider(input: NativeRunInput): Promise<NativeRunResult> {
  const command = input.command ?? nativeProviderCommand();
  await input.onEvent?.(
    "native.run.started",
    { provider: command, cwd: input.workspacePath },
    "info"
  );
  let tmpDir: string | undefined;
  let ran: { stdout: string; stderr: string; code: number | null };
  try {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-native-"));
    const promptFile = path.join(tmpDir, "prompt.md");
    await fs.writeFile(promptFile, input.prompt, "utf-8");
    const { args } = nativeArgv(command, [NATIVE_PROMPT_MESSAGE, "-f", promptFile]);
    ran = await (input.spawnImpl ?? defaultSpawn)(command, args, {
      cwd: input.workspacePath,
      signal: input.signal,
    });
  } catch (error) {
    return {
      status: "failed",
      output: `Native provider failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
      inputTokens: 0,
      outputTokens: 0,
    };
  } finally {
    if (tmpDir) {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the run result stands.
      }
    }
  }
  const usage = parseNativeUsage(ran.stdout);
  await input.onEvent?.(
    "native.run.finished",
    { provider: command, exitCode: ran.code, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    ran.code === 0 ? "info" : "warn"
  );
  const output = [ran.stdout.trim(), ran.stderr.trim()].filter(Boolean).join("\n").slice(0, 12000);
  if (ran.code !== 0) {
    return {
      status: "failed",
      output: output || `Native provider exited with code ${ran.code ?? "unknown"}`,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      rawExitCode: ran.code ?? undefined,
    };
  }
  if (output) await input.onMessage?.(output);
  return {
    status: "completed",
    output,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}
