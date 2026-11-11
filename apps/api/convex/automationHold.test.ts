/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { parseIssueSignal } from "./lib/issueIntake";
import { AUTOMATION_HELD_CODE, cronHeld, isAutomaticTask } from "./lib/automationHold";

/** GOAT G3: while automation is held nothing acts on its own; user tasks still run; resuming continues. */

const modules = import.meta.glob("./**/*.ts");
const SHA = "a".repeat(40);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type T = Awaited<ReturnType<typeof setupPr>>["t"];
const hold = (t: T) => t.mutation(api.appSettings.setAutomationHold, { held: true, reason: "travelling" });
const resume = (t: T) => t.mutation(api.appSettings.setAutomationHold, { held: false });
const scheduledNames = (t: T) =>
  t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((s) => s.state.kind === "pending").map((s) => s.name));
const auditActions = (t: T) => t.run(async (ctx) => (await ctx.db.query("audit").collect()).map((a) => a.action));

async function setupPr() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", mainBranch: "main", autoMerge: true });
    await ctx.db.insert("integrations", {
      projectId,
      type: "github",
      name: "GitHub",
      accessToken: "gho_token",
      githubOwner: "acme",
      githubRepo: "app",
      status: "active",
      createdAt: 1,
    });
    const ownerId = await ctx.db.insert("tasks", { projectId, title: "Add dark mode", command: "add dark mode", status: "done" });
    const approvalId = await ctx.db.insert("approvals", { taskId: ownerId, projectId, kind: "git_push", summary: "Push", status: "approved", decidedBy: "user" });
    const pushId = await ctx.db.insert("taskPushes", {
      taskId: ownerId,
      projectId,
      branchName: "fhara/x/add-dark-mode",
      commitSha: SHA,
      commitMessage: "Fhara: Add dark mode",
      filesChanged: 2,
      status: "pushed",
      approvalId,
      attempts: 1,
      repoFullName: "acme/app",
      baseBranch: "main",
      prNumber: 12,
      prState: "open",
      headSha: SHA,
      ciState: "passed",
      ciChecks: [{ name: "ci", status: "passed" }],
      mergeable: "mergeable",
      pushedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    return { projectId, ownerId, pushId };
  });
  return { t, ...ids };
}

