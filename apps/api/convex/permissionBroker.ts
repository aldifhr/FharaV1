import { query } from "./_generated/server";
import { v } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess, getVisibleTask } from "./lib/authz";

/**
 * Plan 015 — central authorization broker.
 *
 * One server-side decision point for risky agent actions:
 *  - "allow": a live approval covers this task + plan version + every
 *    target file.
 *  - "ask": no covering approval exists yet; the runner must request one.
 *  - "deny": a target is outside the workspace, the task is terminal, or a
 *    rejection for this same plan version / file set stands.
 *
 * This is a read-only verdict function — recording the approval itself
 * still flows through `orchestration.requestApproval` (token-gated) and
 * resolvers in `approvals.ts`.
 *
 * Two entry points share the core:
 *  - the worker path (`orchestration.checkPermission`, reached through the
 *    service-token action `worker.checkPermission`) runs with
 *    `trusted: true`. The worker has no user identity, so the viewer-based
 *    project check would deny every owned project; the service token is
 *    the authorization there.
 *  - the public `decidePermission` query keeps the viewer check.
 */

export type PermissionDecision = "allow" | "deny" | "ask";

const RISKY_KINDS = new Set(["apply_changes", "git_push", "run_command", "merge_pr"]);
const TERMINAL_TASK_STATUSES = new Set(["done", "failed", "rejected"]);

// ---------------------------------------------------------------------------
// Path handling. The backend cannot use node:path (default runtime), and the
// worker may run on Windows, so both separators are accepted and drive
// letters compare case-insensitively.
// ---------------------------------------------------------------------------

interface ParsedPath {
  /** "" for a relative path, "/" for POSIX absolute, "c:" for a drive, "//" for UNC. */
  root: string;
  segments: string[];
  /** Windows-style paths compare case-insensitively. */
  caseInsensitive: boolean;
}

