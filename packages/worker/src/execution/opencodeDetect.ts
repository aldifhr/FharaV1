/**
 * Plan 038: detect the OpenCode CLI on the worker machine and probe it.
 *
 * - `findOpencodeBinary`: the configured command (ORCHESTRATOR_NATIVE_PROVIDER_COMMAND,
 *   default `opencode`) resolved like the shell would: an absolute or
 *   relative path is checked directly; a bare name is looked up on PATH
 *   (with PATHEXT on Windows, so `opencode.cmd` / `opencode.exe` from a
 *   global npm install are found), and on Windows `where` is asked as a
 *   last resort.
 * - `detectOpencode`: the path plus `opencode --version` under a short
 *   timeout. Every failure is a value (installed / error), never a throw.
 * - `probeOpencode`: the Settings "Test" button: a tiny `opencode run` in a
 *   throw-away temp directory (never a repo), timed.
 *
 * Nothing here reads or reports credential material.
 */
import { wenv } from "@fhara/config/worker";
import { promises as fs, constants as fsConstants } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import { defaultSpawn, nativeProviderCommand, runNativeProvider, type SpawnImpl } from "./nativeProvider";

export interface OpencodeDetection {
  /** The binary was found. */
  installed: boolean;
  /** `opencode --version`, when it answered. */
  version?: string;
  /** Where the binary was found. */
  path?: string;
  /** Why it is missing or why `--version` failed. */
  error?: string;
  checkedAt: number;
}

/** Default limit for `opencode --version`. */
export const VERSION_TIMEOUT_MS = 5_000;

/**
 * The version out of `opencode --version` output. OpenCode prints a bare
 * semver (`0.15.3`), sometimes prefixed (`opencode v1.2.0`, `opencode
 * version 1.2.0`). Returns the first semver-like token, or the first short
 * line when none, or undefined for empty output.
 */
export function parseOpencodeVersion(stdout: string): string | undefined {
  const text = stdout.replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (!text) return undefined;
  const semver = text.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  if (semver) return semver[1];
  const first = text.split(/\r?\n/)[0].trim();
  return first ? first.slice(0, 60) : undefined;
}

/**
 * The best path out of `where opencode` (Windows) output: one candidate per
 * line. A runnable wrapper (.cmd / .exe / .bat / .com) wins over the
 * extensionless npm shim, which Windows cannot execute directly.
 */
export function parseWhereOutput(stdout: string): string | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^INFO:/i.test(line) && !/could not find/i.test(line));
  if (lines.length === 0) return undefined;
  return lines.find((line) => /\.(cmd|exe|bat|com)$/i.test(line)) ?? lines[0];
}

export interface FindBinaryInput {
  command?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Injected in tests; default: the file exists and (POSIX) is executable. */
  isExecutable?: (file: string) => Promise<boolean>;
  spawnImpl?: SpawnImpl;
}

async function defaultIsExecutable(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    await fs.access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Locate the binary; undefined when it cannot be found. */
export async function findOpencodeBinary(input: FindBinaryInput = {}): Promise<string | undefined> {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const command = (input.command ?? nativeProviderCommand()).trim();
  const isExecutable = input.isExecutable ?? defaultIsExecutable;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const exts =
    platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase())]
      : [""];
  // On Windows the extensionless npm shim is a sh script: try the
  // runnable wrappers first.
  const ordered = platform === "win32" ? [...exts.slice(1), ""] : exts;
  if (!command) return undefined;
  const hasDir = command.includes("/") || (platform === "win32" && command.includes("\\"));
  if (hasDir || pathApi.isAbsolute(command)) {
    for (const ext of ordered) {
      const candidate = command + ext;
      if (await isExecutable(candidate)) return candidate;
    }
    return undefined;
  }
  const pathVar = (platform === "win32" ? env.Path ?? env.PATH : env.PATH) ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  for (const dir of pathVar.split(delimiter).map((d) => d.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean)) {
    for (const ext of ordered) {
      const candidate = pathApi.join(dir, command + ext);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  if (platform === "win32") {
    try {
      const { stdout, code } = await (input.spawnImpl ?? defaultSpawn)("where", [command], {
        cwd: os.tmpdir(),
        env: buildChildEnv(),
        shell: false,
      });
      if (code === 0) return parseWhereOutput(stdout);
    } catch {
      // `where` missing: not found.
    }
  }
  return undefined;
}

/** Quote a path for a shell-spawned command (Windows `.cmd` needs the shell). */
export function shellSafeCommand(file: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32" && /\s/.test(file) && !/^".*"$/.test(file)) return `"${file}"`;
  return file;
}

export interface DetectInput extends FindBinaryInput {
  timeoutMs?: number;
  now?: () => number;
}

/** Find the binary and ask it for its version. Never throws. */
export async function detectOpencode(input: DetectInput = {}): Promise<OpencodeDetection> {
  const now = input.now ?? Date.now;
  const command = (input.command ?? nativeProviderCommand()).trim() || "opencode";
  let found: string | undefined;
  try {
    found = await findOpencodeBinary({ ...input, command });
  } catch (error) {
    return { installed: false, error: errorText(error), checkedAt: now() };
  }
  if (!found) {
    return { installed: false, error: `"${command}" was not found on PATH`, checkedAt: now() };
  }
  const timeoutMs = input.timeoutMs ?? VERSION_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const { stdout, stderr, code } = await (input.spawnImpl ?? defaultSpawn)(
      shellSafeCommand(found, input.platform),
      ["--version"],
      { cwd: os.tmpdir(), env: buildChildEnv(), signal: controller.signal }
    );
    if (timedOut) {
      return { installed: true, path: found, error: `opencode --version timed out after ${timeoutMs} ms`, checkedAt: now() };
    }
    if (code !== 0) {
      return {
        installed: true,
        path: found,
        error: (stderr.trim() || `opencode --version exited with code ${code}`).slice(0, 300),
        checkedAt: now(),
      };
    }
    const version = parseOpencodeVersion(stdout) ?? parseOpencodeVersion(stderr);
    return { installed: true, path: found, ...(version ? { version } : {}), checkedAt: now() };
  } catch (error) {
    if (timedOut) {
      return { installed: true, path: found, error: `opencode --version timed out after ${timeoutMs} ms`, checkedAt: now() };
    }
    return { installed: true, path: found, error: errorText(error), checkedAt: now() };
  } finally {
    clearTimeout(timer);
  }
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  model?: string;
  error?: string;
}

