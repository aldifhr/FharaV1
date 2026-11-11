/**
 * O2 supervised auto-merge (plan 043).
 *
 * Off by default, switched per project (and as a new-project default in
 * Settings → Diffs & PR). A task's PR merges only when ALL of these hold:
 *   - every check on the head commit passed (none pending, none failed or
 *     errored; a PR with no checks waits),
 *   - the diff passes the size / sensitive-path gate (fails closed),
 *   - no failing dependency check (O8, when it recorded one),
 *   - the PR head is exactly the commit the user approved for push,
 *   - GitHub says the PR is clean (not draft, behind, dirty or blocked).
 *
 *  1. `prFeedback.ingestSignal` / `onPrPushed` schedule `evaluate` for
 *     projects with the switch on.
 *  2. `evaluate` checks the stored facts. Not ready → it records the wait
 *     or block reason (the push card and Inbox show it). Ready → it marks
 *     the PR "checking" and schedules `attempt` (throttled per head).
 *  3. `attempt` reads the live PR, files and checks from GitHub and
 *     decides with lib/autoMerge.ts. Ready → `beginMerge` records an
 *     approved `merge_pr` approval with decidedBy "auto" and an audit row,
 *     then the merge is requested with `sha` = the approved head, so GitHub
 *     refuses it if anything moved (never forced). `finishMerge` records
 *     the result and feeds the merged state through the normal PR path.
 *
 * G3: while automation is held, `evaluate` and `beginMerge` record a
 * "held" wait instead of merging; resuming (appSettings.setAutomationHold)
 * re-evaluates those PRs.
 */
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { assertProjectAccess } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { resolveGithubToken } from "./lib/githubAuth";
import { appendTaskEvent } from "./lib/taskEvents";
import { taskCardConversationId } from "./lib/conversationScope";
import { loadSettingValues } from "./appSettings";
import { settingFrom } from "./lib/appSettings";
import { fetchCommitChecks } from "./lib/prChecks";
import { AUTOMATION_HELD_CODE, AUTOMATION_HELD_REASON, isAutomationHeld } from "./lib/automationHold";
import {
  autoMergePolicy,
  humanGate,
  MAX_PR_FILES,
  mergedLine,
  mergeVerdict,
  storedFactsReady,
  type MergeVerdict,
  type PrFile,
} from "./lib/autoMerge";
import { fixInFlight, ingestSignal, latestPrRow, syncPrNotifications } from "./prFeedback";

type Ctx = QueryCtx | MutationCtx;
type PushRow = Doc<"taskPushes">;

/** One live GitHub attempt per head at most this often. */
export const ATTEMPT_THROTTLE_MS = 60_000;
/** Codes that only a new head commit can change: never re-attempted on the same head. */
const HEAD_BOUND = new Set(["gate_size", "gate_path", "head_mismatch"]);

/** The commit the user approved for push: the owner's newest pushed row. */
async function approvedSha(ctx: Ctx, ownerTaskId: Id<"tasks">): Promise<string | undefined> {
  const own = await ctx.db.query("taskPushes").withIndex("by_task", (q) => q.eq("taskId", ownerTaskId)).take(200);
  const fixes = await ctx.db.query("taskPushes").withIndex("by_owner_task", (q) => q.eq("ownerTaskId", ownerTaskId)).take(200);
  const pushed = [...own, ...fixes]
    .filter((row) => row.status === "pushed" && row.approvalId !== undefined)
    .sort((a, b) => (b.pushedAt ?? b.createdAt) - (a.pushedAt ?? a.createdAt));
  return pushed[0]?.commitSha;
}

async function reactionPending(ctx: Ctx, ownerTaskId: Id<"tasks">): Promise<boolean> {
  const rows = await ctx.db.query("prReactions").withIndex("by_owner_task", (q) => q.eq("ownerTaskId", ownerTaskId)).take(200);
  return rows.some((r) => r.status === "scheduled" || r.status === "deferred");
}

