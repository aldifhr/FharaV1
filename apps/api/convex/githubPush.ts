import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess } from "./authz";
import { holdsTaskLease } from "./orchestration";
import { prState } from "./schema";
import type { QaCardData, VerificationCardData } from "./cardTypes";

/**
 * Plan 019 — stage cards and the GitHub push / pull-request flow.
 *
 * Flow:
 *  1. The worker commits the task branch and calls `recordTaskCommit`
 *     (token + lease gated through worker.ts): a `taskPushes` row in
 *     `ready` plus a `push` card in the task's chat.
 *  2. The user clicks "Push & open PR" / "Push only": `requestPush`
 *     records an APPROVED `git_push` approval row (the click is the
 *     explicit approval, AGENTS.md rule 5) and moves the row to
 *     `requested`. Nothing is pushed by the backend.
 *  3. The worker (it owns the local repository) claims the request with a
 *     lease (`claimPushRequest`), pushes with the project's GitHub token
 *     passed through the environment only, opens a draft PR, and reports
 *     back with `completePushRequest` → `pushed` / `failed`.
 *  4. `refreshOpenPrs` (cron) and `refreshPrStatus` (button) keep the PR
 *     state (draft/open/merged/closed) current, bounded per run.
 */

const DEFAULT_PUSH_LEASE_MS = 120_000;
const MAX_PUSH_ATTEMPTS = 3;
const ERROR_LIMIT = 1_000;
const CARD_DEDUPE_SCAN = 100;
const PR_REFRESH_BATCH = 20;
const PR_REFRESH_MIN_AGE_MS = 5 * 60_000;

const cardKind = v.union(v.literal("verification"), v.literal("qa"));

type PushRow = Doc<"taskPushes">;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** GitHub REST pull → our four-state PR status. */
export function mapPrState(pull: {
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  draft?: boolean;
}): "draft" | "open" | "merged" | "closed" {
  if (pull.merged || pull.merged_at) return "merged";
  if (pull.state === "closed") return "closed";
  if (pull.draft) return "draft";
  return "open";
}

const checkMark = (status: string) =>
  status === "passed" ? "✅ passed" : status === "failed" ? "❌ failed" : "⏭️ not run";

/**
 * PR description: task summary plus the verification / QA results the
 * cards recorded. A stage that never reported is written as "not run",
 * never as passed.
 */
export function buildPrBody(input: {
  title: string;
  command: string;
  commitSha: string;
  filesChanged: number;
  verification?: VerificationCardData | null;
  qa?: QaCardData | null;
}): string {
  const lines: string[] = [];
  lines.push(`## Summary`, "", input.title, "");
  const request = input.command.split("\n--- Conversation context ---")[0].trim();
  if (request && request !== input.title) {
    lines.push("<details><summary>Original request</summary>", "", request.slice(0, 1500), "", "</details>", "");
  }
  lines.push(`Commit \`${input.commitSha.slice(0, 12)}\` · ${input.filesChanged} file(s) changed`, "");
  lines.push("## Verification", "");
  if (input.verification && Array.isArray(input.verification.checks) && input.verification.checks.length > 0) {
    for (const check of input.verification.checks) {
      const where = check.target ? ` (${check.target})` : "";
      lines.push(`- ${check.name}${where}: ${checkMark(check.status)}${check.detail ? ` — ${check.detail}` : ""}`);
    }
  } else {
    lines.push("- not run");
  }
  lines.push("", "## QA", "");
  if (input.qa) {
    lines.push(`- Outcome: **${input.qa.outcome}**${input.qa.reason ? ` — ${input.qa.reason}` : ""}`);
    for (const url of input.qa.urls ?? []) lines.push(`- Checked: ${url}`);
    for (const issue of (input.qa.issues ?? []).slice(0, 10)) lines.push(`- Issue: ${issue}`);
  } else {
    lines.push("- not run");
  }
  lines.push("", "_Opened as a draft by MOAgent after an explicit push approval._");
  return lines.join("\n");
}

