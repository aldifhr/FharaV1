import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { EvaluationCheck } from "@/types";

export interface VerificationOptions {
  workspacePath: string;
  changedFiles?: string[];
  includeBuild?: boolean;
  timeoutMs?: number;
  onCheck?: (check: EvaluationCheck) => Promise<void> | void;
  /**
   * Task cancellation signal (Phase 4): checked between steps, and a
   * firing signal kills the running step's process tree via the same
   * killTree the timeout uses.
   */
  signal?: AbortSignal;
}

export interface VerificationResult {
  checks: EvaluationCheck[];
  ran: string[];
  skipped: string[];
}

interface StepDefinition {
  name: string;
  scripts: string[];
  binaryFallback?: { binary: string; args: string[]; requires: string[] };
  optional?: boolean;
}

interface VerificationTarget {
  name: string;
  directory: string;
  scripts: Record<string, string>;
}

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const BASE_STEPS: StepDefinition[] = [
  {
    name: "typecheck",
    scripts: ["typecheck", "type-check"],
    binaryFallback: { binary: "tsc", args: ["--noEmit"], requires: ["tsconfig.json"] },
  },
  { name: "lint", scripts: ["lint"] },
  { name: "test", scripts: ["test", "tests"] },
];

const BUILD_STEP: StepDefinition = { name: "build", scripts: ["build"], optional: true };

const OUTPUT_LIMIT = 200_000;
const DETAIL_LIMIT = 1_500;

interface RunResult {
  code: number | null;
  timedOut: boolean;
  output: string;
  durationMs: number;
}

export async function runVerification(options: VerificationOptions): Promise<VerificationResult> {
  const workspacePath = path.resolve(options.workspacePath);
  const timeoutMs = options.timeoutMs ?? 180_000;
  const checks: EvaluationCheck[] = [];
  const ran: string[] = [];
  const skipped: string[] = [];

  const record = async (check: EvaluationCheck) => {
    checks.push(check);
    if (options.onCheck) await options.onCheck(check);
  };

  const manager = await detectPackageManager(workspacePath);
  const targets = await resolveTargets(workspacePath, options.changedFiles);
  if (targets.length === 0) {
    await record({
      name: "verification",
      status: "passed",
      details: "No package.json found for the changed files; typecheck/lint/test not applicable for standalone files",
    });
    return { checks, ran, skipped };
  }

  const steps = options.includeBuild === false ? BASE_STEPS : [...BASE_STEPS, BUILD_STEP];

  for (const target of targets) {
    for (const step of steps) {
      if (options.signal?.aborted) {
        await record({
          name: "verification",
          status: "inconclusive",
          details: "Verification aborted: the task was cancelled or timed out",
        });
        return finish(checks, ran, skipped);
      }
      const command = await buildCommand(step, workspacePath, target, manager);
      if (!command) {
        skipped.push(`${target.name}:${step.name}`);
        continue;
      }

      const result = await runCommand(command, target.directory, timeoutMs, options.signal);
      ran.push(`${target.name}:${step.name}`);

      if (result.timedOut) {
        await record({
          name: `${target.name}:${step.name}`,
          status: "failed",
          durationMs: result.durationMs,
          details: `\`${command}\` timed out after ${Math.round(timeoutMs / 1000)}s. ${tail(result.output)}`.trim(),
        });
        return finish(checks, ran, skipped);
      }

      if (result.code !== 0) {
        await record({
          name: `${target.name}:${step.name}`,
          status: "failed",
          durationMs: result.durationMs,
          details: `\`${command}\` exited with code ${result.code}. ${tail(result.output)}`.trim(),
        });
        return finish(checks, ran, skipped);
      }

      const counts = step.name === "test" ? parseTestCounts(result.output) : undefined;
      await record({
        name: `${target.name}:${step.name}`,
        status: "passed",
        durationMs: result.durationMs,
        ...(counts ? { counts } : {}),
        details: `\`${command}\` passed in ${(result.durationMs / 1000).toFixed(1)}s`,
      });
    }
  }

  if (ran.length === 0) {
    await record({
      name: "verification",
      status: "inconclusive",
      details: `No typecheck/lint/test scripts found (skipped: ${skipped.join(", ")})`,
    });
  }

  return finish(checks, ran, skipped);
}

async function finish(
  checks: EvaluationCheck[],
  ran: string[],
  skipped: string[]
): Promise<VerificationResult> {
  return { checks, ran, skipped };
}

async function resolveTargets(
  workspacePath: string,
  changedFiles: string[] | undefined
): Promise<VerificationTarget[]> {
  const rootPackage = await readPackage(path.join(workspacePath, "package.json"));
  const targets = new Map<string, VerificationTarget>();

  if (!changedFiles || changedFiles.length === 0) {
    if (rootPackage) {
      targets.set(workspacePath, {
        name: rootPackage.name ?? "root",
        directory: workspacePath,
        scripts: rootPackage.scripts,
      });
    }
    return Array.from(targets.values());
  }

  let needsRoot = false;
  for (const file of changedFiles) {
    const packageDir = await findPackageDir(workspacePath, file);
    if (!packageDir || packageDir === workspacePath) {
      needsRoot = true;
      continue;
    }
    const pkg = await readPackage(path.join(packageDir, "package.json"));
    if (!pkg) {
      needsRoot = true;
      continue;
    }
    targets.set(packageDir, {
      name: pkg.name ?? path.relative(workspacePath, packageDir).replace(/\\/g, "/"),
      directory: packageDir,
      scripts: pkg.scripts,
    });
  }

  if (needsRoot && rootPackage) {
    targets.set(workspacePath, {
      name: rootPackage.name ?? "root",
      directory: workspacePath,
      scripts: rootPackage.scripts,
    });
  }

  return Array.from(targets.values());
}