/** Copy the auto-merge state onto every row of the PR (cards read any of them). */
async function writeState(ctx: MutationCtx, row: PushRow, state: NonNullable<PushRow["autoMerge"]>) {
  if (row.prNumber === undefined || !row.repoFullName) return;
  const repoFullName = row.repoFullName;
  const prNumber = row.prNumber;
  const rows = await ctx.db
    .query("taskPushes")
    .withIndex("by_repo_pr", (q) => q.eq("repoFullName", repoFullName).eq("prNumber", prNumber))
    .take(50);
  for (const same of rows) {
    if (same.projectId === row.projectId) await ctx.db.patch(same._id, { autoMerge: state });
  }
}

function stateFor(verdict: Exclude<MergeVerdict, { kind: "ready" }>, headSha: string | undefined, prev?: PushRow["autoMerge"]) {
  return {
    state: verdict.kind === "wait" ? ("waiting" as const) : ("blocked" as const),
    code: verdict.code,
    reason: verdict.reason,
    ...(headSha ? { headSha } : {}),
    ...(prev?.attemptedAt !== undefined && prev.headSha === headSha ? { attemptedAt: prev.attemptedAt } : {}),
    updatedAt: Date.now(),
  };
}

const mergeableStateOf = (m: PushRow["mergeable"]) => (m === "mergeable" ? "clean" : m === "conflict" ? "dirty" : "unknown");

/** Park a PR's auto-merge as held (G3): a wait the push card and Inbox show. */
async function writeHeld(ctx: MutationCtx, row: PushRow) {
  const prev = row.autoMerge;
  if (prev?.code === AUTOMATION_HELD_CODE && prev.headSha === row.headSha) return;
  const now = Date.now();
  await writeState(ctx, row, {
    state: "waiting",
    code: AUTOMATION_HELD_CODE,
    reason: AUTOMATION_HELD_REASON,
    ...(row.headSha ? { headSha: row.headSha } : {}),
    ...(prev?.attemptedAt !== undefined ? { attemptedAt: prev.attemptedAt } : {}),
    updatedAt: now,
  });
  await syncPrNotifications(ctx, row.ownerTaskId ?? row.taskId);
}

