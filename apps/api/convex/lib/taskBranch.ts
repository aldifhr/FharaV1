/**
 * Task branch names: `fhara/<taskId>/<slug>`. Branches created before the
 * MOAgent -> Fhara rename use `moagent/<taskId>/<slug>`; they are still
 * recognized wherever a branch name is parsed or matched, so old worktrees
 * keep merging, discarding and getting cleaned up. The worktree directory
 * (`.moagent-worktrees`) intentionally keeps its old name.
 */

export const TASK_BRANCH_PREFIX = "fhara/";
export const LEGACY_TASK_BRANCH_PREFIXES: readonly string[] = ["moagent/"];
export const TASK_BRANCH_PREFIXES: readonly string[] = [TASK_BRANCH_PREFIX, ...LEGACY_TASK_BRANCH_PREFIXES];

export function makeTaskBranchName(taskId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${TASK_BRANCH_PREFIX}${taskId}/${slug || "task"}`;
}

/** Every prefix a branch of this task may carry (`fhara/<id>/`, `moagent/<id>/`). */
export function taskBranchPrefixes(taskId: string): string[] {
  return TASK_BRANCH_PREFIXES.map((prefix) => `${prefix}${taskId}/`);
}

/** `{ taskId, slug }` for a task branch (current or legacy prefix), else null. */
export function parseTaskBranch(branch: string): { prefix: string; taskId: string; slug: string } | null {
  const name = branch.replace(/^refs\/heads\//, "");
  for (const prefix of TASK_BRANCH_PREFIXES) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    return { prefix, taskId: rest.slice(0, slash), slug: rest.slice(slash + 1) };
  }
  return null;
}

export function isTaskBranch(branch: string): boolean {
  return parseTaskBranch(branch) !== null;
}

/**
 * Worktrees from `git worktree list --porcelain` whose branch belongs to
 * this task under any known prefix.
 */
export function taskWorktreesFromPorcelain(porcelain: string, taskId: string): string[] {
  const prefixes = taskBranchPrefixes(taskId);
  const paths: string[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    let path: string | undefined;
    let branch: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
    if (path && branch && prefixes.some((prefix) => branch!.startsWith(prefix))) paths.push(path);
  }
  return paths;
}

/**
 * A project's base branch as typed by the user ("main", "master",
 * "release/2.x"): trimmed, or null for "auto-detect". Throws on a name git
 * would refuse (spaces, "..", a leading "-", control characters, …).
 */
export function normalizeMainBranch(raw: string | undefined): string | null {
  const name = (raw ?? "").trim();
  if (!name) return null;
  const invalid =
    name.length > 200 ||
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    name.includes("//") ||
    name.includes("@{") ||
    /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(name);
  if (invalid) throw new Error(`Invalid base branch name: ${name}`);
  return name;
}

/**
 * The branch task worktrees start from and merge back into. The project's
 * configured `mainBranch` wins; otherwise detect it from the repository:
 * origin/HEAD, then a local `main`, then `master`, then the checked-out
 * branch. `git` runs one git command in the repository and throws on a
 * non-zero exit. Falls back to "main" when nothing answers.
 */
export function resolveMainBranch(configured: string | undefined, git: (args: string[]) => string): string {
  const own = normalizeMainBranch(configured);
  if (own) return own;
  const attempt = (args: string[]): string | null => {
    try {
      return git(args).trim() || null;
    } catch {
      return null;
    }
  };
  const originHead = attempt(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) {
    const name = originHead.replace(/^origin\//, "");
    if (name && name !== "HEAD" && attempt(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) return name;
  }
  for (const candidate of ["main", "master"]) {
    if (attempt(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`])) return candidate;
  }
  const current = attempt(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return current ?? "main";
}