async function findPackageDir(workspacePath: string, file: string): Promise<string | null> {
  const root = path.resolve(workspacePath);
  let dir = path.dirname(path.resolve(root, file));
  while (dir === root || dir.startsWith(root + path.sep)) {
    if (await exists(path.join(dir, "package.json"))) return dir;
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return null;
}

async function readPackage(
  packageJsonPath: string
): Promise<{ name?: string; scripts: Record<string, string> } | null> {
  try {
    const raw = await fs.readFile(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { name?: string; scripts?: Record<string, string> };
    return { name: parsed.name, scripts: parsed.scripts ?? {} };
  } catch {
    return null;
  }
}

async function detectPackageManager(workspacePath: string): Promise<PackageManager> {
  const candidates: Array<[string, PackageManager]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ];
  for (const [file, manager] of candidates) {
    if (await exists(path.join(workspacePath, file))) return manager;
  }
  return "npm";
}

async function buildCommand(
  step: StepDefinition,
  workspacePath: string,
  target: VerificationTarget,
  manager: PackageManager
): Promise<string | null> {
  for (const name of step.scripts) {
    if (typeof target.scripts[name] === "string") return `${manager} run ${name}`;
  }

  const fallback = step.binaryFallback;
  if (!fallback) return null;

  const required = await Promise.all(
    fallback.requires.map((file) => exists(path.join(target.directory, file)))
  );
  if (!required.every(Boolean)) return null;

  const binary = await resolveLocalBinary(workspacePath, target.directory, fallback.binary);
  if (!binary) return null;
  return `"${binary}" ${fallback.args.join(" ")}`;
}

async function resolveLocalBinary(
  workspacePath: string,
  targetDir: string,
  binary: string
): Promise<string | null> {
  const executable = process.platform === "win32" ? `${binary}.cmd` : binary;
  const candidates = [
    path.join(targetDir, "node_modules", ".bin", executable),
    path.join(workspacePath, "node_modules", ".bin", executable),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    // Assigned once the child exists; finishRun detaches it either way.
    let onAbort: () => void = () => undefined;

    const finishRun = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, timedOut, output, durationMs: Date.now() - started });
    };

    let child: ChildProcess;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== "win32",
        env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      });
    } catch (error) {
      output = error instanceof Error ? error.message : String(error);
      finishRun(null);
      return;
    }

    // Task cancellation kills the step's whole process tree, exactly
    // like the step timeout does (Phase 4).
    onAbort = () => {
      output += "\nVerification step aborted";
      killTree(child);
    };
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }

    const append = (chunk: Buffer | string) => {
      if (output.length >= OUTPUT_LIMIT) return;
      output += chunk.toString();
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.on("error", (error) => {
      output += `\n${error instanceof Error ? error.message : String(error)}`;
      finishRun(null);
    });
    child.on("close", (code) => finishRun(code));
  });
}

/**
 * Kill a child process AND its whole process tree: on POSIX the child
 * must have been spawned `detached` (its own process group), and the
 * group is SIGKILLed; on Windows `taskkill /T /F` walks the tree.
 * Exported for the QA runner (execution/qa.ts), whose dev server spawns
 * grandchildren (package-manager shims, watcher processes) that a plain
 * child.kill() would orphan (Phase 4 hardening).
 */
export function killTree(child: ChildProcess) {
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
    child.kill("SIGKILL");
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function tail(text: string, limit = DETAIL_LIMIT): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.length <= limit ? trimmed : `...${trimmed.slice(-limit)}`;
}

/**
 * Test counts from common runner summaries (vitest, jest, node:test,
 * mocha). Returns undefined when the output has no recognisable summary —
 * the card then shows the step result without counts, never a guess.
 */
export function parseTestCounts(output: string): { passed: number; total: number } | undefined {
  const text = output.replace(/\u001b\[[0-9;]*m/g, "");
  // vitest: "Tests  9 passed (9)" / "Tests  1 failed | 8 passed (9)"
  const vitest = /Tests\s+(?:\d+\s+\w+\s+\|\s+)*(\d+)\s+passed[^(\n]*\((\d+)\)/.exec(text);
  if (vitest) return { passed: Number(vitest[1]), total: Number(vitest[2]) };
  // jest: "Tests:       9 passed, 9 total"
  const jest = /Tests:\s+(?:\d+\s+\w+,\s+)*(\d+)\s+passed,.*?(\d+)\s+total/.exec(text);
  if (jest) return { passed: Number(jest[1]), total: Number(jest[2]) };
  // node:test: "# pass 9" + "# tests 9"
  const nodePass = /^# pass (\d+)/m.exec(text);
  const nodeTotal = /^# tests (\d+)/m.exec(text);
  if (nodePass && nodeTotal) return { passed: Number(nodePass[1]), total: Number(nodeTotal[1]) };
  // mocha: "9 passing"
  const mocha = /^\s*(\d+) passing/m.exec(text);
  if (mocha) {
    const failing = /^\s*(\d+) failing/m.exec(text);
    const passed = Number(mocha[1]);
    return { passed, total: passed + (failing ? Number(failing[1]) : 0) };
  }
  return undefined;
}
