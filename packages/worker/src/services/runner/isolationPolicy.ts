/**
 * L3 (P1c): ORCHESTRATOR_WORKTREE_ISOLATION=auto, decided per task.
 *
 * Isolation is ON, with ORCHESTRATOR_PARALLEL_DEFAULT (default 2) parallel
 * nodes, when the project folder is a git repository with at least one
 * commit, its checkout is clean, and the FharaRuntime backend can reach the
 * worker's disk (local or self-hosted; the worktree step runs in a FharaRuntime
 * Node action). Otherwise the task runs in the checkout one step at a
 * time. A dirty checkout gets one System line per task, because a worktree
 * starts from the base branch and would not see the uncommitted edits.
 *
 * Explicit 1 / 0 never come here: the worker-wide policy is used as is.
 * An explicit ORCHESTRATOR_MAX_CONCURRENCY / _MAX_CONCURRENT_LLM_CALLS wins
 * over the width picked here.
 */
import { wenv } from "@fhara/config/worker";
import { checkRepoReadiness, FHARA_PROJECT_DIR, LEGACY_WORKTREES_DIR, type RepoReadiness } from "@/api/functions/lib/repoReadiness";
import { backendLocality, type BackendLocality } from "@/api/functions/lib/backendLocality";
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

/** Generated paths that never need to block worktree isolation. */
const IGNORED_CLEAN_PATHS = [
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".fhara",
  LEGACY_WORKTREES_DIR,
  FHARA_PROJECT_DIR,
];

const GENERATED_LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

const IGNORED_CHECK_INPUT = /(^|\/)\.(generated|astro)\/|\.d\.ts$|(^|\/)\.env[^/]*$/;
const IN_NODE_MODULES = /(^|\/)node_modules(\/|$)/;

export function hasIgnoredCheckInputs(listing: string): boolean {
  return listing
    .split("\0")
    .some((entry) => {
      const file = entry.trim().replace(/\\/g, "/");
      return !!file && !IN_NODE_MODULES.test(file) && IGNORED_CHECK_INPUT.test(file);
    });
}

export function hasUncommittedChanges(porcelain: string): boolean {
  return porcelain
    .split(/\r?\n/)
    .filter((line) => line.length >= 3)
    .some((line) => {
      const status = line.slice(0, 2);
      const file = line.slice(3).replace(/^"|"$/g, "").trim();
      if (status === "!!") return false;
      if (!file) return false;
      if (status.includes("R") || status.includes("C")) {
        const target = file.split(" -> ").pop() ?? file;
        return hasUncommittedChanges(`?? ${target}`);
      }
      const segments = file.replace(/\\/g, "/").split("/").filter(Boolean);
      if (segments.some((segment) => IGNORED_CLEAN_PATHS.includes(segment))) return false;
      if (GENERATED_LOCKFILES.has(segments.at(-1) ?? "")) return false;
      return true;
    });
}

/** Worker-side probe: the backend from the worker's FharaRuntime URL, then git in the project folder (read-only listing git). */
export function probeIsolation(
  workspacePath: string,
  runtimeUrl: string | undefined = wenv("FHARA_BACKEND_URL"),
  git: (args: string[]) => string = (args) => untrustedGitSync(workspacePath, args)
): IsolationProbe {
  const backend = backendLocality(runtimeUrl);
  if (backend === "cloud" || backend === "unknown") return { backend };
  const readiness = checkRepoReadiness(git).state;
  if (readiness !== "ready") return { backend, readiness };
  let dirty = true;
  try {
    const status = git(["status", "--porcelain", "--untracked-files=normal"]);
    const ignored = git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
    dirty = hasUncommittedChanges(status) || hasIgnoredCheckInputs(ignored);
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