/** Re-evaluate one owner task's PR from the stored facts. */
export const evaluate = internalMutation({
  args: { ownerTaskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const latest = await latestPrRow(ctx, args.ownerTaskId);
    if (!latest || latest.prNumber === undefined || !latest.repoFullName) return { scheduled: false, reason: "no_pr" };
    const project = await ctx.db.get(latest.projectId);
    if (!project?.autoMerge) return { scheduled: false, reason: "disabled" };
    if (latest.prState === "merged" || latest.prState === "closed") return { scheduled: false, reason: "pr_not_open" };
    if (await isAutomationHeld(ctx)) {
      if (latest.autoMerge?.state !== "merging" && latest.autoMerge?.state !== "merged") await writeHeld(ctx, latest);
      return { scheduled: false, reason: "held" };
    }
    const prev = latest.autoMerge;
    const head = latest.headSha;
    // In flight or done for this head: nothing to do.
    if (prev && prev.headSha === head && (prev.state === "checking" || prev.state === "merging" || prev.state === "merged")) {
      return { scheduled: false, reason: prev.state };
    }
    if (prev && prev.headSha === head && HEAD_BOUND.has(prev.code) && prev.attemptedAt !== undefined) {
      return { scheduled: false, reason: prev.code };
    }
    const approved = await approvedSha(ctx, args.ownerTaskId);
    const facts = {
      prState: latest.prState,
      ciState: latest.ciState,
      reviewState: latest.reviewState,
      mergeable: latest.mergeable,
      headSha: head,
      approvedSha: approved,
    };
    const inFlight = await fixInFlight(ctx, args.ownerTaskId);
    const pendingReaction = await reactionPending(ctx, args.ownerTaskId);
    if (!storedFactsReady(facts) || inFlight || pendingReaction) {
      const verdict = mergeVerdict({
        prNumber: latest.prNumber,
        state: latest.prState ?? "open",
        headSha: head,
        approvedSha: approved,
        reviewState: latest.reviewState,
        checks: latest.ciChecks ?? [],
        mergeable: latest.mergeable,
        mergeableState: mergeableStateOf(latest.mergeable),
        fixInFlight: inFlight,
        reactionPending: pendingReaction,
        dependencyCheck: latest.dependencyCheck?.status,
      });
      // Stored facts look ready but GitHub has not said "mergeable" yet.
      const shown: Exclude<MergeVerdict, { kind: "ready" }> =
        verdict.kind === "ready" ? { kind: "wait", code: "mergeability_unknown", reason: `Waiting for GitHub to confirm PR #${latest.prNumber} can merge` } : verdict;
      if (prev?.code !== shown.code || prev?.headSha !== head || prev?.reason !== shown.reason) {
        await writeState(ctx, latest, stateFor(shown, head, prev));
        await syncPrNotifications(ctx, args.ownerTaskId);
      }
      return { scheduled: false, reason: shown.code };
    }
    if (prev?.headSha === head && prev?.attemptedAt !== undefined && Date.now() - prev.attemptedAt < ATTEMPT_THROTTLE_MS) {
      return { scheduled: false, reason: "throttled" };
    }
    const now = Date.now();
    await writeState(ctx, latest, {
      state: "checking",
      code: "checking",
      reason: `Checking PR #${latest.prNumber} before merging`,
      ...(head ? { headSha: head } : {}),
      attemptedAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.autoMerge.attempt, { pushId: latest._id });
    return { scheduled: true, reason: "checking" };
  },
});

/** What `attempt` needs (internal only: carries a token). */
export const getAttemptWork = internalQuery({
  args: { pushId: v.id("taskPushes") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pushId);
    if (!row || row.prNumber === undefined || !row.repoFullName) return null;
    const project = await ctx.db.get(row.projectId);
    if (!project?.autoMerge) return null;
    const owner = row.ownerTaskId ?? row.taskId;
    const [ownerName, repo] = row.repoFullName.split("/");
    const resolved = await resolveGithubToken(ctx, row.projectId);
    const values = await loadSettingValues(ctx);
    return {
      owner: ownerName,
      repo,
      prNumber: row.prNumber,
      token: resolved?.token ?? null,
      approvedSha: await approvedSha(ctx, owner),
      reviewState: row.reviewState,
      fixInFlight: await fixInFlight(ctx, owner),
      reactionPending: await reactionPending(ctx, owner),
      dependencyCheck: row.dependencyCheck?.status,
      policy: autoMergePolicy({
        maxDiffLines: settingFrom(values, "FHARA_AUTO_MERGE_MAX_LINES"),
        sensitive: settingFrom(values, "FHARA_AUTO_MERGE_SENSITIVE"),
        method: settingFrom(values, "FHARA_AUTO_MERGE_METHOD"),
      }),
    };
  },
});

const GH_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "fhara",
});

/** Every file of the PR, or null when any page fails (the gate then fails closed). */
export async function fetchPrFiles(
  target: { owner: string; repo: string; prNumber: number; token: string },
  fetchImpl: typeof fetch = fetch
): Promise<PrFile[] | null> {
  const out: PrFile[] = [];
  try {
    for (let page = 1; page <= MAX_PR_FILES / 100; page++) {
      const response = await fetchImpl(
        `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls/${target.prNumber}/files?per_page=100&page=${page}`,
        { headers: GH_HEADERS(target.token) }
      );
      if (!response.ok) return null;
      const rows = (await response.json()) as Array<{ filename?: string; previous_filename?: string; additions?: number; deletions?: number }>;
      if (!Array.isArray(rows)) return null;
      for (const r of rows) {
        if (typeof r.filename !== "string") return null;
        out.push({
          filename: r.filename,
          additions: Number(r.additions ?? 0),
          deletions: Number(r.deletions ?? 0),
          ...(r.previous_filename ? { previousFilename: r.previous_filename } : {}),
        });
      }
      if (rows.length < 100) break;
    }
    return out;
  } catch {
    return null;
  }
}

