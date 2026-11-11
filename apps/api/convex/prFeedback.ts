import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { taskCardConversationId } from "./lib/conversationScope";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { resolveGithubToken } from "./lib/githubAuth";
import {
  TERMINAL_TASK,
  buildFixPrompt,
  checkStatus,
  derivePrLane,
  desiredNotifications,
  fixMaxAttempts,
  fixTaskTitle,
  foldCheck,
  foldReview,
  logTail,
  planReaction,
  type FixDetails,
  type FixKind,
  type PrSignal,
  type ReactionPlan,
  type ReviewComment,
} from "./lib/prFeedback";
import { appendTaskEvent } from "./lib/taskEvents";
import { loadSettingValues } from "./appSettings";
import { settingFrom } from "./lib/appSettings";
import { onIssueTaskChanged } from "./issueIntake";
import { syncTaskThread } from "./lib/threadIndex";

/** Settings → Diffs & PR: the UI cap overrides FHARA_PR_FIX_MAX_ATTEMPTS. */
async function fixMaxAttemptsFor(ctx: Parameters<typeof loadSettingValues>[0]): Promise<number> {
  return fixMaxAttempts(settingFrom(await loadSettingValues(ctx), "FHARA_PR_FIX_MAX_ATTEMPTS"));
}

/**
 * Post-push feedback loop.
 *
 *  1. `integrations.handleWebhook` verifies a delivery, parses it with
 *     `parsePrSignal` and calls `ingest`. The refresh cron feeds the same
 *     path (`ingestSignal`) with the PR's state and mergeability.
 *  2. `ingest` links the signal to the pushed PR rows (`taskPushes`, same
 *     project, same repo + PR number, or the check's head branch), stores
 *     CI / review / mergeability on them, and, when the project turned
 *     reactions on, queues a reaction deduped on (PR, signature) and capped
 *     per PR (FHARA_PR_FIX_MAX_ATTEMPTS, default 3).
 *  3. `react` (scheduled) reads the CI log tail or the review comments from
 *     GitHub and `createFixTask` queues a task owned by the original task,
 *     on its branch and worktree. Its commit gets a normal push card, so
 *     every fix push still needs the user's click.
 *  4. Notifications are recomputed from the facts on every change
 *     (`syncPrNotifications`) and resolve themselves.
 */

const ROW_SCAN = 200;
const MAX_COMMENTS = 50;
/** Wait for sibling deliveries (other checks, a review's comments). */
const REACT_DELAY_MS: Record<FixKind, number> = {
  ci_failed: 45_000,
  changes_requested: 20_000,
  review_comments: 20_000,
  merge_conflict: 0,
};

type PushRow = Doc<"taskPushes">;
type Ctx = QueryCtx | MutationCtx;

const ownerOf = (row: PushRow): Id<"tasks"> => row.ownerTaskId ?? row.taskId;
const newest = (rows: PushRow[]): PushRow | null =>
  rows.reduce<PushRow | null>((best, row) => (!best || row.createdAt > best.createdAt ? row : best), null);

/** Rows of one PR inside one project. */
async function prRows(ctx: Ctx, projectId: Id<"projects">, repoFullName: string, prNumber: number): Promise<PushRow[]> {
  const rows = await ctx.db
    .query("taskPushes")
    .withIndex("by_repo_pr", (q) => q.eq("repoFullName", repoFullName).eq("prNumber", prNumber))
    .take(ROW_SCAN);
  return rows.filter((row) => row.projectId === projectId);
}

/** Rows a signal is about (a check run may name no PR, only its branch). */
async function rowsForSignal(ctx: Ctx, projectId: Id<"projects">, signal: PrSignal): Promise<PushRow[]> {
  if (signal.kind !== "check_run") return await prRows(ctx, projectId, signal.repoFullName, signal.prNumber);
  if (signal.prNumbers.length > 0) {
    const out: PushRow[] = [];
    for (const n of signal.prNumbers.slice(0, 5)) out.push(...(await prRows(ctx, projectId, signal.repoFullName, n)));
    return out;
  }
  if (!signal.headBranch) return [];
  const rows = await ctx.db
    .query("taskPushes")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .order("desc")
    .take(ROW_SCAN);
  return rows.filter(
    (row) => row.branchName === signal.headBranch && row.prNumber !== undefined && row.repoFullName === signal.repoFullName
  );
}

