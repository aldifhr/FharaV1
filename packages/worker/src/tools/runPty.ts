import { spawn as spawnChild } from "node:child_process";
import type { IPty } from "@lydell/node-pty";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import { isCommandAllowed } from "@/utils/commandAllowlist";
import { resolveSandboxPathAsync } from "@/tools/sandbox";
import { shouldUseShell } from "@/tools/runCommand";
import { redactText } from "@/utils/redact";
import { shellGuardDecisionForArgv } from "@/utils/shellGuard";
import { BoundedTerminalHistory } from "@/vendor/goat/boundedTerminalHistory";
import { sanitizeTerminalHistoryChunk } from "@/vendor/goat/terminalHistoryReplay";

export type PtyHandle = Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit">;

export interface PtySpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  name: string;
}

export type PtySpawnImpl = (
  command: string,
  args: string[],
  options: PtySpawnOptions
) => PtyHandle;

export interface RunPtyOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  input?: string;
  cols?: number;
  rows?: number;
  spawnImpl?: PtySpawnImpl;
  /**
   * Streamed output for the live tail (subtaskLive), ANSI-stripped and with
   * terminal query/response traffic removed. Called once per PTY chunk;
   * redaction happens in the live coalescer over the joined tail.
   */
  onOutput?: (text: string) => void;
  /** History caps (GOAT G11 defaults: 5,000 lines / 1 MiB of UTF-8). */
  maxLines?: number;
  maxBytes?: number;
}

export interface RunPtyResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export class PtyUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      `PTY unavailable (${cause instanceof Error ? cause.message : String(cause)}); ` +
        `install the @lydell/node-pty native binding or use runCommand`
    );
    this.name = "PtyUnavailableError";
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** Kept terminal history: the newest lines win (bounded, UTF-8 safe). */
export const PTY_HISTORY_MAX_LINES = 5_000;
export const PTY_HISTORY_MAX_BYTES = 1024 * 1024;
const MAX_INPUT_CHARS = 8_000;

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Strip ANSI escape sequences so PTY output is safe for taskEvents and the UI.
 * Progress/spinner lines that redraw with `\r` keep only the final segment.
 */
export function stripAnsi(text: string): string {
  const withoutEscapes = text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()#%][0-9A-Za-z]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\x9b[0-?]*[ -/]*[@-~]/g, "");
  return withoutEscapes
    .split("\n")
    .map((line) => {
      const segments = line.split("\r");
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        if (segments[i]) return segments[i];
      }
      return line.startsWith("\r") ? line.slice(1) : "";
    })
    .join("\n");
}

function validateInput(input: string): void {
  if (input.length > MAX_INPUT_CHARS) {
    throw new Error(`PTY input exceeds ${MAX_INPUT_CHARS} characters`);
  }
  if (/[^\x20-\x7e\r\n\t]/.test(input)) {
    throw new Error("PTY input contains disallowed control characters");
  }
}

