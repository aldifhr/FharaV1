/**
 * O4 issue → draft task intake (plan 043).
 *
 * Off by default (per-project switch, new-project default in Settings).
 *  1. The verified webhook parses an `issues` delivery and schedules
 *     `receive` for the project.
 *  2. `receive` keeps only open issues the connected GitHub login opened
 *     that carry the project's label (default `fhara`); anything else is
 *     ignored with an audit row. It stores a DRAFT (`issueDrafts`), runs
 *     the "already done?" preflight, and labels the issue `fhara:draft`.
 *  3. The user presses Start in the Inbox: `start` creates an ordinary
 *     queued task (Start asks to confirm when the preflight found evidence).
 *     Nothing ever starts a task from issue text on its own.
 *  4. Status labels follow the task (`fhara:running`, `fhara:ready-for-review`,
 *     `fhara:failed`) and the PR (`fhara:done` on merge); the PR body says
 *     `Closes #n` (githubPush.buildPrBody).
 */
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { assertProjectAccess, visibleProjects } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { globalGithubConnection, resolveGithubToken } from "./lib/githubAuth";
import { projectDefaultPermissionMode } from "./lib/permissionModes";
import {
  draftCommand,
  intakeDecision,
  intakeLabel,
  labelDiff,
  preflightEvidence,
  statusLabelForTask,
  type IssueComment,
  type IssueSignal,
  type IssueStatusLabel,
  type TimelineEvent,
} from "./lib/issueIntake";

const GH_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "fhara",
});
const enc = encodeURIComponent;

/** The project's GitHub token, or null when none is usable (never throws). */
async function safeToken(ctx: Parameters<typeof resolveGithubToken>[0], projectId: Id<"projects">): Promise<string | null> {
  try {
    return (await resolveGithubToken(ctx, projectId))?.token ?? null;
  } catch {
    return null;
  }
}

/** What `receive` needs (internal only: carries a token). */
export const getIntakeContext = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project?.issueIntake?.enabled) return null;
    const connection = await globalGithubConnection(ctx);
    return {
      label: intakeLabel(project.issueIntake.label),
      login: connection?.login ?? null,
      token: await safeToken(ctx, args.projectId),
    };
  },
});

/** Webhook → (filtered) draft → preflight → `fhara:draft` label. */
export const receive = internalAction({
  args: { projectId: v.id("projects"), signal: v.any() },
  handler: async (ctx, args): Promise<{ draftId: Id<"issueDrafts"> | null; reason: string }> => {
    const signal = args.signal as IssueSignal;
    const intake = await ctx.runQuery(internal.issueIntake.getIntakeContext, { projectId: args.projectId });
    if (!intake) return { draftId: null, reason: "disabled" };
    let login = intake.login;
    // A legacy connection stores no login: ask GitHub who the token is.
    if (!login && intake.token) {
      try {
        const response = await fetch("https://api.github.com/user", { headers: GH_HEADERS(intake.token) });
        if (response.ok) login = ((await response.json()) as { login?: string }).login ?? null;
      } catch {
        login = null;
      }
    }
    const decision = intakeDecision(signal, { label: intake.label, selfLogin: login });
    if (!decision.ok) {
      // Wrong action or label: not ours, no trace. Another author: audited.
      if (decision.reason === "author" || decision.reason === "no_login") {
        await ctx.runMutation(internal.issueIntake.recordIgnored, {
          projectId: args.projectId,
          target: `${signal.repoFullName}#${signal.number}`,
          reason: decision.reason,
        });
      }
      return { draftId: null, reason: decision.reason };
    }
    const draftId = await ctx.runMutation(internal.issueIntake.upsertDraft, {
      projectId: args.projectId,
      repoFullName: signal.repoFullName,
      issueNumber: signal.number,
      title: signal.title,
      body: signal.body,
      author: signal.author,
      url: signal.url,
    });
    if (!draftId) return { draftId: null, reason: "already_handled" };
    if (intake.token) {
      await ctx.runAction(internal.issueIntake.preflight, { draftId });
      await ctx.runAction(internal.issueIntake.syncLabel, { draftId, label: "fhara:draft" });
    } else {
      await ctx.runMutation(internal.issueIntake.recordPreflight, { draftId, looksDone: false, evidence: [], unverified: true });
    }
    return { draftId, reason: "draft" };
  },
});