/** The owner task's newest row that has a PR (its own pushes and its fixes'). */
export async function latestPrRow(ctx: Ctx, ownerTaskId: Id<"tasks">): Promise<PushRow | null> {
  const own = await ctx.db.query("taskPushes").withIndex("by_task", (q) => q.eq("taskId", ownerTaskId)).take(ROW_SCAN);
  const fixes = await ctx.db
    .query("taskPushes")
    .withIndex("by_owner_task", (q) => q.eq("ownerTaskId", ownerTaskId))
    .take(ROW_SCAN);
  return newest([...own, ...fixes].filter((row) => row.prNumber !== undefined));
}

/**
 * Fhara is still working on this PR: a fix task (PR reaction or review
 * round) is running, or its commit waits for (or is in) the user's push.
 * A new reaction or review round waits until then.
 */
export async function fixInFlight(ctx: Ctx, ownerTaskId: Id<"tasks">): Promise<boolean> {
  const fixes = await ctx.db.query("tasks").withIndex("by_parent", (q) => q.eq("parentTaskId", ownerTaskId)).take(50);
  for (const fix of fixes) {
    if (!fix.prFix && !fix.reviewFix) continue;
    if (!TERMINAL_TASK.has(fix.status)) return true;
    if (fix.status !== "done") continue;
    const pushes = await ctx.db.query("taskPushes").withIndex("by_task", (q) => q.eq("taskId", fix._id)).take(20);
    if (pushes.some((p) => (p.status === "ready" && p.heldAt === undefined) || p.status === "requested" || p.status === "pushing")) {
      return true;
    }
  }
  return false;
}

async function createdCount(ctx: Ctx, repoFullName: string, prNumber: number): Promise<number> {
  const rows = await ctx.db
    .query("prReactions")
    .withIndex("by_pr_and_status", (q) => q.eq("repoFullName", repoFullName).eq("prNumber", prNumber).eq("status", "created"))
    .take(100);
  return rows.length;
}