function truncate(text: string | undefined, limit = ERROR_LIMIT): string | undefined {
  if (text === undefined) return undefined;
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

async function githubIntegration(ctx: QueryCtx | MutationCtx, projectId: Id<"projects">) {
  return await ctx.db
    .query("integrations")
    .withIndex("by_project_and_type", (q) => q.eq("projectId", projectId).eq("type", "github"))
    .first();
}

function repoReady(integration: Doc<"integrations"> | null): integration is Doc<"integrations"> & {
  accessToken: string;
  githubOwner: string;
  githubRepo: string;
} {
  return Boolean(
    integration &&
      integration.status !== "disconnected" &&
      integration.accessToken &&
      integration.githubOwner &&
      integration.githubRepo
  );
}

/** Latest card of a kind on a task (bounded scan, newest first). */
async function latestCard(ctx: QueryCtx | MutationCtx, taskId: Id<"tasks">, kind: string) {
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .order("desc")
    .take(CARD_DEDUPE_SCAN);
  return recent.find((m) => m.card?.kind === kind)?.card?.data ?? null;
}

async function logPushEvent(
  ctx: MutationCtx,
  row: PushRow,
  type: string,
  payload: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info"
) {
  await ctx.db.insert("taskEvents", {
    taskId: row.taskId,
    projectId: row.projectId,
    type,
    payload: { pushId: row._id, branchName: row.branchName, ...payload },
    level,
    createdAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Worker-facing internals (wrapped by token-gated actions in worker.ts)
// ---------------------------------------------------------------------------

/** Verification / QA card into the task's chat conversation. */
export const postTaskCard = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    workerId: v.optional(v.string()),
    agentId: v.optional(v.id("agents")),
    kind: cardKind,
    content: v.optional(v.string()),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) {
      return { applied: false as const, reason: "lease_lost" as const };
    }
    const task = await ctx.db.get(args.taskId);
    if (!task || task.projectId !== args.projectId) {
      return { applied: false as const, reason: "task_not_found" as const };
    }
    const key = typeof args.data?.idempotencyKey === "string" ? args.data.idempotencyKey : undefined;
    if (key) {
      const recent = await ctx.db
        .query("messages")
        .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
        .order("desc")
        .take(CARD_DEDUPE_SCAN);
      const existing = recent.find((m) => m.card?.kind === args.kind && m.card?.data?.idempotencyKey === key);
      if (existing) return { applied: true as const, messageId: existing._id, deduped: true };
    }
    const messageId = await ctx.db.insert("messages", {
      projectId: args.projectId,
      taskId: args.taskId,
      conversationId: task.conversationId,
      agentId: args.agentId,
      authorType: "agent",
      content: (args.content ?? "").trim(),
      card: { kind: args.kind, data: { ...args.data, taskId: String(args.taskId) } },
    });
    return { applied: true as const, messageId, deduped: false };
  },
});

/** The worker committed the task branch: record it and post the push card. */
export const recordTaskCommit = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    workerId: v.optional(v.string()),
    agentId: v.optional(v.id("agents")),
    branchName: v.string(),
    commitSha: v.string(),
    commitMessage: v.string(),
    filesChanged: v.number(),
    ahead: v.optional(v.number()),
    behind: v.optional(v.number()),
    comparedTo: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) {
      return { applied: false as const, reason: "lease_lost" as const };
    }
    if (!/^[0-9a-f]{7,64}$/i.test(args.commitSha)) {
      throw new Error("Invalid commit sha");
    }
    const task = await ctx.db.get(args.taskId);
    if (!task || task.projectId !== args.projectId) {
      return { applied: false as const, reason: "task_not_found" as const };
    }
    const existing = await ctx.db
      .query("taskPushes")
      .withIndex("by_task_and_sha", (q) => q.eq("taskId", args.taskId).eq("commitSha", args.commitSha))
      .first();
    if (existing) {
      return { applied: true as const, pushId: existing._id, messageId: existing.messageId, deduped: true };
    }
    const now = Date.now();
    const pushId = await ctx.db.insert("taskPushes", {
      taskId: args.taskId,
      projectId: args.projectId,
      conversationId: task.conversationId,
      branchName: args.branchName,
      commitSha: args.commitSha,
      commitMessage: args.commitMessage.slice(0, 500),
      filesChanged: args.filesChanged,
      ahead: args.ahead,
      behind: args.behind,
      comparedTo: args.comparedTo,
      status: "ready",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    const messageId = await ctx.db.insert("messages", {
      projectId: args.projectId,
      taskId: args.taskId,
      conversationId: task.conversationId,
      agentId: args.agentId,
      authorType: "agent",
      content: "",
      card: {
        kind: "push",
        data: {
          taskId: String(args.taskId),
          pushId: String(pushId),
          branchName: args.branchName,
          commitSha: args.commitSha,
          commitMessage: args.commitMessage.slice(0, 500),
          filesChanged: args.filesChanged,
          ahead: args.ahead,
          behind: args.behind,
        },
      },
    });
    await ctx.db.patch(pushId, { messageId });
    return { applied: true as const, pushId, messageId, deduped: false };
  },
});