function stubGithub() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url.replace("https://api.github.com/repos/acme/app", "")}`);
      if (url.endsWith("/pulls/12/merge")) return new Response(JSON.stringify({ merged: true }), { status: 200 });
      if (url.endsWith("/pulls/12")) {
        return new Response(JSON.stringify({ state: "open", draft: false, merged: false, mergeable: true, mergeable_state: "clean", head: { sha: SHA } }), { status: 200 });
      }
      if (url.includes("/pulls/12/files")) return new Response(JSON.stringify([{ filename: "src/theme.ts", additions: 10, deletions: 2 }]), { status: 200 });
      if (url.includes("/check-runs")) return new Response(JSON.stringify({ check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success" }] }), { status: 200 });
      if (url.includes("/status")) return new Response(JSON.stringify({ statuses: [] }), { status: 200 });
      return new Response("not found", { status: 404 });
    })
  );
  return calls;
}

describe("pure rules", () => {
  test("only PR-feedback fix tasks count as automatic work", () => {
    expect(isAutomaticTask({ prFix: undefined })).toBe(false);
    expect(isAutomaticTask({ prFix: { repoFullName: "a/b", prNumber: 1, kind: "ci_failed", reactionId: "r" as Id<"prReactions"> } })).toBe(true);
  });

  test("cron hold: held jobs skip unless a person pressed Run now; safety jobs never hold", () => {
    const h = { heldAt: 1 };
    expect(cronHeld("prune context snapshots", undefined, h)).toBe(true);
    expect(cronHeld("prune context snapshots", "manual", h)).toBe(false);
    expect(cronHeld("prune context snapshots", undefined, null)).toBe(false);
    expect(cronHeld("recover expired task leases", undefined, h)).toBe(false);
    expect(cronHeld("task watchdog", undefined, h)).toBe(false);
  });
});

describe("the switch", () => {
  test("hold and resume are saved, audited and idempotent", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.appSettings.automationHold, {})).toBeNull();
    await hold(t);
    expect(await t.query(api.appSettings.automationHold, {})).toMatchObject({ reason: "travelling" });
    expect((await t.query(api.appSettings.get, {})).automationHold).toMatchObject({ reason: "travelling" });
    await hold(t);
    await resume(t);
    expect(await t.query(api.appSettings.automationHold, {})).toBeNull();
    expect(await auditActions(t)).toEqual(["automation.hold", "automation.resume"]);
  });

  test("the O3 per-task hold is untouched by the global one", async () => {
    const { t, projectId } = await setupPr();
    const taskId = await t.run(async (ctx) => await ctx.db.insert("tasks", { projectId, title: "x", command: "x", status: "queued" }));
    await hold(t);
    await resume(t);
    const task = await t.run(async (ctx) => await ctx.db.get(taskId));
    expect(task?.status).toBe("queued");
    expect(task?.pausedBy).toBeUndefined();
  });
});

describe("auto-merge", () => {
  test("held: evaluate records 'held', schedules no attempt and makes no GitHub call", async () => {
    const { t, ownerId, pushId } = await setupPr();
    const calls = stubGithub();
    await hold(t);
    expect(await t.mutation(internal.autoMerge.evaluate, { ownerTaskId: ownerId })).toEqual({ scheduled: false, reason: "held" });
    const row = await t.run(async (ctx) => await ctx.db.get(pushId));
    expect(row?.autoMerge).toMatchObject({ state: "waiting", code: AUTOMATION_HELD_CODE });
    expect((await scheduledNames(t)).some((n) => n.includes("autoMerge"))).toBe(false);
    expect(calls).toEqual([]);
  });

  test("an attempt already in flight when the hold lands does not merge", async () => {
    const { t, ownerId, pushId } = await setupPr();
    const calls = stubGithub();
    expect((await t.mutation(internal.autoMerge.evaluate, { ownerTaskId: ownerId })).scheduled).toBe(true);
    await hold(t);
    expect(await t.action(internal.autoMerge.attempt, { pushId })).toEqual({ merged: false, reason: "superseded" });
    expect(calls.some((c) => c.startsWith("PUT"))).toBe(false);
    expect((await t.run(async (ctx) => await ctx.db.get(pushId)))?.autoMerge?.code).toBe(AUTOMATION_HELD_CODE);
  });

  test("resuming re-evaluates held PRs and the merge goes through", async () => {
    const { t, ownerId, pushId } = await setupPr();
    const calls = stubGithub();
    await hold(t);
    await t.mutation(internal.autoMerge.evaluate, { ownerTaskId: ownerId });
    expect(await resume(t)).toEqual({ held: false, resumed: 1 });
    expect((await scheduledNames(t)).some((n) => n.includes("autoMerge") && n.includes("evaluate"))).toBe(true);
    expect(await t.mutation(internal.autoMerge.evaluate, { ownerTaskId: ownerId })).toEqual({ scheduled: true, reason: "checking" });
    expect(await t.action(internal.autoMerge.attempt, { pushId })).toEqual({ merged: true, reason: "merged" });
    expect(calls.filter((c) => c.startsWith("PUT"))).toEqual(["PUT /pulls/12/merge"]);
  });
});

describe("issue intake", () => {
  const issue = (number = 7) =>
    parseIssueSignal("issues", {
      action: "opened",
      repository: { full_name: "acme/app" },
      issue: {
        number,
        title: "Dark mode toggle",
        body: "Add a toggle.",
        state: "open",
        html_url: `https://github.com/acme/app/issues/${number}`,
        user: { login: "aldifhr" },
        labels: [{ name: "fhara" }],
      },
    })!;

  test("held: no draft, no GitHub call, an 'issue.intake_held' audit row; resumed: drafts again", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", issueIntake: { enabled: true } });
      await ctx.db.insert("githubConnections", { scope: "global", login: "aldifhr", status: "active", accessTokenCiphertext: "x", createdAt: 1, updatedAt: 1 });
      return id;
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await hold(t);
    expect(await t.action(internal.issueIntake.receive, { projectId, signal: issue() })).toEqual({ draftId: null, reason: "held" });
    expect(await t.run(async (ctx) => await ctx.db.query("issueDrafts").collect())).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await auditActions(t)).toContain("issue.intake_held");
    await resume(t);
    expect((await t.action(internal.issueIntake.receive, { projectId, signal: issue() })).reason).toBe("draft");
  });
});