async function logOwnerEvent(
  ctx: MutationCtx,
  ownerTaskId: Id<"tasks">,
  projectId: Id<"projects">,
  type: string,
  payload: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info"
) {
  await appendTaskEvent(ctx, { taskId: ownerTaskId, projectId, type, payload, level, createdAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

type FactPatch = Partial<
  Pick<PushRow, "prState" | "headSha" | "ciState" | "ciChecks" | "reviewState" | "mergeable" | "lastCommentAt">
>;

function factPatchFor(signal: PrSignal, base: PushRow): FactPatch {
  switch (signal.kind) {
    case "check_run": {
      const folded = foldCheck(base, signal.headSha, signal.check);
      return {
        headSha: folded.headSha,
        ciChecks: folded.ciChecks,
        ciState: folded.ciState,
        ...(base.headSha !== signal.headSha ? { mergeable: "unknown" as const } : {}),
      };
    }
    case "review":
      return { reviewState: foldReview(base.reviewState, signal.review.state) };
    case "review_comment":
    case "issue_comment":
      return { lastCommentAt: Date.now() };
    case "pull_request": {
      const patch: FactPatch = { prState: signal.state };
      const moved = signal.headSha !== undefined && signal.headSha !== base.headSha;
      if (moved) {
        // A new head commit: old CI results and mergeability describe the
        // previous commit.
        patch.headSha = signal.headSha;
        patch.ciChecks = [];
        patch.ciState = undefined;
        patch.mergeable = signal.mergeable ?? "unknown";
      } else if (signal.mergeable && signal.mergeable !== "unknown") {
        patch.mergeable = signal.mergeable;
      }
      return patch;
    }
  }
}

/**
 * Link a signal to its PR rows, store the facts, queue a reaction, and
 * refresh notifications. Shared by the webhook and the refresh cron.
 */
export async function ingestSignal(ctx: MutationCtx, projectId: Id<"projects">, signal: PrSignal) {
  const rows = await rowsForSignal(ctx, projectId, signal);
  const base = newest(rows);
  if (!base || base.prNumber === undefined || !base.repoFullName) return { matched: 0, reaction: null };
  const now = Date.now();
  const patch = factPatchFor(signal, base);
  // Every row of the PR carries the same facts (patching only the rows of
  // this PR number, never another PR on the same branch).
  const samePr = rows.filter((row) => row.prNumber === base.prNumber);
  for (const row of samePr) await ctx.db.patch(row._id, { ...patch, prFactsAt: now, updatedAt: now });
  const owner = ownerOf(base);
  const facts = { ...base, ...patch } as PushRow;

  let reaction: string | null = null;
  const plan = planReaction(signal, facts);
  if (plan) reaction = await queueReaction(ctx, facts, owner, plan);

  if (facts.prState === "merged" || facts.prState === "closed") await onPrClosed(ctx, facts, owner);
  else await scheduleAutoMerge(ctx, base.projectId, owner);
  await syncPrNotifications(ctx, owner);
  return { matched: samePr.length, reaction };
}

export const ingest = internalMutation({
  // The signal comes from parsePrSignal on a verified delivery only.
  args: { projectId: v.id("projects"), signal: v.any() },
  handler: async (ctx, args) => await ingestSignal(ctx, args.projectId, args.signal as PrSignal),
});

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

async function queueReaction(ctx: MutationCtx, row: PushRow, ownerTaskId: Id<"tasks">, plan: ReactionPlan): Promise<string> {
  const project = await ctx.db.get(row.projectId);
  if (!project?.prFeedbackReactions) return "disabled";
  if (row.prState !== "open" && row.prState !== "draft") return "pr_not_open";
  const repoFullName = row.repoFullName!;
  const prNumber = row.prNumber!;
  const existing = await ctx.db
    .query("prReactions")
    .withIndex("by_pr_and_signature", (q) =>
      q.eq("repoFullName", repoFullName).eq("prNumber", prNumber).eq("signature", plan.signature)
    )
    .first();
  if (existing) {
    // More comments of a review that is not handed out yet join its fix.
    if ((existing.status === "scheduled" || existing.status === "deferred") && plan.kind === "review_comments") {
      const comments = [...((existing.context?.comments as ReviewComment[] | undefined) ?? [])];
      for (const c of (plan.context.comments as ReviewComment[]) ?? []) {
        if (!comments.some((x) => x.id === c.id) && comments.length < MAX_COMMENTS) comments.push(c);
      }
      await ctx.db.patch(existing._id, { context: { ...existing.context, comments }, updatedAt: Date.now() });
    } else if (
      (existing.status === "scheduled" || existing.status === "deferred") &&
      existing.kind === "review_comments" &&
      plan.kind === "changes_requested"
    ) {
      // The review itself arrived after its comments: keep the body, upgrade the kind.
      await ctx.db.patch(existing._id, {
        kind: "changes_requested",
        context: { ...existing.context, ...plan.context, comments: existing.context?.comments },
        updatedAt: Date.now(),
      });
    } else if ((existing.status === "scheduled" || existing.status === "deferred") && plan.kind === "ci_failed") {
      const checks = [...((existing.context?.checks as unknown[]) ?? [])];
      if (checks.length < 10) checks.push(...((plan.context.checks as unknown[]) ?? []));
      await ctx.db.patch(existing._id, { context: { ...existing.context, checks }, updatedAt: Date.now() });
    }
    return "duplicate";
  }
  const now = Date.now();
  const base = {
    projectId: row.projectId,
    ownerTaskId,
    pushId: row._id,
    repoFullName,
    prNumber,
    kind: plan.kind,
    signature: plan.signature,
    ...(plan.headSha ? { headSha: plan.headSha } : {}),
    context: plan.context,
    createdAt: now,
    updatedAt: now,
  };
  if ((await createdCount(ctx, repoFullName, prNumber)) >= (await fixMaxAttemptsFor(ctx))) {
    await ctx.db.insert("prReactions", { ...base, status: "skipped", skipReason: "cap_reached" });
    await logOwnerEvent(ctx, ownerTaskId, row.projectId, "pr.fix_cap_reached", { prNumber, kind: plan.kind }, "warn");
    return "cap_reached";
  }
  if (await fixInFlight(ctx, ownerTaskId)) {
    await ctx.db.insert("prReactions", { ...base, status: "deferred" });
    return "deferred";
  }
  const reactionId = await ctx.db.insert("prReactions", { ...base, status: "scheduled" });
  await ctx.scheduler.runAfter(REACT_DELAY_MS[plan.kind], internal.prFeedback.react, { reactionId });
  await logOwnerEvent(ctx, ownerTaskId, row.projectId, "pr.reaction_queued", { prNumber, kind: plan.kind, signature: plan.signature });
  return "scheduled";
}

/** A fix settled or was pushed: hand out the oldest deferred reaction. */
async function activateDeferred(ctx: MutationCtx, ownerTaskId: Id<"tasks">) {
  if (await fixInFlight(ctx, ownerTaskId)) return;
  const deferred = (await ctx.db.query("prReactions").withIndex("by_owner_task", (q) => q.eq("ownerTaskId", ownerTaskId)).take(200))
    .filter((r) => r.status === "deferred")
    .sort((a, b) => a.createdAt - b.createdAt);
  const latest = await latestPrRow(ctx, ownerTaskId);
  const now = Date.now();
  for (const reaction of deferred) {
    const stale =
      (reaction.kind === "ci_failed" || reaction.kind === "merge_conflict") &&
      reaction.headSha !== undefined &&
      latest?.headSha !== undefined &&
      reaction.headSha !== latest.headSha;
    if (stale || !latest || (latest.prState !== "open" && latest.prState !== "draft")) {
      await ctx.db.patch(reaction._id, { status: "skipped", skipReason: stale ? "stale_head" : "pr_not_open", updatedAt: now });
      continue;
    }
    if ((await createdCount(ctx, reaction.repoFullName, reaction.prNumber)) >= (await fixMaxAttemptsFor(ctx))) {
      await ctx.db.patch(reaction._id, { status: "skipped", skipReason: "cap_reached", updatedAt: now });
      continue;
    }
    await ctx.db.patch(reaction._id, { status: "scheduled", updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.prFeedback.react, { reactionId: reaction._id });
    return;
  }
}

/** What `react` needs: the reaction, its PR, and a token (internal only). */
export const getReactionWork = internalQuery({
  args: { reactionId: v.id("prReactions") },
  handler: async (ctx, args) => {
    const reaction = await ctx.db.get(args.reactionId);
    if (!reaction || reaction.status !== "scheduled") return null;
    const row = await ctx.db.get(reaction.pushId);
    const [owner, repo] = reaction.repoFullName.split("/");
    const resolved = await resolveGithubToken(ctx, reaction.projectId);
    return {
      kind: reaction.kind,
      owner,
      repo,
      prNumber: reaction.prNumber,
      headSha: reaction.headSha ?? row?.headSha,
      context: reaction.context ?? {},
      token: resolved?.token ?? null,
    };
  },
});

async function github<T>(token: string, path: string, accept = "application/vnd.github+json"): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
  return (accept.includes("json") ? await response.json() : await response.text()) as T;
}

const enc = encodeURIComponent;

/** Failed checks of the head commit, each with a log tail when GitHub has one. */
async function ciDetails(work: { owner: string; repo: string; headSha?: string; token: string }) {
  const base = `/repos/${enc(work.owner)}/${enc(work.repo)}`;
  const data = await github<{ check_runs?: any[] }>(work.token, `${base}/commits/${enc(work.headSha ?? "")}/check-runs?per_page=100`);
  const failed = (data.check_runs ?? []).filter((run) => checkStatus(run.status, run.conclusion) === "failed").slice(0, 5);
  const checks: NonNullable<FixDetails["checks"]> = [];
  for (const [index, run] of failed.entries()) {
    let tail: string | undefined;
    // GitHub Actions: the check run id is the job id. Logs for the first
    // three failures only (each is a separate download).
    if (index < 3 && run.app?.slug === "github-actions" && typeof run.id === "number") {
      try {
        tail = logTail(await github<string>(work.token, `${base}/actions/jobs/${run.id}/logs`, "text/plain")) || undefined;
      } catch {
        tail = undefined;
      }
    }
    checks.push({
      name: String(run.name ?? "check"),
      conclusion: typeof run.conclusion === "string" ? run.conclusion : undefined,
      url: typeof run.html_url === "string" ? run.html_url : undefined,
      logTail: tail,
      summary:
        [run.output?.title, run.output?.summary, run.output?.text].filter((x) => typeof x === "string" && x).join("\n").slice(0, 2000) ||
        undefined,
    });
  }
  return checks;
}

async function reviewComments(work: { owner: string; repo: string; prNumber: number; token: string }, reviewId: number) {
  const rows = await github<any[]>(
    work.token,
    `/repos/${enc(work.owner)}/${enc(work.repo)}/pulls/${work.prNumber}/reviews/${reviewId}/comments?per_page=100`
  );
  return rows.slice(0, MAX_COMMENTS).map(
    (c): ReviewComment => ({
      id: Number(c.id),
      path: String(c.path ?? ""),
      line: typeof c.line === "number" ? c.line : typeof c.original_line === "number" ? c.original_line : undefined,
      body: String(c.body ?? "").slice(0, 2000),
      author: c.user?.login,
    })
  );
}

/** Gather the fix context from GitHub (webhook context as the fallback). */
export const react = internalAction({
  args: { reactionId: v.id("prReactions") },
  handler: async (ctx, args) => {
    const work = await ctx.runQuery(internal.prFeedback.getReactionWork, args);
    if (!work) return;
    const context = work.context as Record<string, any>;
    const details: FixDetails = {};
    if (work.kind === "ci_failed") {
      const fallback = ((context.checks as any[]) ?? []).map((c) => ({
        name: String(c.name),
        conclusion: c.conclusion,
        url: c.url,
        summary: c.summary,
      }));
      try {
        details.checks = work.token && work.headSha ? await ciDetails({ ...work, token: work.token }) : fallback;
        if (details.checks.length === 0) details.checks = fallback;
      } catch {
        details.checks = fallback;
      }
    } else if (work.kind === "changes_requested" || work.kind === "review_comments") {
      details.review = { author: context.author, body: context.body, url: context.url };
      const stored = ((context.comments as ReviewComment[]) ?? []).slice(0, MAX_COMMENTS);
      details.comments = stored;
      if (work.token && typeof context.reviewId === "number") {
        try {
          const fetched = await reviewComments({ ...work, token: work.token }, context.reviewId);
          if (fetched.length > 0) details.comments = fetched;
        } catch {
          details.comments = stored;
        }
      }
    }
    await ctx.runMutation(internal.prFeedback.createFixTask, { reactionId: args.reactionId, details });
  },
});

/** Queue the fix task on the owner's branch/worktree (rechecks every guard). */
export const createFixTask = internalMutation({
  args: { reactionId: v.id("prReactions"), details: v.any() },
  handler: async (ctx, args) => {
    const reaction = await ctx.db.get(args.reactionId);
    if (!reaction || reaction.status !== "scheduled") return { created: false as const, reason: "not_scheduled" };
    const now = Date.now();
    const skip = async (reason: string) => {
      await ctx.db.patch(reaction._id, { status: "skipped", skipReason: reason, updatedAt: now });
      await syncPrNotifications(ctx, reaction.ownerTaskId);
      return { created: false as const, reason };
    };
    const project = await ctx.db.get(reaction.projectId);
    const owner = await ctx.db.get(reaction.ownerTaskId);
    const latest = await latestPrRow(ctx, reaction.ownerTaskId);
    if (!project?.prFeedbackReactions) return await skip("disabled");
    if (!owner) return await skip("owner_gone");
    if (!latest || (latest.prState !== "open" && latest.prState !== "draft")) return await skip("pr_not_open");
    if (
      (reaction.kind === "ci_failed" || reaction.kind === "merge_conflict") &&
      reaction.headSha &&
      latest.headSha &&
      reaction.headSha !== latest.headSha
    ) {
      return await skip("stale_head");
    }
    const used = await createdCount(ctx, reaction.repoFullName, reaction.prNumber);
    const max = (await fixMaxAttemptsFor(ctx));
    if (used >= max) return await skip("cap_reached");
    if (await fixInFlight(ctx, owner._id)) {
      await ctx.db.patch(reaction._id, { status: "deferred", updatedAt: now });
      return { created: false as const, reason: "deferred" };
    }
    // Same branch AND same worktree, or nothing: a fresh worktree would
    // start from main and lose the PR's commits.
    if (!owner.branchName || !owner.worktreePath) return await skip("worktree_gone");

    const details = (args.details ?? {}) as FixDetails;
    const command = buildFixPrompt({
      kind: reaction.kind,
      repoFullName: reaction.repoFullName,
      prNumber: reaction.prNumber,
      branchName: owner.branchName,
      headSha: reaction.headSha ?? latest.headSha,
      ownerTitle: owner.title,
      attempt: used + 1,
      maxAttempts: max,
      details: { ...details, baseBranch: latest.baseBranch },
    });
    const title = fixTaskTitle(reaction.kind, reaction.prNumber, owner.title);
    const fixTaskId = await ctx.db.insert("tasks", {
      projectId: owner.projectId,
      title,
      command,
      status: "queued",
      parentTaskId: owner._id,
      prFix: { repoFullName: reaction.repoFullName, prNumber: reaction.prNumber, kind: reaction.kind, reactionId: reaction._id },
      branchName: owner.branchName,
      worktreePath: owner.worktreePath,
      ...(owner.conversationId ? { conversationId: owner.conversationId } : {}),
      ...(owner.assignedAgentIds ? { assignedAgentIds: owner.assignedAgentIds } : {}),
      ...(owner.permissionMode ? { permissionMode: owner.permissionMode } : {}),
      ...(owner.sprint !== undefined ? { sprint: owner.sprint } : {}),
      updatedAt: now,
    });
    await syncTaskThread(ctx, fixTaskId); // Paradev B1 thread list
    const cardConversationId = await taskCardConversationId(ctx, owner.conversationId);
    await ctx.db.insert("messages", {
      projectId: owner.projectId,
      taskId: fixTaskId,
      ...(cardConversationId ? { conversationId: cardConversationId } : {}),
      authorType: "agent",
      content: `${title}. Fhara will commit the fix on ${owner.branchName}; you approve the push.`,
    });
    await ctx.db.patch(reaction._id, { status: "created", fixTaskId, updatedAt: now });
    await logOwnerEvent(ctx, owner._id, owner.projectId, "pr.fix_created", {
      prNumber: reaction.prNumber,
      kind: reaction.kind,
      fixTaskId,
      attempt: used + 1,
      maxAttempts: max,
    });
    await syncPrNotifications(ctx, owner._id);
    return { created: true as const, fixTaskId };
  },
});

// ---------------------------------------------------------------------------
// Hooks from other modules
// ---------------------------------------------------------------------------

/** completeTask: a fix task settled (or any task with a PR changed state). */
export async function onTaskSettled(ctx: MutationCtx, task: Doc<"tasks">) {
  const owner = task.parentTaskId && (task.prFix || task.reviewFix) ? task.parentTaskId : null;
  // Paradev A3: a review round settles with its fix task; the owner's thread shows how it ended.
  if (owner && task.reviewFix) {
    const { round, commentIds } = task.reviewFix;
    await logOwnerEvent(ctx, owner, task.projectId, "review.round_settled", { round, fixTaskId: task._id, status: task.status, comments: commentIds.length });
  }
  if (owner) await activateDeferred(ctx, owner);
  await syncPrNotifications(ctx, owner ?? task._id);
}

/**
 * completePushRequest: a commit reached the PR branch. Its sha is the PR
 * head now, so CI and mergeability start over, and a deferred reaction may
 * run.
 */
export async function onPrPushed(ctx: MutationCtx, row: PushRow) {
  if (row.prNumber === undefined || !row.repoFullName) return;
  const now = Date.now();
  for (const other of await prRows(ctx, row.projectId, row.repoFullName, row.prNumber)) {
    if (other.headSha === row.commitSha) continue;
    await ctx.db.patch(other._id, {
      headSha: row.commitSha,
      ciChecks: [],
      ciState: undefined,
      mergeable: "unknown",
      prFactsAt: now,
      updatedAt: now,
    });
  }
  const owner = ownerOf(row);
  await activateDeferred(ctx, owner);
  await scheduleAutoMerge(ctx, row.projectId, owner);
  await syncPrNotifications(ctx, owner);
}

/** O2: re-evaluate supervised auto-merge (only when the project turned it on). */
export async function scheduleAutoMerge(ctx: MutationCtx, projectId: Id<"projects">, ownerTaskId: Id<"tasks">) {
  const project = await ctx.db.get(projectId);
  if (!project?.autoMerge) return;
  await ctx.scheduler.runAfter(0, internal.autoMerge.evaluate, { ownerTaskId });
}

/** PR merged or closed: drop pending reactions and release the worktree. */
async function onPrClosed(ctx: MutationCtx, row: PushRow, ownerTaskId: Id<"tasks">) {
  const now = Date.now();
  const pending = (await ctx.db.query("prReactions").withIndex("by_owner_task", (q) => q.eq("ownerTaskId", ownerTaskId)).take(200)).filter(
    (r) => r.status === "scheduled" || r.status === "deferred"
  );
  for (const r of pending) await ctx.db.patch(r._id, { status: "skipped", skipReason: "pr_closed", updatedAt: now });
  const owner = await ctx.db.get(ownerTaskId);
  // O4: a merged PR finishes the issue it came from (`fhara:done`).
  if (owner && row.prState === "merged") await onIssueTaskChanged(ctx, owner, { prMerged: true });
  if (!owner?.worktreePath) return;
  // A fix still running keeps the worktree until it settles.
  const fixes = await ctx.db.query("tasks").withIndex("by_parent", (q) => q.eq("parentTaskId", ownerTaskId)).take(50);
  if (fixes.some((f) => (f.prFix || f.reviewFix) && !TERMINAL_TASK.has(f.status))) return;
  await ctx.scheduler.runAfter(0, internal.worktreeNode.releasePrWorktree, { taskId: ownerTaskId });
  await logOwnerEvent(ctx, ownerTaskId, row.projectId, "pr.worktree_release", { prNumber: row.prNumber, prState: row.prState });
}

export const getReleaseContext = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task?.worktreePath || !task.branchName) return null;
    const latest = await latestPrRow(ctx, task._id);
    if (latest && latest.prState !== "merged" && latest.prState !== "closed") return null;
    const project = await ctx.db.get(task.projectId);
    if (!project) return null;
    return { workspacePath: project.workspacePath, worktreePath: task.worktreePath, branchName: task.branchName };
  },
});