/** Default limit for the Test probe. */
export const PROBE_TIMEOUT_MS = 90_000;

/**
 * The Settings "Test": a one-word `opencode run` in a fresh temp directory
 * (removed afterwards), with the same safety config as a task run. `model`
 * empty = OpenCode's own default model.
 */
export async function probeOpencode(input: {
  model?: string;
  command?: string;
  timeoutMs?: number;
  spawnImpl?: SpawnImpl;
  now?: () => number;
}): Promise<ProbeResult> {
  const now = input.now ?? Date.now;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-opencode-probe-"));
  const startedAt = now();
  try {
    const result = await runNativeProvider({
      workspacePath: dir,
      prompt: "Connectivity check. Do not use any tool. Reply with the single word OK.",
      command: input.command,
      ...(input.model ? { model: input.model } : {}),
      timeoutMs: input.timeoutMs ?? PROBE_TIMEOUT_MS,
      spawnImpl: input.spawnImpl,
    });
    const latencyMs = now() - startedAt;
    if (result.status === "completed") return { ok: true, latencyMs, ...(result.model ? { model: result.model } : {}) };
    return {
      ok: false,
      latencyMs,
      ...(result.model ? { model: result.model } : {}),
      error: result.timedOut ? "opencode run timed out" : (result.output.trim() || "opencode run failed").slice(0, 300),
    };
  } catch (error) {
    return { ok: false, latencyMs: now() - startedAt, error: errorText(error) };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

// ---- The worker's own view (the resolver reads it per subtask) ----

let current: OpencodeDetection | null = null;

/** The last detection this worker ran (null = not yet). */
export function currentOpencodeDetection(): OpencodeDetection | null {
  return current;
}

/** Store a detection (the catalog loop; tests). */
export function setOpencodeDetection(detection: OpencodeDetection | null): void {
  current = detection;
}

/** The detection, running one now when this worker has none yet. */
export async function ensureOpencodeDetection(): Promise<OpencodeDetection> {
  if (current) return current;
  const detection = await detectOpencode();
  current = detection;
  return detection;
}

/**
 * Explicit opt-out of the isolation guard: ORCHESTRATOR_OPENCODE_ALLOW_UNISOLATED
 * = 1 / true / yes lets OpenCode run in the project checkout itself.
 */
export function opencodeAllowUnisolated(env?: Record<string, string | undefined>): boolean {
  return wenv("ORCHESTRATOR_OPENCODE_ALLOW_UNISOLATED", env);
}

/**
 * Plan 038: may this worker run an OpenCode entry for a subtask of this
 * task? Refused when the CLI was not detected, or when the task runs
 * without worktree isolation (OpenCode's own tools would edit the user's
 * real checkout, outside the approval gate) unless the explicit env
 * opt-out is set.
 */
export function opencodeGateFor(input: {
  detection: OpencodeDetection | null;
  worktreeIsolation: boolean | undefined;
  env?: Record<string, string | undefined>;
}): { available: boolean; reason?: string } {
  const detection = input.detection;
  if (!detection || !detection.installed) {
    return {
      available: false,
      reason: `OpenCode CLI not detected on this worker${detection?.error ? ` (${detection.error})` : ""}`,
    };
  }
  if (!input.worktreeIsolation && !opencodeAllowUnisolated(input.env)) {
    return {
      available: false,
      reason:
        "worktree isolation is off (ORCHESTRATOR_WORKTREE_ISOLATION), so OpenCode would run in the real repo; set ORCHESTRATOR_WORKTREE_ISOLATION=1, or ORCHESTRATOR_OPENCODE_ALLOW_UNISOLATED=1 to accept that",
    };
  }
  return { available: true };
}