/** Live check of the PR on GitHub, then the merge when everything holds. */
export const attempt = internalAction({
  args: { pushId: v.id("taskPushes") },
  handler: async (ctx, args): Promise<{ merged: boolean; reason: string }> => {
    const work = await ctx.runQuery(internal.autoMerge.getAttemptWork, args);
    if (!work) return { merged: false, reason: "disabled" };
    const block = async (verdict: Exclude<MergeVerdict, { kind: "ready" }>, headSha?: string) => {
      await ctx.runMutation(internal.autoMerge.recordVerdict, { pushId: args.pushId, kind: verdict.kind, code: verdict.code, reason: verdict.reason, headSha });
      return { merged: false, reason: verdict.code };
    };
    if (!work.token) return await block({ kind: "blocked", code: "no_token", reason: "GitHub is not connected" });
    const target = { owner: work.owner, repo: work.repo, prNumber: work.prNumber, token: work.token };
    let pull: { state?: string; merged?: boolean; draft?: boolean; mergeable?: boolean | null; mergeable_state?: string; head?: { sha?: string } };
    try {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(work.owner)}/${encodeURIComponent(work.repo)}/pulls/${work.prNumber}`,
        { headers: GH_HEADERS(work.token) }
      );
      if (!response.ok) throw new Error(String(response.status));
      pull = await response.json();
    } catch {
      return await block({ kind: "wait", code: "github_unreachable", reason: `Could not read PR #${work.prNumber} from GitHub` });
    }
    const headSha = typeof pull.head?.sha === "string" ? pull.head.sha : undefined;
    let checks: Array<{ name: string; status: "pending" | "passed" | "failed"; conclusion?: string }> | null = null;
    if (headSha) {
      try {
        checks = (await fetchCommitChecks({ ...target, sha: headSha })).checks;
      } catch {
        checks = null;
      }
    }
    const verdict = mergeVerdict({
      prNumber: work.prNumber,
      state: pull.merged ? "merged" : pull.state === "closed" ? "closed" : pull.draft ? "draft" : "open",
      headSha,
      approvedSha: work.approvedSha,
      reviewState: work.reviewState,
      checks,
      mergeableState: pull.mergeable_state,
      mergeable: pull.mergeable === false ? "conflict" : pull.mergeable === true ? "mergeable" : "unknown",
      fixInFlight: work.fixInFlight,
      reactionPending: work.reactionPending,
      dependencyCheck: work.dependencyCheck,
    });
    if (verdict.kind !== "ready") return await block(verdict, headSha);
    const gate = humanGate(await fetchPrFiles(target), work.policy);
    if (!gate.ok) return await block({ kind: "blocked", code: gate.code, reason: gate.reason }, headSha);

    const begun = await ctx.runMutation(internal.autoMerge.beginMerge, {
      pushId: args.pushId,
      headSha: headSha!,
      method: work.policy.method,
      lines: gate.lines,
      files: gate.files,
      checks: checks?.length ?? 0,
    });
    if (!begun) return { merged: false, reason: "superseded" };
    let ok = false;
    let message = "";
    // O5: one `cmd` row for the merge call (status and duration, no token).
    const mergeStartedAt = Date.now();
    let mergeStatus = 0;
    try {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(work.owner)}/${encodeURIComponent(work.repo)}/pulls/${work.prNumber}/merge`,
        {
          method: "PUT",
          headers: { ...GH_HEADERS(work.token), "Content-Type": "application/json" },
          // `sha`: GitHub refuses (409) when the head moved since we checked.
          body: JSON.stringify({ sha: headSha, merge_method: work.policy.method }),
        }
      );
      mergeStatus = response.status;
      const body = (await response.json().catch(() => ({}))) as { merged?: boolean; message?: string };
      ok = response.ok && body.merged !== false;
      message = ok ? "" : `GitHub refused the merge (${response.status}${body.message ? `: ${String(body.message).slice(0, 160)}` : ""})`;
    } catch {
      message = "GitHub could not be reached for the merge";
    }
    const mergeArgv = ["PUT", `/repos/${work.owner}/${work.repo}/pulls/${work.prNumber}/merge`, `merge_method=${work.policy.method}`];
    await ctx.runMutation(internal.audit.record, {
      actor: "system",
      tool: "cmd",
      action: "cmd.github-api",
      decision: "recorded",
      target: ["github-api", ...mergeArgv].join(" ").slice(0, 200),
      details: {
        argv: mergeArgv,
        exitCode: ok ? 0 : mergeStatus || 1,
        durationMs: Date.now() - mergeStartedAt,
        success: ok,
        ...(ok ? {} : { failureKind: mergeStatus ? "http_error" : "runtime_error", error: message.slice(0, 240) }),
      },
    });
    await ctx.runMutation(internal.autoMerge.finishMerge, { pushId: args.pushId, approvalId: begun.approvalId, ok, message, headSha: headSha! });
    return { merged: ok, reason: ok ? "merged" : "merge_failed" };
  },
});

/** Store a wait / block reason from a live attempt. */
export const recordVerdict = internalMutation({
  args: {
    pushId: v.id("taskPushes"),
    kind: v.union(v.literal("wait"), v.literal("blocked")),
    code: v.string(),
    reason: v.string(),
    headSha: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pushId);
    if (!row) return;
    const prev = row.autoMerge;
    const head = args.headSha ?? row.headSha;
    await writeState(ctx, row, {
      state: args.kind === "wait" ? "waiting" : "blocked",
      code: args.code,
      reason: args.reason.slice(0, 300),
      ...(head ? { headSha: head } : {}),
      attemptedAt: prev?.attemptedAt ?? Date.now(),
      updatedAt: Date.now(),
    });
    await appendTaskEvent(ctx, {
      taskId: row.ownerTaskId ?? row.taskId,
      projectId: row.projectId,
      type: "pr.auto_merge_wait",
      payload: { prNumber: row.prNumber, code: args.code, reason: args.reason.slice(0, 300) },
      level: args.kind === "wait" ? "info" : "warn",
    });
    await syncPrNotifications(ctx, row.ownerTaskId ?? row.taskId);
  },
});

/**
 * Last re-check, then the approval row (decidedBy "auto") and the audit
 * row. Returns null when the PR moved on since the attempt started.
 */
export const beginMerge = internalMutation({
  args: {
    pushId: v.id("taskPushes"),
    headSha: v.string(),
    method: v.string(),
    lines: v.number(),
    files: v.number(),
    checks: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pushId);
    if (!row || row.prNumber === undefined) return null;
    const project = await ctx.db.get(row.projectId);
    if (!project?.autoMerge) return null;
    const ownerTaskId = row.ownerTaskId ?? row.taskId;
    const latest = await latestPrRow(ctx, ownerTaskId);
    if (!latest || latest.prState === "merged" || latest.prState === "closed") return null;
    if (latest.autoMerge?.state !== "checking") return null;
    if (await isAutomationHeld(ctx)) {
      await writeHeld(ctx, latest);
      return null;
    }
    if ((await approvedSha(ctx, ownerTaskId)) !== args.headSha) return null;
    if (await fixInFlight(ctx, ownerTaskId)) return null;
    const now = Date.now();
    const summary = `Merge PR #${row.prNumber} (${args.method}, auto)`;
    const payload = { prNumber: row.prNumber, repoFullName: row.repoFullName, headSha: args.headSha, method: args.method, lines: args.lines, files: args.files, checks: args.checks };
    const approvalId = await ctx.db.insert("approvals", {
      taskId: ownerTaskId,
      projectId: row.projectId,
      kind: "merge_pr",
      summary,
      payload,
      toolName: "auto_merge",
      status: "approved",
      decidedBy: "auto",
      resolvedAt: now,
      history: [{ at: now, from: "pending", to: "approved", reason: "auto-merge: every check passed, gate passed, head is the approved commit" }],
    });
    await recordAudit(ctx, {
      actor: "fhara",
      tool: "github",
      action: "pr.auto_merge",
      decision: "allowed",
      target: `${row.repoFullName}#${row.prNumber}`,
      projectId: row.projectId,
      taskId: ownerTaskId,
      details: payload,
    });
    await writeState(ctx, latest, {
      state: "merging",
      code: "merging",
      reason: `Merging PR #${row.prNumber}`,
      headSha: args.headSha,
      attemptedAt: latest.autoMerge?.attemptedAt ?? now,
      approvalId,
      updatedAt: now,
    });
    return { approvalId, line: mergedLine(row.prNumber, { lines: args.lines, files: args.files }, args.checks) };
  },
});