export const recordIgnored = internalMutation({
  args: { projectId: v.id("projects"), target: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    await recordAudit(ctx, {
      actor: "fhara",
      tool: "github",
      action: "issue.intake_ignored",
      decision: "denied",
      target: args.target,
      projectId: args.projectId,
      details: { reason: args.reason },
    });
  },
});

/** Insert (or refresh while still a draft) one issue's draft. Null = started or dismissed already. */
export const upsertDraft = internalMutation({
  args: {
    projectId: v.id("projects"),
    repoFullName: v.string(),
    issueNumber: v.number(),
    title: v.string(),
    body: v.string(),
    author: v.string(),
    url: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"issueDrafts"> | null> => {
    const existing = (
      await ctx.db
        .query("issueDrafts")
        .withIndex("by_repo_issue", (q) => q.eq("repoFullName", args.repoFullName).eq("issueNumber", args.issueNumber))
        .take(20)
    ).find((d) => d.projectId === args.projectId);
    const now = Date.now();
    if (existing) {
      if (existing.status !== "draft") return null;
      await ctx.db.patch(existing._id, { title: args.title, body: args.body, ...(args.url ? { url: args.url } : {}), updatedAt: now });
      return existing._id;
    }
    const draftId = await ctx.db.insert("issueDrafts", {
      projectId: args.projectId,
      repoFullName: args.repoFullName,
      issueNumber: args.issueNumber,
      title: args.title || `Issue #${args.issueNumber}`,
      body: args.body,
      author: args.author,
      ...(args.url ? { url: args.url } : {}),
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
    await recordAudit(ctx, {
      actor: "fhara",
      tool: "github",
      action: "issue.intake_draft",
      decision: "recorded",
      target: `${args.repoFullName}#${args.issueNumber}`,
      projectId: args.projectId,
    });
    return draftId;
  },
});

export const getDraftWork = internalQuery({
  args: { draftId: v.id("issueDrafts") },
  handler: async (ctx, args) => {
    const draft = await ctx.db.get(args.draftId);
    if (!draft) return null;
    const token = await safeToken(ctx, draft.projectId);
    // Fhara's own earlier tasks for this issue (task-run evidence).
    const siblings = (
      await ctx.db
        .query("issueDrafts")
        .withIndex("by_repo_issue", (q) => q.eq("repoFullName", draft.repoFullName).eq("issueNumber", draft.issueNumber))
        .take(20)
    ).filter((d) => d._id !== draft._id && d.taskId);
    const earlierTasks: Array<{ title: string; status: string }> = [];
    for (const d of siblings) {
      const task = d.taskId ? await ctx.db.get(d.taskId) : null;
      if (task) earlierTasks.push({ title: task.title, status: task.status });
    }
    const [owner, repo] = draft.repoFullName.split("/");
    return { owner, repo, issueNumber: draft.issueNumber, token, earlierTasks };
  },
});

async function getJson<T>(token: string, path: string): Promise<T | null> {
  try {
    const response = await fetch(`https://api.github.com${path}`, { headers: GH_HEADERS(token) });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** "Already done?" check: issue state, timeline (merged PRs, closing commits), comments. */
export const preflight = internalAction({
  args: { draftId: v.id("issueDrafts") },
  handler: async (ctx, args): Promise<void> => {
    const work = await ctx.runQuery(internal.issueIntake.getDraftWork, args);
    if (!work) return;
    if (!work.token) {
      await ctx.runMutation(internal.issueIntake.recordPreflight, { draftId: args.draftId, looksDone: false, evidence: [], unverified: true });
      return;
    }
    const base = `/repos/${enc(work.owner)}/${enc(work.repo)}/issues/${work.issueNumber}`;
    const issue = await getJson<{ state?: string }>(work.token, base);
    const timeline = await getJson<TimelineEvent[]>(work.token, `${base}/timeline?per_page=100`);
    const comments = await getJson<IssueComment[]>(work.token, `${base}/comments?per_page=100`);
    const result = preflightEvidence({
      issueState: issue?.state === "closed" ? "closed" : "open",
      timeline: Array.isArray(timeline) ? timeline : null,
      comments: Array.isArray(comments) ? comments : null,
      earlierTasks: work.earlierTasks,
    });
    await ctx.runMutation(internal.issueIntake.recordPreflight, {
      draftId: args.draftId,
      looksDone: result.looksDone,
      evidence: result.evidence,
      unverified: issue === null && timeline === null && comments === null,
    });
  },
});

export const recordPreflight = internalMutation({
  args: { draftId: v.id("issueDrafts"), looksDone: v.boolean(), evidence: v.array(v.string()), unverified: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const draft = await ctx.db.get(args.draftId);
    if (!draft) return;
    await ctx.db.patch(draft._id, {
      preflight: {
        looksDone: args.looksDone,
        evidence: args.evidence.slice(0, 8).map((e) => e.slice(0, 200)),
        checkedAt: Date.now(),
        ...(args.unverified ? { unverified: true } : {}),
      },
      updatedAt: Date.now(),
    });
  },
});

export const getLabelWork = internalQuery({
  args: { draftId: v.id("issueDrafts") },
  handler: async (ctx, args) => {
    const draft = await ctx.db.get(args.draftId);
    if (!draft) return null;
    const [owner, repo] = draft.repoFullName.split("/");
    return { owner, repo, issueNumber: draft.issueNumber, token: await safeToken(ctx, draft.projectId), current: draft.statusLabel ?? null };
  },
});

/** Put exactly one Fhara status label on the issue (others removed). */
export const syncLabel = internalAction({
  args: { draftId: v.id("issueDrafts"), label: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const work = await ctx.runQuery(internal.issueIntake.getLabelWork, { draftId: args.draftId });
    if (!work?.token || work.current === args.label) return;
    const base = `https://api.github.com/repos/${enc(work.owner)}/${enc(work.repo)}/issues/${work.issueNumber}/labels`;
    let error: string | undefined;
    try {
      const response = await fetch(base, { headers: GH_HEADERS(work.token) });
      if (!response.ok) throw new Error(`labels read failed (${response.status})`);
      const current = ((await response.json()) as Array<{ name?: string }>).map((l) => l.name ?? "").filter(Boolean);
      const diff = labelDiff(current, args.label as IssueStatusLabel);
      for (const name of diff.remove) {
        await fetch(`${base}/${enc(name)}`, { method: "DELETE", headers: GH_HEADERS(work.token) });
      }
      if (diff.add.length > 0) {
        const added = await fetch(base, {
          method: "POST",
          headers: { ...GH_HEADERS(work.token), "Content-Type": "application/json" },
          body: JSON.stringify({ labels: diff.add }),
        });
        if (!added.ok) throw new Error(`label write failed (${added.status})`);
      }
    } catch (err) {
      error = err instanceof Error ? err.message.slice(0, 200) : "label sync failed";
    }
    await ctx.runMutation(internal.issueIntake.recordLabel, { draftId: args.draftId, label: args.label, error });
  },
});

export const recordLabel = internalMutation({
  args: { draftId: v.id("issueDrafts"), label: v.string(), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const draft = await ctx.db.get(args.draftId);
    if (!draft) return;
    await ctx.db.patch(draft._id, args.error ? { labelError: args.error } : { statusLabel: args.label, labelError: undefined });
  },
});

/** Hook: a task linked to an issue changed state (completeTask, PR merged). */
export async function onIssueTaskChanged(ctx: MutationCtx, task: Doc<"tasks">, opts: { prMerged?: boolean } = {}) {
  const draft = await ctx.db
    .query("issueDrafts")
    .withIndex("by_task", (q) => q.eq("taskId", task._id))
    .first();
  if (!draft) return;
  const label = statusLabelForTask(task.status, opts.prMerged);
  if (!label || label === draft.statusLabel) return;
  await ctx.scheduler.runAfter(0, internal.issueIntake.syncLabel, { draftId: draft._id, label });
}

/** The issue a task's PR should close (same repo), or undefined. */
export async function closesIssueFor(ctx: { db: MutationCtx["db"] }, taskId: Id<"tasks">, repoFullName: string | undefined) {
  const draft = await ctx.db
    .query("issueDrafts")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .first();
  if (!draft || (repoFullName && draft.repoFullName.toLowerCase() !== repoFullName.toLowerCase())) return undefined;
  return draft.issueNumber;
}

// ── UI ──────────────────────────────────────────────────────────────────

/** Open drafts across the projects the caller may see (Inbox). */
export const listDrafts = query({
  args: {},
  handler: async (ctx) => {
    const visible = new Map((await visibleProjects(ctx)).map((p) => [p._id as string, p.name]));
    const rows = await ctx.db
      .query("issueDrafts")
      .withIndex("by_status_and_updated", (q) => q.eq("status", "draft"))
      .order("desc")
      .take(50);
    return rows
      .filter((d) => visible.has(d.projectId as string))
      .map((d) => ({
        _id: d._id,
        projectId: d.projectId,
        projectName: visible.get(d.projectId as string) ?? "—",
        repoFullName: d.repoFullName,
        issueNumber: d.issueNumber,
        title: d.title,
        url: d.url ?? null,
        preflight: d.preflight ?? null,
        labelError: d.labelError ?? null,
        updatedAt: d.updatedAt,
      }));
  },
});

/** Start a draft: an ordinary queued task. Evidence of "already done" needs `confirmDone`. */
export const start = mutation({
  args: { draftId: v.id("issueDrafts"), confirmDone: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<Id<"tasks">> => {
    const draft = await ctx.db.get(args.draftId);
    if (!draft) throw new Error("Draft not found");
    const project = await assertProjectAccess(ctx, draft.projectId);
    if (draft.status === "started" && draft.taskId) return draft.taskId;
    if (draft.status !== "draft") throw new Error("This draft was dismissed");
    if (draft.preflight?.looksDone && !args.confirmDone) {
      throw new Error(`Issue #${draft.issueNumber} looks done already: ${draft.preflight.evidence.join("; ")}`);
    }
    const now = Date.now();
    const title = `#${draft.issueNumber} ${draft.title}`.slice(0, 200);
    const command = draftCommand({ repoFullName: draft.repoFullName, number: draft.issueNumber, title: draft.title, body: draft.body });
    const taskId = await ctx.db.insert("tasks", {
      projectId: draft.projectId,
      title,
      command,
      status: "queued",
      permissionMode: projectDefaultPermissionMode(project),
      ...(project.shadowAgentDefault ? { shadowAgent: true } : {}),
      updatedAt: now,
    });
    await ctx.db.insert("messages", { projectId: draft.projectId, taskId, authorType: "user", content: command });
    await ctx.db.patch(draft._id, { status: "started", taskId, updatedAt: now });
    await recordAudit(ctx, {
      tool: "github",
      action: "issue.intake_start",
      decision: "allowed",
      target: `${draft.repoFullName}#${draft.issueNumber}`,
      projectId: draft.projectId,
      taskId,
      details: draft.preflight?.looksDone ? { confirmedDespiteEvidence: true } : undefined,
    });
    await ctx.scheduler.runAfter(0, internal.issueIntake.syncLabel, { draftId: draft._id, label: "fhara:running" });
    return taskId;
  },
});

export const dismiss = mutation({
  args: { draftId: v.id("issueDrafts") },
  handler: async (ctx, args) => {
    const draft = await ctx.db.get(args.draftId);
    if (!draft) throw new Error("Draft not found");
    await assertProjectAccess(ctx, draft.projectId);
    if (draft.status !== "draft") return false;
    await ctx.db.patch(draft._id, { status: "dismissed", updatedAt: Date.now() });
    await recordAudit(ctx, {
      tool: "github",
      action: "issue.intake_dismiss",
      target: `${draft.repoFullName}#${draft.issueNumber}`,
      projectId: draft.projectId,
    });
    return true;
  },
});

export const getProjectSetting = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    return { enabled: Boolean(project.issueIntake?.enabled), label: intakeLabel(project.issueIntake?.label) };
  },
});

export const setProjectSetting = mutation({
  args: { projectId: v.id("projects"), enabled: v.boolean(), label: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    const label = intakeLabel(args.label ?? project.issueIntake?.label);
    const next = args.enabled || label !== "fhara" ? { enabled: args.enabled, ...(label !== "fhara" ? { label } : {}) } : undefined;
    await ctx.db.patch(args.projectId, { issueIntake: next });
    await recordAudit(ctx, {
      action: "project.update",
      target: project.name,
      projectId: args.projectId,
      details: { changed: ["issueIntake"], issueIntake: args.enabled },
    });
    return { enabled: args.enabled, label };
  },
});
