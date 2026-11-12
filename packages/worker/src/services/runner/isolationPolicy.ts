/**
 * L3 (P1c): ORCHESTRATOR_WORKTREE_ISOLATION=auto, decided per task.
 *
 * Isolation is ON, with ORCHESTRATOR_PARALLEL_DEFAULT (default 2) parallel
 * nodes, when the project folder is a git repository with at least one
 * commit, its checkout is clean, and the Convex backend can reach the
 * worker's disk (local or self-hosted; the worktree step runs in a Convex
 * Node action). Otherwise the task runs in the checkout one step at a
 * time. A dirty checkout gets one System line per task, because a worktree
 * starts from the base branch and would not see the uncommitted edits.
 *
 * Explicit 1 / 0 never come here: the worker-wide policy is used as is.
 * An explicit ORCHESTRATOR_MAX_CONCURRENCY / _MAX_CONCURRENT_LLM_CALLS wins
 * over the width picked here.
 */
import { wenv } from "@fhara/config/worker";
import { checkRepoReadiness, WORKTREES_DIR, type RepoReadiness } from "@/api/convex/lib/repoReadiness";
import { backendLocality, type BackendLocality } from "@/api/convex/lib/backendLocality";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import { untrustedGitSync } from "@/vendor/threadbear/safeGit";
import { postSystemLine } from "./systemLines";
import type { RunnerDeps } from "./types";

export const DIRTY_CHECKOUT_LINE = "Running steps one at a time: the folder has uncommitted changes.";

export interface IsolationProbe {
  backend: BackendLocality;
  /** Not probed (undefined) when the backend already rules isolation out. */
  readiness?: RepoReadiness["state"];
  dirty?: boolean;
}

export type IsolationReason = "ready" | "cloud_backend" | "unknown_backend" | "not_git" | "no_commits" | "dirty";

export interface IsolationDecision {
  isolate: boolean;
  reason: IsolationReason;
  /** The System line to post (once per task), if any. */
  notice?: string;
}

/** Pure: the auto decision for one probe. Anything unknown is sequential. */
export function decideAutoIsolation(probe: IsolationProbe): IsolationDecision {
  if (probe.backend === "cloud") return { isolate: false, reason: "cloud_backend" };
  if (probe.backend === "unknown") return { isolate: false, reason: "unknown_backend" };
  if (probe.readiness === "not_git") return { isolate: false, reason: "not_git" };
  if (probe.readiness !== "ready") return { isolate: false, reason: "no_commits" };
  if (probe.dirty !== false) return { isolate: false, reason: "dirty", notice: DIRTY_CHECKOUT_LINE };
  return { isolate: true, reason: "ready" };
}

/** The task's policy once isolation is known: width PARALLEL_DEFAULT when on, 1 when off, explicit values kept. */
export function policyForIsolation(policy: ExecutionPolicy, isolate: boolean): ExecutionPolicy {
  const width = isolate ? Math.max(1, Math.floor(policy.parallelDefault ?? 2)) : 1;
  return {
    ...policy,
    worktreeIsolation: isolate,
    maxConcurrency: policy.maxConcurrencyExplicit ? policy.maxConcurrency : width,
    maxConcurrentLLMCalls: policy.maxConcurrentLLMCallsExplicit ? policy.maxConcurrentLLMCalls : width,
  };
}

/** A resumed auto task keeps what its first run chose: isolated iff it has a worktree. */
export function policyForResume(policy: ExecutionPolicy, hasWorktree: boolean): ExecutionPolicy {
  return policy.worktreeIsolationAuto ? policyForIsolation(policy, hasWorktree) : policy;
}

/** Porcelain status lines, minus the task worktrees directory itself. */
export function hasUncommittedChanges(porcelain: string): boolean {
  return porcelain
    .split(/\r?\n/)
    .map((line) => line.slice(3).replace(/^"|"$/g, ""))
    .some((file) => file.trim() !== "" && !file.startsWith(`${WORKTREES_DIR}/`) && file !== WORKTREES_DIR);
}

/** Worker-side probe: the backend from the worker's Convex URL, then git in the project folder (read-only listing git). */
export function probeIsolation(
  workspacePath: string,
  convexUrl: string | undefined = wenv("NEXT_PUBLIC_CONVEX_URL"),
  git: (args: string[]) => string = (args) => untrustedGitSync(workspacePath, args)
): IsolationProbe {
  const backend = backendLocality(convexUrl);
  if (backend === "cloud" || backend === "unknown") return { backend };
  const readiness = checkRepoReadiness(git).state;
  if (readiness !== "ready") return { backend, readiness };
  let dirty = true;
  try {
    dirty = hasUncommittedChanges(git(["status", "--porcelain", "--untracked-files=normal"]));
  } catch {
    // Unknown counts as dirty: stay sequential in the checkout.
  }
  return { backend, readiness, dirty };
}

/** Tasks that already got the dirty-checkout line from this worker (the backend also dedupes per task). */
const noticed = new Set<string>();

/**
 * processTask: with auto, probe this task's folder and return deps carrying
 * the task's own isolation and width. Explicit 1 / 0 return deps unchanged.
 */
export async function resolveTaskIsolation(
  deps: RunnerDeps,
  input: { taskId: string; projectId: string; workspacePath: string },
  probe: (workspacePath: string) => IsolationProbe = probeIsolation
): Promise<RunnerDeps> {
  if (!deps.policy.worktreeIsolationAuto) return deps;
  const decision = decideAutoIsolation(probe(input.workspacePath));
  const policy = policyForIsolation(deps.policy, decision.isolate);
  await deps.api
    .logEvent({
      taskId: input.taskId as never,
      projectId: input.projectId as never,
      type: "task.isolation",
      payload: { mode: "auto", isolate: decision.isolate, reason: decision.reason, maxConcurrency: policy.maxConcurrency },
    })
    ?.catch(() => undefined);
  if (decision.notice && !noticed.has(String(input.taskId))) {
    noticed.add(String(input.taskId));
    await postSystemLine(deps, { taskId: input.taskId, projectId: input.projectId, content: decision.notice });
  }
  return { ...deps, policy };
}