export const finishMerge = internalMutation({
  args: { pushId: v.id("taskPushes"), approvalId: v.id("approvals"), ok: v.boolean(), message: v.string(), headSha: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pushId);
    const approval = await ctx.db.get(args.approvalId);
    if (!row || row.prNumber === undefined || !row.repoFullName) return;
    const ownerTaskId = row.ownerTaskId ?? row.taskId;
    const now = Date.now();
    const payload = (approval?.payload ?? {}) as { lines?: number; files?: number; checks?: number };
    if (!args.ok) {
      if (approval) {
        await ctx.db.patch(approval._id, {
          note: args.message.slice(0, 300),
          history: [...(approval.history ?? []), { at: now, event: "merge_failed", reason: args.message.slice(0, 300) }],
        });
      }
      await writeState(ctx, row, { state: "failed", code: "merge_failed", reason: args.message.slice(0, 300), headSha: args.headSha, attemptedAt: now, approvalId: args.approvalId, updatedAt: now });
      await recordAudit(ctx, {
        actor: "fhara",
        tool: "github",
        action: "pr.auto_merge_failed",
        decision: "denied",
        target: `${row.repoFullName}#${row.prNumber}`,
        projectId: row.projectId,
        taskId: ownerTaskId,
        details: { reason: args.message.slice(0, 300) },
      });
      await appendTaskEvent(ctx, { taskId: ownerTaskId, projectId: row.projectId, type: "pr.auto_merge_failed", payload: { prNumber: row.prNumber, reason: args.message.slice(0, 300) }, level: "warn" });
      await syncPrNotifications(ctx, ownerTaskId);
      return;
    }
    const line = mergedLine(row.prNumber, { lines: payload.lines ?? 0, files: payload.files ?? 0 }, payload.checks ?? 0);
    await writeState(ctx, row, { state: "merged", code: "merged", reason: line, headSha: args.headSha, attemptedAt: now, approvalId: args.approvalId, updatedAt: now });
    await appendTaskEvent(ctx, { taskId: ownerTaskId, projectId: row.projectId, type: "pr.auto_merged", eventKey: `pr.auto_merged:${row.repoFullName}#${row.prNumber}`, payload: { prNumber: row.prNumber, headSha: args.headSha }, level: "info" });
    const owner = await ctx.db.get(ownerTaskId);
    const conversationId = await taskCardConversationId(ctx, owner?.conversationId);
    await ctx.db.insert("messages", {
      projectId: row.projectId,
      taskId: ownerTaskId,
      ...(conversationId ? { conversationId } : {}),
      authorType: "agent",
      content: line,
    });
    // The merged state goes through the normal PR path (worktree release,
    // notifications resolve).
    await ingestSignal(ctx, row.projectId, {
      kind: "pull_request",
      repoFullName: row.repoFullName,
      prNumber: row.prNumber,
      action: "auto_merged",
      state: "merged",
      headSha: args.headSha,
    });
  },
});

// ── Project switch (UI) ────────────────────────────────────────────────

export const getProjectSetting = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    const values = await loadSettingValues(ctx);
    const policy = autoMergePolicy({
      maxDiffLines: settingFrom(values, "FHARA_AUTO_MERGE_MAX_LINES"),
      sensitive: settingFrom(values, "FHARA_AUTO_MERGE_SENSITIVE"),
      method: settingFrom(values, "FHARA_AUTO_MERGE_METHOD"),
    });
    return { enabled: Boolean(project.autoMerge), ...policy };
  },
});

export const setProjectSetting = mutation({
  args: { projectId: v.id("projects"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    if (Boolean(project.autoMerge) === args.enabled) return args.enabled;
    await ctx.db.patch(args.projectId, { autoMerge: args.enabled ? true : undefined });
    await recordAudit(ctx, {
      action: "project.update",
      target: project.name,
      projectId: args.projectId,
      details: { changed: ["autoMerge"], autoMerge: args.enabled },
    });
    return args.enabled;
  },
});