/**
 * Claim the oldest requested push with a lease. Stale `pushing` rows (lease
 * lapsed) are requeued first, and failed after MAX_PUSH_ATTEMPTS. The
 * result carries the project's GitHub token: this function is internal and
 * reachable only through the token-gated `worker.claimPushRequest` action.
 */
export const claimPushRequest = internalMutation({
  args: { workerId: v.string(), leaseMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const stale = await ctx.db
      .query("taskPushes")
      .withIndex("by_status_and_lease", (q) => q.eq("status", "pushing").lt("leaseExpiresAt", now))
      .take(10);
    for (const row of stale) {
      if (row.attempts >= MAX_PUSH_ATTEMPTS) {
        await ctx.db.patch(row._id, {
          status: "failed",
          error: "The push worker stopped responding; retry the push.",
          workerId: undefined,
          leaseExpiresAt: undefined,
          updatedAt: now,
        });
        await logPushEvent(ctx, row, "push.failed", { reason: "lease_expired" }, "error");
      } else {
        await ctx.db.patch(row._id, {
          status: "requested",
          workerId: undefined,
          leaseExpiresAt: undefined,
          updatedAt: now,
        });
      }
    }

    // A request that cannot run (approval or GitHub config gone) is failed
    // with a reason and the next one is tried, bounded per claim.
    const candidates = await ctx.db
      .query("taskPushes")
      .withIndex("by_status_and_requested", (q) => q.eq("status", "requested"))
      .order("asc")
      .take(5);
    for (const row of candidates) {
      const fail = async (error: string) => {
        await ctx.db.patch(row._id, { status: "failed", error, updatedAt: now });
        await logPushEvent(ctx, row, "push.failed", { reason: error }, "error");
      };
      const approval = row.approvalId ? await ctx.db.get(row.approvalId) : null;
      if (!approval || approval.kind !== "git_push" || approval.status !== "approved") {
        await fail("Push approval is missing or was revoked.");
        continue;
      }
      const project = await ctx.db.get(row.projectId);
      const task = await ctx.db.get(row.taskId);
      if (!project || !task) {
        await fail("The task or project no longer exists.");
        continue;
      }
      const integration = await githubIntegration(ctx, row.projectId);
      if (!repoReady(integration)) {
        await fail("GitHub is not connected or no repository is selected for this project.");
        continue;
      }
      const leaseMs = args.leaseMs ?? DEFAULT_PUSH_LEASE_MS;
      await ctx.db.patch(row._id, {
        status: "pushing",
        workerId: args.workerId,
        leaseExpiresAt: now + leaseMs,
        attempts: row.attempts + 1,
        error: undefined,
        updatedAt: now,
      });
      await logPushEvent(ctx, row, "push.started", { workerId: args.workerId, attempt: row.attempts + 1 });
      const verification = (await latestCard(ctx, row.taskId, "verification")) as VerificationCardData | null;
      const qa = (await latestCard(ctx, row.taskId, "qa")) as QaCardData | null;
      const baseBranch = integration.githubBaseBranch || project.mainBranch || "main";
      return {
        pushId: row._id,
        taskId: row.taskId,
        projectId: row.projectId,
        workspacePath: project.workspacePath,
        branchName: row.branchName,
        commitSha: row.commitSha,
        openPr: row.openPr === true,
        existingPrNumber: row.prNumber,
        owner: integration.githubOwner,
        repo: integration.githubRepo,
        baseBranch,
        token: integration.accessToken,
        prTitle: task.title.slice(0, 200),
        prBody: buildPrBody({
          title: task.title,
          command: task.command,
          commitSha: row.commitSha,
          filesChanged: row.filesChanged,
          verification,
          qa,
        }),
      };
    }
    return null;
  },
});