function parsePath(raw: string): ParsedPath {
  let p = raw.trim().replace(/^file:\/\//i, "").replace(/\\/g, "/");
  let root = "";
  let caseInsensitive = false;
  const drive = /^([a-zA-Z]):(\/|$)/.exec(p);
  if (drive) {
    root = `${drive[1].toLowerCase()}:`;
    p = p.slice(2);
    caseInsensitive = true;
  } else if (p.startsWith("//")) {
    root = "//";
    caseInsensitive = true;
  } else if (/^\/[a-zA-Z]:(\/|$)/.test(p)) {
    // file:///C:/x leaves "/C:/x"
    root = `${p[1].toLowerCase()}:`;
    p = p.slice(3);
    caseInsensitive = true;
  } else if (p.startsWith("/")) {
    root = "/";
  }
  const segments = p.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  return { root, segments, caseInsensitive };
}

/** Resolve ".." segments. Returns null when ".." climbs above the start. */
function collapse(segments: string[]): string[] | null {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out;
}

function sameSegment(a: string, b: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function startsWithSegments(full: string[], prefix: string[], ci: boolean): boolean {
  if (prefix.length > full.length) return false;
  return prefix.every((segment, index) => sameSegment(full[index], segment, ci));
}

export interface ResolvedTarget {
  /** Target is outside the workspace root. */
  escapes: boolean;
  /** Workspace-relative path with forward slashes ("" for the root itself). */
  relative: string;
}

/**
 * Resolve `target` against the project's `workspaceRoot`.
 *
 * - A relative target is joined onto the root ("src/a.ts", "./src/a.ts").
 * - An absolute target must lie under the root.
 * - A relative workspaceRoot (allowed by projects.validateWorkspacePath) is
 *   resolved by the worker against its own WORKSPACE_ROOT, which the backend
 *   does not know. `resolvedRoot` (sent by the worker) is used when it ends
 *   with the project's relative root; otherwise an absolute target is
 *   accepted when the relative root's segments appear in it as a contiguous
 *   run, and the remainder is the workspace-relative path.
 */
export function resolveWorkspaceTarget(
  workspaceRoot: string,
  target: string,
  resolvedRoot?: string
): ResolvedTarget {
  const rootParsed = parsePath(workspaceRoot);
  const rootSegments = collapse(rootParsed.segments);
  if (!rootSegments) return { escapes: true, relative: "" };

  let effectiveRoot: ParsedPath = { ...rootParsed, segments: rootSegments };
  if (!rootParsed.root && resolvedRoot) {
    const candidate = parsePath(resolvedRoot);
    const candidateSegments = collapse(candidate.segments);
    if (
      candidate.root &&
      candidateSegments &&
      candidateSegments.length >= rootSegments.length &&
      rootSegments.every((segment, index) =>
        sameSegment(
          candidateSegments[candidateSegments.length - rootSegments.length + index],
          segment,
          candidate.caseInsensitive
        )
      )
    ) {
      effectiveRoot = { ...candidate, segments: candidateSegments };
    }
  }

  const targetParsed = parsePath(target);
  const ci = effectiveRoot.caseInsensitive || targetParsed.caseInsensitive;

  if (!targetParsed.root) {
    // Relative target: workspace-relative by definition.
    const relativeSegments = collapse(targetParsed.segments);
    if (!relativeSegments) return { escapes: true, relative: "" };
    return { escapes: false, relative: relativeSegments.join("/") };
  }

  const targetSegments = collapse(targetParsed.segments);
  if (!targetSegments) return { escapes: true, relative: "" };

  if (effectiveRoot.root) {
    if (!sameSegment(effectiveRoot.root, targetParsed.root, ci)) {
      return { escapes: true, relative: "" };
    }
    if (!startsWithSegments(targetSegments, effectiveRoot.segments, ci)) {
      return { escapes: true, relative: "" };
    }
    return {
      escapes: false,
      relative: targetSegments.slice(effectiveRoot.segments.length).join("/"),
    };
  }

  // Relative project root, absolute target, no usable resolvedRoot: find the
  // root's segments as a contiguous run inside the target.
  if (effectiveRoot.segments.length === 0) return { escapes: true, relative: "" };
  for (let start = 0; start + effectiveRoot.segments.length <= targetSegments.length; start++) {
    const window = targetSegments.slice(start, start + effectiveRoot.segments.length);
    if (startsWithSegments(window, effectiveRoot.segments, ci)) {
      return {
        escapes: false,
        relative: targetSegments.slice(start + effectiveRoot.segments.length).join("/"),
      };
    }
  }
  return { escapes: true, relative: "" };
}

function normalizeRelative(path: string): string {
  const parsed = parsePath(path);
  return (collapse(parsed.segments) ?? parsed.segments).join("/");
}

// ---------------------------------------------------------------------------
// Approval matching
// ---------------------------------------------------------------------------

function approvalPlanVersion(row: Doc<"approvals">): number | undefined {
  if (typeof row.planVersion === "number") return row.planVersion;
  const fromPayload = (row.payload as { planVersion?: unknown } | undefined)?.planVersion;
  return typeof fromPayload === "number" ? fromPayload : undefined;
}

function approvalFiles(row: Doc<"approvals">): Set<string> | null {
  const files = (row.payload as { filePaths?: unknown } | undefined)?.filePaths;
  if (!Array.isArray(files)) return null;
  return new Set(
    files.filter((file): file is string => typeof file === "string").map(normalizeRelative)
  );
}

function versionMatches(row: Doc<"approvals">, current: number | undefined): boolean {
  const rowVersion = approvalPlanVersion(row);
  // Legacy rows without a version (and callers that cannot tell) match.
  return rowVersion === undefined || current === undefined || rowVersion === current;
}

/** Every target file is listed by the approval (legacy rows without a list cover all). */
function coversFiles(row: Doc<"approvals">, targets: string[]): boolean {
  const files = approvalFiles(row);
  if (!files) return true;
  return targets.every((target) => files.has(target));
}

/** The rejection was about at least one of these files (legacy rows: all). */
function overlapsFiles(row: Doc<"approvals">, targets: string[]): boolean {
  const files = approvalFiles(row);
  if (!files || targets.length === 0) return true;
  return targets.some((target) => files.has(target));
}

function decidedAt(row: Doc<"approvals">): number {
  return row.resolvedAt ?? row._creationTime;
}

export interface DecidePermissionArgs {
  taskId: Id<"tasks">;
  projectId: Id<"projects">;
  kind: "apply_changes" | "git_push" | "run_command" | "merge_pr";
  /** Primary target (absolute, or workspace-relative). */
  targetPath: string;
  /** Every file in the batch; each one is checked (not just the first). */
  targetPaths?: string[];
  /** The plan version the action belongs to; defaults to task.planVersion. */
  planVersion?: number;
  /** The worker's resolved absolute workspace root (for relative project paths). */
  workspaceRoot?: string;
}

export async function decidePermissionCore(
  ctx: QueryCtx,
  args: DecidePermissionArgs,
  options: { trusted?: boolean } = {}
): Promise<{ decision: PermissionDecision; reason: string; approvalId?: string }> {
  let project: Doc<"projects"> | null;
  let task: Doc<"tasks"> | null;
  if (options.trusted) {
    // Service-token path: the worker has no viewer identity.
    project = await ctx.db.get(args.projectId);
    if (!project) return { decision: "deny", reason: "Project not found" };
    task = await ctx.db.get(args.taskId);
    if (!task) return { decision: "deny", reason: "Task not found" };
  } else {
    try {
      project = await assertProjectAccess(ctx, args.projectId);
    } catch {
      return { decision: "deny", reason: "Project not visible" };
    }
    task = await getVisibleTask(ctx, args.taskId);
    if (!task) return { decision: "deny", reason: "Task not visible" };
  }
  if (task.projectId !== project._id) {
    return { decision: "deny", reason: "Task does not belong to this project" };
  }
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    return { decision: "deny", reason: `Task is already ${task.status}` };
  }
  if (!RISKY_KINDS.has(args.kind)) {
    return { decision: "allow", reason: `Kind "${args.kind}" is not gated by the broker` };
  }

  // Check EVERY target in the batch against the workspace root.
  const rawTargets = [
    ...(args.targetPath?.trim() ? [args.targetPath] : []),
    ...(args.targetPaths ?? []).filter((target) => target.trim().length > 0),
  ];
  const relativeTargets = new Set<string>();
  const workspaceRoot = project.workspacePath;
  for (const target of rawTargets) {
    if (workspaceRoot) {
      const resolved = resolveWorkspaceTarget(workspaceRoot, target, args.workspaceRoot);
      if (resolved.escapes) {
        return {
          decision: "deny",
          reason: `Target path escapes the workspace root: ${target}`,
        };
      }
      if (resolved.relative) relativeTargets.add(resolved.relative);
    } else {
      const relative = normalizeRelative(target);
      if (relative) relativeTargets.add(relative);
    }
  }
  const targets = [...relativeTargets];
  const currentVersion = args.planVersion ?? task.planVersion;

  const now = Date.now();
  const rows = await ctx.db
    .query("approvals")
    .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
    .collect();
  const live = rows.filter(
    (row) =>
      row.kind === args.kind &&
      row.status !== "cancelled" &&
      (row.expiresAt === undefined || row.expiresAt > now)
  );

  // An approval covers only its own plan version and the files it listed:
  // a later fix loop / replan touching new files must ask again.
  const approved = live
    .filter(
      (row) =>
        row.status === "approved" &&
        versionMatches(row, currentVersion) &&
        coversFiles(row, targets)
    )
    .sort((a, b) => decidedAt(b) - decidedAt(a));

  // A rejection denies only when it is about this plan version and these
  // files, and no later approval superseded it. An old rejection (previous
  // plan version, other files) asks again instead of denying forever.
  const rejected = live
    .filter(
      (row) =>
        row.status === "rejected" &&
        versionMatches(row, currentVersion) &&
        overlapsFiles(row, targets)
    )
    .sort((a, b) => decidedAt(b) - decidedAt(a));

  const latestApproved = approved[0];
  const latestRejected = rejected[0];
  if (latestRejected && (!latestApproved || decidedAt(latestRejected) > decidedAt(latestApproved))) {
    return {
      decision: "deny",
      reason: "Previously rejected; a new request is required",
      approvalId: latestRejected._id as string,
    };
  }
  if (latestApproved) {
    return {
      decision: "allow",
      reason: "Covered by approved approval",
      approvalId: latestApproved._id as string,
    };
  }
  const pending = live.find((row) => row.status === "pending");
  if (pending) {
    return {
      decision: "ask",
      reason: "Approval already pending for this action",
      approvalId: pending._id as string,
    };
  }
  return { decision: "ask", reason: "No approval covers this action yet" };
}

const permissionArgs = {
  taskId: v.id("tasks"),
  projectId: v.id("projects"),
  kind: v.union(
    v.literal("apply_changes"),
    v.literal("git_push"),
    v.literal("run_command"),
    v.literal("merge_pr")
  ),
  targetPath: v.string(),
  targetPaths: v.optional(v.array(v.string())),
  planVersion: v.optional(v.number()),
  workspaceRoot: v.optional(v.string()),
};

export { permissionArgs };

export const decidePermission = query({
  args: permissionArgs,
  handler: async (ctx, args) => await decidePermissionCore(ctx, args),
});
