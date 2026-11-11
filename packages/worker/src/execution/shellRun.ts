import { runCommand, type SandboxRefusal } from "@/tools/runCommand";
import { SandboxUnavailableError } from "@/tools/osSandbox";
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
  /** D6: run without the bwrap sandbox (only after a `run_unconfined` approval). */
  unconfined?: boolean;
}

export interface ShellRunResult {
  stdout: string;
  stderr: string;
  via: "pty" | "exec";
  code?: number | null;
  timedOut?: boolean;
  truncated?: boolean;
  /** D6: the sandbox refused the command (a denied write, or no usable bwrap). */
  sandbox?: SandboxRefusal;
  /** D6: this result is from an approved rerun without the sandbox. */
  unconfined?: boolean;
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
        unconfined: options.unconfined,
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
        ...(result.sandbox ? { sandbox: result.sandbox } : {}),
      };
    } catch (error) {
      // A task cancelled before the spawn reads like runCommand's failure.
      if (options.signal?.aborted) return { stdout: "", stderr: "Command aborted before start", via: "pty", timedOut: true };
      if (error instanceof SandboxUnavailableError) return { stdout: "", stderr: error.message, via: "pty", sandbox: "unavailable" };
      if (!(error instanceof PtyUnavailableError)) throw error;
    }
  }
  const result = await runCommand(workspacePath, command, args, { signal: options.signal, unconfined: options.unconfined });
  return { ...result, via: "exec" };
}

/** What the shell node logs and asks around one command (D6). */
export interface SandboxedShellOptions extends Omit<ShellRunOptions, "unconfined"> {
  onEvent?: (type: string, payload: Record<string, unknown>, level: "info" | "warn") => Promise<unknown> | unknown;
  /** Ask the user (approval kind `run_unconfined`) before a rerun without the sandbox. */
  requestUnconfined?: (cmd: { command: string; args: string[] }) => Promise<{ allowed: boolean; via?: string; reason?: string }>;
}

/** Status-line / event tag for how a command ran. */
export function sandboxTag(result: Pick<ShellRunResult, "sandbox" | "unconfined">, active: boolean): string {
  if (result.unconfined) return "unconfined";
  if (result.sandbox === "unavailable") return "unavailable";
  return active ? "sandboxed" : "off";
}

/**
 * D6: run one shell-node command inside the bwrap sandbox. When the sandbox
 * refuses it (a write outside the writable roots, or no usable bwrap) the
 * user gets a `run_unconfined` card; an approval reruns it unconfined, a
 * decline returns the refused result with a note. Never reruns silently.
 */
export async function runSandboxedShell(
  workspacePath: string,
  command: string,
  args: string[],
  options: SandboxedShellOptions = {},
  active = true
): Promise<ShellRunResult> {
  const { onEvent, requestUnconfined, ...run } = options;
  await onEvent?.("shell.command", { command, args, cwd: workspacePath, sandbox: active ? "sandboxed" : "off" }, "info");
  const first = await runShellCommand(workspacePath, command, args, run);
  if (!first.sandbox) return first;
  await onEvent?.("shell.sandbox_denied", { command, args, reason: first.sandbox }, "warn");
  const blocked = first.sandbox === "unavailable" ? "the command sandbox is unavailable on this worker" : "the command sandbox refused a write outside the workspace";
  const note = (why: string) => ({ ...first, stderr: [first.stderr, `(not run unconfined: ${blocked}; ${why})`].filter(Boolean).join("\n") });
  if (!requestUnconfined) return note("no approval channel");
  const outcome = await requestUnconfined({ command, args });
  if (!outcome.allowed) {
    await onEvent?.("shell.unconfined_declined", { command, args, via: outcome.via, reason: outcome.reason }, "warn");
    return note(outcome.reason ?? "declined");
  }
  await onEvent?.("shell.command", { command, args, cwd: workspacePath, sandbox: "unconfined" }, "info");
  const second = await runShellCommand(workspacePath, command, args, { ...run, unconfined: true });
  return { ...second, unconfined: true, stderr: [second.stderr, "(ran without the command sandbox, approved by the user)"].filter(Boolean).join("\n") };
}
