import { spawn } from "node:child_process";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import {
  HOST_CHECK_TIMEOUT_MS,
  SCRIPT_TAIL_CHARS,
  SCRIPT_TAIL_LINES,
  isProjectScriptAllowed,
  projectScriptLine,
  type ProjectScriptKind,
} from "@/api/convex/lib/projectScriptsSchema";
import { redactText } from "@/utils/redact";
import { shellGuardDecisionForArgv } from "@/utils/shellGuard";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@/vendor/goat/projectScripts";

/**
 * GOAT G9: run a project's setup or check script on the host. Exact argv
 * (re-checked here against the allowlist, never trusted from storage), no
 * shell except the Windows package-manager shims, the scrubbed child env, a
 * hard timeout that kills the whole process group, and a bounded, redacted
 * tail.
 *
 * `not_configured` is its own status, never `passed`: a project without a
 * check script has no host evidence, and the card says "No check configured".
 */
export type ProjectScriptStatus = "passed" | "failed" | "timed_out" | "not_configured" | "blocked" | "error";

export interface ProjectScriptOutcome {
  kind: ProjectScriptKind;
  status: ProjectScriptStatus;
  command?: string;
  exitCode?: number | null;
  durationMs: number;
  tail?: string;
  detail?: string;
}

export interface RunProjectScriptInput {
  kind: ProjectScriptKind;
  argv: string[] | null;
  projectRoot: string;
  worktreePath?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Test seam only: replaces the allowlist check. Production never sets it. */
  allow?: (argv: readonly string[]) => boolean;
}

/** Characters kept while the script runs; the tail is cut from this. */
const ROLLING_LIMIT = 64 * 1024;
const KILL_GRACE_MS = 5_000;
const SHELL_SHIMS = new Set(["npm", "npx", "pnpm", "yarn"]);

/** The last `maxLines` lines, then at most `maxChars` characters (from the end). */
export function scriptTail(text: string, maxLines = SCRIPT_TAIL_LINES, maxChars = SCRIPT_TAIL_CHARS): string {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  let tail = lines.slice(-maxLines).join("\n");
  if (tail.length > maxChars) tail = `…${tail.slice(-(maxChars - 1))}`;
  return tail;
}

export async function runProjectScript(input: RunProjectScriptInput): Promise<ProjectScriptOutcome> {
  const startedAt = Date.now();
  const { kind, argv } = input;
  if (!argv || argv.length === 0) {
    return { kind, status: "not_configured", durationMs: 0, detail: kind === "check" ? "No check configured" : "No setup script" };
  }
  const command = projectScriptLine(argv);
  const [head, ...rest] = argv as [string, ...string[]];
  const allowed = input.allow ? input.allow(argv) : isProjectScriptAllowed(kind, argv);
  const guard = shellGuardDecisionForArgv(head, rest);
  if (!allowed || guard) {
    const detail = guard ? `Blocked by rule ${guard.rule}` : "Not on the allowed script list";
    return { kind, status: "blocked", command, durationMs: 0, detail };
  }
  const timeoutMs = input.timeoutMs ?? HOST_CHECK_TIMEOUT_MS;
  const env = buildChildEnv(
    projectScriptRuntimeEnv({ project: { cwd: input.projectRoot }, worktreePath: input.worktreePath })
  );
  const cwd = projectScriptCwd({ project: { cwd: input.projectRoot }, worktreePath: input.worktreePath });
  const posix = process.platform !== "win32";

  return await new Promise<ProjectScriptOutcome>((resolve) => {
    let output = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.length > ROLLING_LIMIT) output = output.slice(-ROLLING_LIMIT);
    };
    const child = spawn(head, rest, {
      cwd,
      env,
      shell: !posix && SHELL_SHIMS.has(head),
      detached: posix,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (posix && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The group is already gone.
      }
    };
    const stop = () => {
      killTree("SIGTERM");
      graceTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
      graceTimer.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const finish = (result: Pick<ProjectScriptOutcome, "status" | "exitCode" | "detail">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      const tail = scriptTail(redactText(output));
      resolve({ kind, command, durationMs: Date.now() - startedAt, ...(tail ? { tail } : {}), ...result });
    };
    child.on("error", (error) => finish({ status: "error", exitCode: null, detail: error.message }));
    child.on("close", (code) => {
      if (graceTimer) clearTimeout(graceTimer);
      if (timedOut) {
        finish({ status: "timed_out", exitCode: code, detail: `Timed out after ${Math.round(timeoutMs / 1000)} s` });
      } else if (aborted) {
        finish({ status: "error", exitCode: code, detail: "Cancelled" });
      } else {
        finish({ status: code === 0 ? "passed" : "failed", exitCode: code });
      }
    });
  });
}