describe("cron wrappers", () => {
  const runRow = (t: T, name: string) =>
    t.run(async (ctx) => await ctx.db.query("cronRuns").withIndex("by_name", (q) => q.eq("name", name)).first());

  test("held jobs record 'held' and do nothing; safety jobs and Run now still run", async () => {
    const t = convexTest(schema, modules);
    await hold(t);
    await t.mutation(internal.cronJobs.pruneContextSnapshots, {});
    expect(await runRow(t, "prune context snapshots")).toMatchObject({ lastStatus: "held", trigger: "cron", runCount: 0 });
    await t.action(internal.cronJobs.sweepStaleWorktrees, {});
    expect(await runRow(t, "sweep stale task worktrees")).toMatchObject({ lastStatus: "held" });
    await t.action(internal.cronJobs.refreshTaskPullRequests, {});
    expect(await runRow(t, "refresh task pull requests")).toMatchObject({ lastStatus: "held" });
    // The prune reschedules itself when it runs; held, nothing was scheduled.
    expect((await scheduledNames(t)).some((n) => n.includes("contextSnapshots"))).toBe(false);

    await t.mutation(internal.cronJobs.recoverExpiredLeases, {});
    expect(await runRow(t, "recover expired task leases")).toMatchObject({ lastStatus: "ok" });
    await t.mutation(internal.cronJobs.pruneContextSnapshots, { trigger: "manual" });
    expect(await runRow(t, "prune context snapshots")).toMatchObject({ lastStatus: "ok", trigger: "manual", runCount: 1 });

    await resume(t);
    await t.mutation(internal.cronJobs.pruneContextSnapshots, {});
    expect(await runRow(t, "prune context snapshots")).toMatchObject({ lastStatus: "ok", trigger: "cron" });
    const listed = await t.query(api.cronJobs.list, {});
    expect(listed.filter((j) => j.heldByAutomationHold).map((j) => j.name).sort()).toEqual([
      "prune context snapshots",
      "refresh task pull requests",
      "run scheduled tasks", // G7: held per scheduled task inside the tick
      "sweep stale task worktrees",
    ]);
  });
});

describe("worker claim", () => {
  test("held: user tasks are claimed, automatic fix tasks wait; resumed: they run", async () => {
    const { t, projectId, ownerId, pushId } = await setupPr();
    const { fixId, userId } = await t.run(async (ctx) => {
      const reactionId = await ctx.db.insert("prReactions", {
        projectId,
        ownerTaskId: ownerId,
        pushId,
        repoFullName: "acme/app",
        prNumber: 12,
        kind: "ci_failed",
        signature: `ci:${SHA}`,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      });
      // The automatic task is older, so an unheld claim would take it first.
      const fixId = await ctx.db.insert("tasks", {
        projectId,
        title: "Fix CI on PR #12",
        command: "fix",
        status: "queued",
        prFix: { repoFullName: "acme/app", prNumber: 12, kind: "ci_failed", reactionId },
      });
      const userId = await ctx.db.insert("tasks", { projectId, title: "User task", command: "do it", status: "queued" });
      return { fixId, userId };
    });
    await hold(t);
    expect((await t.mutation(internal.orchestration.claimNextTask, { workerId: "w1" }))?._id).toBe(userId);
    expect(await t.mutation(internal.orchestration.claimNextTask, { workerId: "w1" })).toBeNull();
    expect((await t.run(async (ctx) => await ctx.db.get(fixId)))?.status).toBe("queued");
    await resume(t);
    expect((await t.mutation(internal.orchestration.claimNextTask, { workerId: "w1" }))?._id).toBe(fixId);
  });
});