export const worktreeReleased = internalMutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return;
    const now = Date.now();
    await ctx.db.patch(task._id, { branchName: undefined, worktreePath: undefined, updatedAt: now });
    const fixes = await ctx.db.query("tasks").withIndex("by_parent", (q) => q.eq("parentTaskId", task._id)).take(50);
    for (const fix of fixes) {
      if (fix.worktreePath) await ctx.db.patch(fix._id, { branchName: undefined, worktreePath: undefined });
    }
    await logOwnerEvent(ctx, task._id, task.projectId, "branch.released", { reason: "pr_closed" });
  },
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Recompute an owner task's PR notifications; open what applies, resolve the rest. */
export async function syncPrNotifications(ctx: MutationCtx, ownerTaskId: Id<"tasks">) {
  const owner = await ctx.db.get(ownerTaskId);
  const latest = owner ? await latestPrRow(ctx, ownerTaskId) : null;
  let desired: ReturnType<typeof desiredNotifications> = [];
  if (owner && latest && latest.prNumber !== undefined && latest.repoFullName) {
    const project = await ctx.db.get(latest.projectId);
    const fixes = await ctx.db.query("tasks").withIndex("by_parent", (q) => q.eq("parentTaskId", ownerTaskId)).take(50);
    const lastFix = fixes.filter((f) => f.prFix).sort((a, b) => b._creationTime - a._creationTime)[0];
    desired = desiredNotifications({
      prNumber: latest.prNumber,
      facts: latest,
      reactionsEnabled: Boolean(project?.prFeedbackReactions),
      capReached: (await createdCount(ctx, latest.repoFullName, latest.prNumber)) >= (await fixMaxAttemptsFor(ctx)),
      worktreeAvailable: Boolean(owner.worktreePath && owner.branchName),
      fixActive: await fixInFlight(ctx, ownerTaskId),
      latestFixFailed: lastFix?.status === "failed",
      autoMerge: project?.autoMerge
        ? { enabled: true, state: latest.autoMerge?.state, code: latest.autoMerge?.code, reason: latest.autoMerge?.reason }
        : undefined,
    });
  }
  const now = Date.now();
  const open = await ctx.db
    .query("notifications")
    .withIndex("by_task_and_status", (q) => q.eq("taskId", ownerTaskId).eq("status", "open"))
    .take(50);
  const wanted = new Set(desired.map((d) => d.kind));
  for (const row of open) {
    if (!wanted.has(row.kind)) await ctx.db.patch(row._id, { status: "resolved", resolvedAt: now, updatedAt: now });
  }
  if (!owner || !latest) return;
  for (const item of desired) {
    const current = open.find((row) => row.kind === item.kind);
    if (current) {
      if (current.title !== item.title) await ctx.db.patch(current._id, { title: item.title, updatedAt: now });
      continue;
    }
    await ctx.db.insert("notifications", {
      projectId: owner.projectId,
      taskId: ownerTaskId,
      pushId: latest._id,
      kind: item.kind,
      title: item.title,
      detail: owner.title.slice(0, 200),
      ...(latest.prUrl ? { url: latest.prUrl } : {}),
      dedupeKey: `${ownerTaskId}:${item.kind}`,
      status: "open",
      createdAt: now,
      updatedAt: now,
    });
  }
}