export const completePushRequest = internalMutation({
  args: {
    pushId: v.id("taskPushes"),
    workerId: v.string(),
    outcome: v.union(v.literal("pushed"), v.literal("failed")),
    error: v.optional(v.string()),
    pr: v.optional(
      v.object({
        number: v.number(),
        url: v.string(),
        title: v.string(),
        state: prState,
      })
    ),
    repoFullName: v.optional(v.string()),
    baseBranch: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pushId);
    if (!row) return { applied: false as const, reason: "not_found" as const };
    if (row.status !== "pushing") return { applied: false as const, reason: "not_pushing" as const };
    if (row.workerId !== args.workerId) return { applied: false as const, reason: "lease_lost" as const };
    const now = Date.now();
    if (args.outcome === "pushed") {
      await ctx.db.patch(row._id, {
        status: "pushed",
        pushedAt: now,
        workerId: undefined,
        leaseExpiresAt: undefined,
        error: undefined,
        repoFullName: args.repoFullName ?? row.repoFullName,
        baseBranch: args.baseBranch ?? row.baseBranch,
        ...(args.pr
          ? {
              prNumber: args.pr.number,
              prUrl: args.pr.url,
              prTitle: args.pr.title,
              prState: args.pr.state,
              prCheckedAt: now,
            }
          : {}),
        updatedAt: now,
      });
      await logPushEvent(ctx, row, "push.pushed", {
        commitSha: row.commitSha,
        prNumber: args.pr?.number ?? null,
      });
    } else {
      await ctx.db.patch(row._id, {
        status: "failed",
        workerId: undefined,
        leaseExpiresAt: undefined,
        error: truncate(args.error ?? "Push failed"),
        updatedAt: now,
      });
      await logPushEvent(ctx, row, "push.failed", { reason: truncate(args.error, 300) ?? null }, "error");
    }
    return { applied: true as const };
  },
});

// ---------------------------------------------------------------------------
// UI-facing
// ---------------------------------------------------------------------------

/** Live push state for a push card. Never returns credential material. */
export const get = query({
  args: { pushId: v.id("taskPushes") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pushId);
    if (!row) return null;
    await assertProjectAccess(ctx, row.projectId);
    const integration = await githubIntegration(ctx, row.projectId);
    const project = await ctx.db.get(row.projectId);
    return {
      _id: row._id,
      taskId: row.taskId,
      projectId: row.projectId,
      branchName: row.branchName,
      commitSha: row.commitSha,
      commitMessage: row.commitMessage,
      filesChanged: row.filesChanged,
      ahead: row.ahead,
      behind: row.behind,
      comparedTo: row.comparedTo,
      status: row.status,
      openPr: row.openPr,
      error: row.error,
      attempts: row.attempts,
      pushedAt: row.pushedAt,
      prNumber: row.prNumber,
      prUrl: row.prUrl,
      prTitle: row.prTitle,
      prState: row.prState,
      prCheckedAt: row.prCheckedAt,
      github: {
        connected: Boolean(integration?.accessToken) && integration?.status !== "disconnected",
        repoFullName:
          row.repoFullName ??
          (integration?.githubOwner && integration?.githubRepo
            ? `${integration.githubOwner}/${integration.githubRepo}`
            : null),
        baseBranch: row.baseBranch ?? integration?.githubBaseBranch ?? project?.mainBranch ?? "main",
      },
    };
  },
});

/**
 * The user's explicit click on "Push & open PR" / "Push only". Records an
 * approved `git_push` approval row and queues the push for the worker.
 * Idempotent: a request that is already queued or running is returned as
 * is; a pushed row only re-queues to open the PR it does not have yet.
 */
export const requestPush = mutation({
  args: { pushId: v.id("taskPushes"), openPr: v.boolean() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pushId);
    if (!row) throw new Error("Push not found");
    await assertProjectAccess(ctx, row.projectId);
    if (row.status === "requested" || row.status === "pushing") {
      return { status: row.status, changed: false };
    }
    if (row.status === "pushed" && (!args.openPr || row.prNumber !== undefined)) {
      return { status: row.status, changed: false };
    }
    const integration = await githubIntegration(ctx, row.projectId);
    if (!repoReady(integration)) {
      throw new Error("Connect GitHub and choose a repository in project settings first.");
    }
    const now = Date.now();
    const repoFullName = `${integration.githubOwner}/${integration.githubRepo}`;
    const project = await ctx.db.get(row.projectId);
    const baseBranch = integration.githubBaseBranch || project?.mainBranch || "main";
    const approvalId = await ctx.db.insert("approvals", {
      taskId: row.taskId,
      projectId: row.projectId,
      kind: "git_push",
      summary: `Push ${row.branchName} to ${repoFullName}${args.openPr ? " and open a draft PR" : ""}`,
      status: "approved",
      resolvedAt: now,
      toolName: "git_push",
      arguments: {
        branchName: row.branchName,
        commitSha: row.commitSha,
        repo: repoFullName,
        baseBranch,
        openPr: args.openPr,
      },
      history: [{ at: now, status: "approved", by: "user", via: "push_card" }],
    });
    await ctx.db.patch(row._id, {
      status: "requested",
      openPr: args.openPr,
      approvalId,
      requestedAt: now,
      attempts: 0,
      error: undefined,
      workerId: undefined,
      leaseExpiresAt: undefined,
      repoFullName,
      baseBranch,
      updatedAt: now,
    });
    await logPushEvent(ctx, row, "push.requested", { openPr: args.openPr, repo: repoFullName });
    return { status: "requested" as const, changed: true };
  },
});