function killPtyTree(handle: PtyHandle): void {
  if (process.platform === "win32") {
    spawnChild("taskkill", ["/pid", String(handle.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    try {
      handle.kill();
    } catch {
    }
    return;
  }
  try {
    process.kill(-handle.pid, "SIGKILL");
  } catch {
    try {
      handle.kill("SIGKILL");
    } catch {
    }
  }
}

/**
 * The one place a PTY process is started. D6 (bwrap sandbox) wraps this
 * call; keep it small and keep every spawn going through it.
 */
export async function spawnPtyProcess(
  command: string,
  args: string[],
  options: PtySpawnOptions,
  spawnImpl?: PtySpawnImpl
): Promise<PtyHandle> {
  if (spawnImpl) return spawnImpl(command, args, options);
  let spawnFn: typeof import("@lydell/node-pty").spawn;
  try {
    ({ spawn: spawnFn } = await import("@lydell/node-pty"));
  } catch (error) {
    throw new PtyUnavailableError(error);
  }
  try {
    if (process.platform === "win32" && shouldUseShell(command)) {
      return spawnFn("cmd.exe", ["/c", command, ...args], options);
    }
    return spawnFn(command, args, options);
  } catch (error) {
    // A missing native binding throws on first spawn, not on import.
    throw new PtyUnavailableError(error);
  }
}

export async function runPty(
  workspaceRoot: string,
  command: string,
  args: string[] = [],
  options: RunPtyOptions = {}
): Promise<RunPtyResult> {
  if (!isCommandAllowed(command, args)) {
    throw new Error(`Command blocked (not allowlisted): ${command} ${args.join(" ")}`);
  }
  // L2: never run a command that dumps the environment or a credential file.
  const guard = shellGuardDecisionForArgv(command, args);
  if (guard) {
    throw new Error(`Command blocked by rule ${guard.rule} (${guard.reason}): ${command} ${args.join(" ")}`);
  }
  if (options.signal?.aborted) {
    throw new Error("Command aborted before start");
  }
  if (options.input !== undefined) validateInput(options.input);

  const cwd = await resolveSandboxPathAsync(workspaceRoot, "");
  const timeoutMs = clamp(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, 3_600_000, DEFAULT_TIMEOUT_MS);
  const spawnOptions: PtySpawnOptions = {
    cwd,
    env: buildChildEnv(),
    cols: clamp(options.cols ?? 80, 40, 240, 80),
    rows: clamp(options.rows ?? 24, 10, 60, 24),
    name: "xterm-256color",
  };
  const handle = await spawnPtyProcess(command, args, spawnOptions, options.spawnImpl);

  return new Promise<RunPtyResult>((resolve) => {
    // GOAT G11: bounded history (line + UTF-8 byte cap, surrogate-safe
    // eviction); query/response sequences (DSR, DA, DECRQM, OSC colour
    // queries…) are dropped before they are kept or streamed.
    const history = new BoundedTerminalHistory(
      clamp(options.maxLines ?? PTY_HISTORY_MAX_LINES, 1, PTY_HISTORY_MAX_LINES * 4, PTY_HISTORY_MAX_LINES),
      "",
      clamp(options.maxBytes ?? PTY_HISTORY_MAX_BYTES, 1, 8 * 1024 * 1024, PTY_HISTORY_MAX_BYTES)
    );
    let pendingSequence = "";
    let timedOut = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const onAbort = () => {
      timedOut = true;
      killPtyTree(handle);
      armGrace();
    };

    const armGrace = () => {
      if (graceTimer) return;
      graceTimer = setTimeout(() => finish(null), 5_000);
      graceTimer.unref?.();
    };

    let dataSub: { dispose: () => void } | undefined;
    let exitSub: { dispose: () => void } | undefined;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      options.signal?.removeEventListener("abort", onAbort);
      dataSub?.dispose();
      exitSub?.dispose();
      const output = history.value();
      resolve({
        // L2: masked after the ANSI strip (escapes can hide a key=value).
        stdout: redactText(stripAnsi(output)),
        stderr: "",
        code,
        timedOut,
        truncated: history.position > output.length,
      });
    };

    dataSub = handle.onData((chunk) => {
      if (settled) return;
      const sanitized = sanitizeTerminalHistoryChunk(pendingSequence, chunk);
      pendingSequence = sanitized.pendingControlSequence;
      if (!sanitized.visibleText) return;
      history.append(sanitized.visibleText);
      if (options.onOutput) {
        const text = stripAnsi(sanitized.visibleText);
        if (text) {
          try {
            options.onOutput(text);
          } catch {
            // Live output is cosmetic; never fail the command over it.
          }
        }
      }
    });
    exitSub = handle.onExit(({ exitCode }) => finish(exitCode));

    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killPtyTree(handle);
      armGrace();
    }, timeoutMs);
    timeoutTimer.unref?.();

    if (options.input) {
      try {
        handle.write(options.input);
      } catch {
      }
    }
  });
}