// ---------------------------------------------------------------------------
// UI-facing
// ---------------------------------------------------------------------------

/** Derived PR lane per pushed task in a project (never stored). */
export const lanesByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await assertProjectAccess(ctx, args.projectId);
    const rows = await ctx.db
      .query("taskPushes")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(500);
    const byOwner = new Map<string, PushRow>();
    for (const row of rows) {
      if (row.prNumber === undefined) continue;
      const key = ownerOf(row) as string;
      const best = byOwner.get(key);
      if (!best || row.createdAt > best.createdAt) byOwner.set(key, row);
    }
    const max = (await fixMaxAttemptsFor(ctx));
    const out = [];
    for (const [taskId, row] of byOwner) {
      const lane = derivePrLane(row);
      if (!lane) continue;
      out.push({
        taskId: taskId as Id<"tasks">,
        lane,
        prNumber: row.prNumber!,
        prUrl: row.prUrl ?? null,
        prState: row.prState ?? null,
        ciState: row.ciState ?? null,
        failedChecks: (row.ciChecks ?? []).filter((c) => c.status === "failed").map((c) => c.name),
        reviewState: row.reviewState ?? null,
        mergeable: row.mergeable ?? null,
        fixing: await fixInFlight(ctx, taskId as Id<"tasks">),
        fixAttempts: await createdCount(ctx, row.repoFullName ?? "", row.prNumber!),
        maxAttempts: max,
        autoMerge: row.autoMerge ? { state: row.autoMerge.state, reason: row.autoMerge.reason } : null,
      });
    }
    return out;
  },
});

export const getProjectSetting = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    return { enabled: Boolean(project.prFeedbackReactions), maxAttempts: (await fixMaxAttemptsFor(ctx)) };
  },
});

export const setProjectSetting = mutation({
  args: { projectId: v.id("projects"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    if (Boolean(project.prFeedbackReactions) === args.enabled) return args.enabled;
    await ctx.db.patch(args.projectId, { prFeedbackReactions: args.enabled ? true : undefined });
    await recordAudit(ctx, {
      action: "project.update",
      target: project.name,
      projectId: args.projectId,
      details: { changed: ["prFeedbackReactions"], prFeedbackReactions: args.enabled },
    });
    return args.enabled;
  },
});