// ---------------------------------------------------------------------------
// PR status refresh (bounded)
// ---------------------------------------------------------------------------

export const getPrRefreshTarget = internalQuery({
  args: { pushId: v.id("taskPushes"), checkAccess: v.boolean() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pushId);
    if (!row || row.prNumber === undefined) return null;
    if (args.checkAccess) await assertProjectAccess(ctx, row.projectId);
    const integration = await githubIntegration(ctx, row.projectId);
    if (!integration?.accessToken) return null;
    const [owner, repo] = (row.repoFullName ?? `${integration.githubOwner}/${integration.githubRepo}`).split("/");
    if (!owner || !repo) return null;
    return { pushId: row._id, owner, repo, prNumber: row.prNumber, token: integration.accessToken };
  },
});

/** Oldest-checked open/draft PRs first, at most PR_REFRESH_BATCH. */
export const listPrsToRefresh = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, args) => {
    const cutoff = args.now - PR_REFRESH_MIN_AGE_MS;
    const ids: Id<"taskPushes">[] = [];
    for (const state of ["draft", "open"] as const) {
      const rows = await ctx.db
        .query("taskPushes")
        .withIndex("by_pr_state_and_checked", (q) => q.eq("prState", state).lt("prCheckedAt", cutoff))
        .order("asc")
        .take(PR_REFRESH_BATCH - ids.length);
      ids.push(...rows.map((row) => row._id));
      if (ids.length >= PR_REFRESH_BATCH) break;
    }
    return ids;
  },
});

export const recordPrState = internalMutation({
  args: {
    pushId: v.id("taskPushes"),
    state: v.optional(prState),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pushId);
    if (!row) return;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      ...(args.state ? { prState: args.state } : {}),
      ...(args.title ? { prTitle: args.title } : {}),
      prCheckedAt: now,
      updatedAt: now,
    });
  },
});

async function fetchPull(target: { owner: string; repo: string; prNumber: number; token: string }) {
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls/${target.prNumber}`,
    {
      headers: {
        Authorization: `Bearer ${target.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
  return (await response.json()) as { state?: string; merged?: boolean; merged_at?: string | null; draft?: boolean; title?: string };
}

/** "Refresh" on a push card. */
export const refreshPrStatus = action({
  args: { pushId: v.id("taskPushes") },
  handler: async (ctx, args): Promise<{ state: string | null }> => {
    const target = await ctx.runQuery(internal.githubPush.getPrRefreshTarget, {
      pushId: args.pushId,
      checkAccess: true,
    });
    if (!target) return { state: null };
    const pull = await fetchPull(target);
    const state = mapPrState(pull);
    await ctx.runMutation(internal.githubPush.recordPrState, { pushId: args.pushId, state, title: pull.title });
    return { state };
  },
});

/** Cron: refresh a bounded batch of open/draft PRs. */
export const refreshOpenPrs = internalAction({
  args: {},
  handler: async (ctx): Promise<{ checked: number; failed: number }> => {
    const ids = await ctx.runQuery(internal.githubPush.listPrsToRefresh, { now: Date.now() });
    let checked = 0;
    let failed = 0;
    for (const pushId of ids) {
      const target = await ctx.runQuery(internal.githubPush.getPrRefreshTarget, { pushId, checkAccess: false });
      if (!target) continue;
      try {
        const pull = await fetchPull(target);
        await ctx.runMutation(internal.githubPush.recordPrState, { pushId, state: mapPrState(pull), title: pull.title });
        checked += 1;
      } catch {
        // Stamp the check so one broken PR does not starve the batch.
        await ctx.runMutation(internal.githubPush.recordPrState, { pushId });
        failed += 1;
      }
    }
    return { checked, failed };
  },
});
