import type { HostCheckCardData, VerificationCardData } from "@/api/convex/cardTypes";
import { runProjectScript, type ProjectScriptOutcome } from "@/execution/projectScriptRun";
import { checkProjectScript, setupProjectScript } from "@/vendor/goat/projectScripts";
import type { WorkerApi } from "@/workerApi";
import { postStageCard } from "./cards";

/**
 * GOAT G9 / threadbear T6: the two moments a project's scripts run.
 *
 * - Setup: once, when the worker gets a NEW worktree for a task
 *   (`createBranch` answered `created: true`). A failure is
 *   reported in the task's events and chat; the run continues, since the
 *   agents can still read the code and may fix what setup needed.
 * - Host check: after the task is Done, in the worktree, with the 10 min
 *   timeout and the 40-line / 4k tail. It posts one verification card that
 *   shows what the agents reported next to what the host saw.
 */
type HookApi = Pick<WorkerApi, "logEvent" | "postTaskCard"> & Partial<Pick<WorkerApi, "appendAgentMessage">>;
type RunScript = typeof runProjectScript;

export interface ScriptHookTarget {
  taskId: string;
  projectId: string;
  scripts: unknown;
  projectRoot: string;
  worktreePath?: string | null;
  signal?: AbortSignal;
}

/** Runs the setup script for a new worktree. Null when nothing ran (not new, or none configured). */
export async function runSetupOnWorktreeCreate(
  api: HookApi,
  target: ScriptHookTarget & { created?: boolean },
  run: RunScript = runProjectScript
): Promise<ProjectScriptOutcome | null> {
  if (!target.created || !target.worktreePath) return null;
  const argv = setupProjectScript(target.scripts);
  if (!argv) return null;
  const outcome = await run({
    kind: "setup",
    argv,
    projectRoot: target.projectRoot,
    worktreePath: target.worktreePath,
    signal: target.signal,
  });
  const ok = outcome.status === "passed";
  await api
    .logEvent({
      taskId: target.taskId as never,
      projectId: target.projectId as never,
      type: "task.setup_script",
      level: ok ? "info" : "warn",
      payload: { command: outcome.command, status: outcome.status, exitCode: outcome.exitCode, durationMs: outcome.durationMs, tail: outcome.tail },
    })
    .catch(() => undefined);
  if (!ok && api.appendAgentMessage) {
    await api
      .appendAgentMessage({
        projectId: target.projectId as never,
        taskId: target.taskId as never,
        content: `Setup script \`${outcome.command}\` ${setupFailureText(outcome)} in the new worktree. The run continues; checks that need it may fail.`,
      })
      .catch(() => undefined);
  }
  return outcome;
}

function setupFailureText(outcome: ProjectScriptOutcome): string {
  if (outcome.status === "timed_out") return "timed out";
  if (outcome.status === "blocked") return "was blocked";
  if (outcome.status === "error") return `could not run (${outcome.detail ?? "error"})`;
  return `failed with exit code ${outcome.exitCode ?? "unknown"}`;
}

export function hostCheckCard(outcome: ProjectScriptOutcome): HostCheckCardData {
  return {
    status: outcome.status,
    ...(outcome.command ? { command: outcome.command } : {}),
    ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
    ...(outcome.durationMs ? { durationMs: outcome.durationMs } : {}),
    ...(outcome.tail ? { tail: outcome.tail } : {}),
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  };
}

/**
 * The card's overall outcome follows the HOST: passed only when the host
 * check passed. No check configured is inconclusive, never passed.
 */
export function hostCheckOutcome(status: HostCheckCardData["status"]): VerificationCardData["outcome"] {
  if (status === "passed") return "passed";
  if (status === "failed" || status === "timed_out") return "failed";
  return "inconclusive";
}

/** Runs the project's check after Done and posts the "Agent reported" / "Host check" card. */
export async function runHostCheckAfterDone(
  api: HookApi,
  target: ScriptHookTarget & { agentOutcome: VerificationCardData["outcome"] },
  run: RunScript = runProjectScript
): Promise<ProjectScriptOutcome> {
  const outcome = await run({
    kind: "check",
    argv: checkProjectScript(target.scripts),
    projectRoot: target.projectRoot,
    worktreePath: target.worktreePath,
    signal: target.signal,
  });
  const hostCheck = hostCheckCard(outcome);
  await postStageCard(api, {
    taskId: target.taskId,
    projectId: target.projectId,
    kind: "verification",
    data: {
      taskId: "",
      iteration: 0,
      outcome: hostCheckOutcome(hostCheck.status),
      checks: [],
      ...(outcome.durationMs ? { durationMs: outcome.durationMs } : {}),
      agentOutcome: target.agentOutcome,
      hostCheck,
      idempotencyKey: `host-check:${target.taskId}`,
    },
  });
  return outcome;
}
