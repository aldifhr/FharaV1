import { runCommand } from "@/tools/runCommand";
import { PtyUnavailableError, runPty, type RunPtyOptions } from "@/tools/runPty";
import { isInteractiveCommand } from "@/utils/commandAllowlist";

/**
 * GOAT G11: run one allowlisted shell-node command. Long, progress-printing
 * commands (tests, builds, type checks) go through `runPty` so their output
 * streams into the subtask's live tail (bounded terminal history, query
 * sequences stripped); the rest stay on `runCommand`. Both paths enforce
 * the exact-argv allowlist and the L2 shell guard themselves.
 *
 * Without a working PTY binding the command falls back to `runCommand`
 * (same result shape, no streaming), never to an unguarded spawn.
 */
export interface ShellRunOptions {
  signal?: AbortSignal;
  /** Live tail sink (the runner's LiveOutputCoalescer via onChunk). */
  onChunk?: (delta: string) => Promise<void> | void;
  /** Test seam: replaces the PTY spawn. */
  spawnImpl?: RunPtyOptions["spawnImpl"];
}

export interface ShellRunResult {
  stdout: string;
  stderr: string;
  via: "pty" | "exec";
  code?: number | null;
  timedOut?: boolean;
  truncated?: boolean;
}

export async function runShellCommand(
  workspacePath: string,
  command: string,
  args: string[],
  options: ShellRunOptions = {}
): Promise<ShellRunResult> {
  if (isInteractiveCommand(command, args)) {
    try {
      const result = await runPty(workspacePath, command, args, {
        signal: options.signal,
        spawnImpl: options.spawnImpl,
        onOutput: options.onChunk
          ? (text) => {
              void Promise.resolve(options.onChunk?.(text)).catch(() => undefined);
            }
          : undefined,
      });
      const notes = [
        result.truncated ? "(output truncated to the newest lines)" : "",
        result.timedOut ? "(stopped: timed out or cancelled)" : "",
        result.code !== null && result.code !== 0 && !result.timedOut ? `(exit code ${result.code})` : "",
      ].filter(Boolean);
      return {
        stdout: result.stdout,
        stderr: notes.join("\n"),
        via: "pty",
        code: result.code,
        timedOut: result.timedOut,
        truncated: result.truncated,
      };
    } catch (error) {
      // A task cancelled before the spawn reads like runCommand's failure.
      if (options.signal?.aborted) return { stdout: "", stderr: "Command aborted before start", via: "pty", timedOut: true };
      if (!(error instanceof PtyUnavailableError)) throw error;
    }
  }
  const result = await runCommand(workspacePath, command, args, { signal: options.signal });
  return { ...result, via: "exec" };
}
