/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { signGithubPayload } from "./lib/githubWebhook";
import {
  buildFixPrompt,
  derivePrLane,
  desiredNotifications,
  fenced,
  fixMaxAttempts,
  foldCheck,
  logTail,
  parsePrSignal,
  type PrSignal,
} from "./lib/prFeedback";

/**
 * Post-push feedback loop: webhook → PR facts → reaction → fix task on the
 * owner's branch/worktree; dedupe, per-PR retry cap, deferral while a fix
 * is in flight, self-resolving notifications.
 */

const modules = import.meta.glob("./**/*.ts");
const SECRET = "env-webhook-secret";
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const SERVICE_TOKEN = "test-service-token-pr";

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ["GITHUB_WEBHOOK_SECRET", "FHARA_PR_FIX_MAX_ATTEMPTS", "CONVEX_SERVICE_TOKEN"]) saved[key] = process.env[key];
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  process.env.CONVEX_SERVICE_TOKEN = SERVICE_TOKEN;
  delete process.env.FHARA_PR_FIX_MAX_ATTEMPTS;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function setup(opts: { enabled?: boolean; worktree?: boolean } = {}) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      name: "P",
      workspacePath: "/tmp/p",
      mainBranch: "main",
      ...(opts.enabled === false ? {} : { prFeedbackReactions: true }),
    });
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
    const conversationId = await ctx.db.insert("conversations", { projectId, status: "active", createdAt: 1 });
    const ownerId = await ctx.db.insert("tasks", {
      projectId,
      title: "Add dark mode",
      command: "add dark mode",
      status: "done",
      conversationId,
      ...(opts.worktree === false
        ? {}
        : { branchName: "fhara/x/add-dark-mode", worktreePath: "/tmp/p/.moagent-worktrees/P/fhara/x/add-dark-mode" }),
    });
    const pushId = await ctx.db.insert("taskPushes", {
      taskId: ownerId,
      projectId,
      conversationId,
      branchName: "fhara/x/add-dark-mode",
      commitSha: SHA,
      commitMessage: "Fhara: Add dark mode",
      filesChanged: 2,
      status: "pushed",
      attempts: 1,
      repoFullName: "acme/app",
      baseBranch: "main",
      prNumber: 12,
      prUrl: "https://github.com/acme/app/pull/12",
      prState: "open",
      headSha: SHA,
      createdAt: 1,
      updatedAt: 1,
    });
    return { projectId, ownerId, pushId, conversationId };
  });
  return { t, ...ids };
}

type T = Awaited<ReturnType<typeof setup>>["t"];

const checkRunBody = (conclusion: string, opts: { sha?: string; name?: string; id?: number } = {}) => ({
  action: "completed",
  repository: { full_name: "acme/app" },
  check_run: {
    id: opts.id ?? 555,
    name: opts.name ?? "build",
    status: "completed",
    conclusion,
    head_sha: opts.sha ?? SHA,
    html_url: "https://github.com/acme/app/runs/555",
    app: { slug: "github-actions" },
    output: { title: "Build failed", summary: "tsc exited 2" },
    pull_requests: [{ number: 12 }],
    check_suite: { head_branch: "fhara/x/add-dark-mode" },
  },
});

const reviewBody = (state: string, id = 900) => ({
  action: "submitted",
  repository: { full_name: "acme/app" },
  pull_request: { number: 12, head: { sha: SHA } },
  review: { id, state, body: "Please rename the toggle.", user: { login: "rev" }, html_url: "https://github.com/acme/app/pull/12#r" },
});

const commentBody = (id: number, reviewId = 900) => ({
  action: "created",
  repository: { full_name: "acme/app" },
  pull_request: { number: 12 },
  comment: { id, pull_request_review_id: reviewId, path: "src/theme.ts", line: 42, body: "Use the token here", user: { login: "rev" } },
});

async function deliver(t: T, event: string, body: unknown, delivery: string) {
  const raw = JSON.stringify(body);
  return await t.fetch("/integrations/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": await signGithubPayload(SECRET, raw),
    },
    body: raw,
  });
}

const reactions = (t: T) => t.run(async (ctx) => await ctx.db.query("prReactions").collect());
const fixTasks = (t: T, ownerId: any) =>
  t.run(async (ctx) => await ctx.db.query("tasks").withIndex("by_parent", (q) => q.eq("parentTaskId", ownerId)).collect());
const openNotes = (t: T) =>
  t.run(async (ctx) => (await ctx.db.query("notifications").collect()).filter((n) => n.status === "open").map((n) => n.kind));

/** GitHub API stub: check runs, a job log, review comments. */
function stubGithub() {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/check-runs")) {
      return new Response(
        JSON.stringify({
          check_runs: [
            { id: 555, name: "build", status: "completed", conclusion: "failure", html_url: "https://ci/555", app: { slug: "github-actions" } },
            { id: 556, name: "lint", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.includes("/actions/jobs/555/logs")) {
      return new Response("2026-11-09T10:00:00.0000000Z step 1\n2026-11-09T10:00:01.0000000Z error TS2322: bad type in src/theme.ts\n", {
        status: 200,
      });
    }
    if (url.includes("/reviews/900/comments")) {
      return new Response(
        JSON.stringify([{ id: 1, path: "src/theme.ts", line: 42, body: "Use the token here", user: { login: "rev" } }]),
        { status: 200 }
      );
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ---------------------------------------------------------------------------

describe("pure helpers", () => {
  test("parsePrSignal reads check runs, reviews, review comments and PR state", () => {
    const check = parsePrSignal("check_run", checkRunBody("failure")) as Extract<PrSignal, { kind: "check_run" }>;
    expect(check).toMatchObject({ kind: "check_run", prNumbers: [12], headSha: SHA, check: { name: "build", status: "failed" } });
    expect(parsePrSignal("check_run", checkRunBody("success"))).toMatchObject({ check: { status: "passed" } });
    expect(parsePrSignal("pull_request_review", reviewBody("changes_requested"))).toMatchObject({
      kind: "review",
      review: { id: 900, state: "changes_requested" },
    });
    expect(parsePrSignal("pull_request_review_comment", commentBody(1))).toMatchObject({
      kind: "review_comment",
      reviewId: 900,
      comment: { path: "src/theme.ts", line: 42 },
    });
    expect(
      parsePrSignal("pull_request", {
        action: "synchronize",
        repository: { full_name: "acme/app" },
        pull_request: { number: 12, state: "open", mergeable: false, mergeable_state: "dirty", head: { sha: SHA2 } },
      })
    ).toMatchObject({ kind: "pull_request", state: "open", mergeable: "conflict", headSha: SHA2 });
    expect(parsePrSignal("issues", { repository: { full_name: "acme/app" } })).toBeNull();
    expect(parsePrSignal("check_run", { repository: {} })).toBeNull();
  });

  test("derivePrLane", () => {
    expect(derivePrLane({ prState: "merged" })).toBe("merged");
    expect(derivePrLane({ prState: "closed" })).toBeNull();
    expect(derivePrLane({ prState: "open", ciState: "failed", reviewState: "changes_requested" })).toBe("ci_failed");
    expect(derivePrLane({ prState: "open", reviewState: "changes_requested" })).toBe("changes_requested");
    expect(derivePrLane({ prState: "open", mergeable: "conflict" })).toBe("changes_requested");
    expect(derivePrLane({ prState: "draft", ciState: "passed", mergeable: "mergeable" })).toBe("ready_to_merge");
    expect(derivePrLane({ prState: "open", ciState: "pending", mergeable: "mergeable" })).toBe("in_review");
    expect(derivePrLane({ prState: "open" })).toBe("in_review");
  });

  test("foldCheck starts over on a new head commit", () => {
    const one = foldCheck({}, SHA, { name: "build", status: "failed" });
    expect(one.ciState).toBe("failed");
    const two = foldCheck(one, SHA, { name: "build", status: "passed" });
    expect(two.ciState).toBe("passed");
    const moved = foldCheck(one, SHA2, { name: "lint", status: "pending" });
    expect(moved.ciChecks.map((c) => c.name)).toEqual(["lint"]);
  });

  test("fixMaxAttempts reads FHARA_PR_FIX_MAX_ATTEMPTS", () => {
    expect(fixMaxAttempts(undefined)).toBe(3);
    expect(fixMaxAttempts("5")).toBe(5);
    expect(fixMaxAttempts("nope")).toBe(3);
    expect(fixMaxAttempts("-2")).toBe(0);
  });

  test("fix prompt carries the log tail and file:line comments; fences survive backticks", () => {
    const ci = buildFixPrompt({
      kind: "ci_failed",
      repoFullName: "acme/app",
      prNumber: 12,
      branchName: "fhara/x/a",
      ownerTitle: "A",
      attempt: 1,
      maxAttempts: 3,
      details: { checks: [{ name: "build", logTail: logTail("x\n".repeat(200) + "boom") }] },
    });
    expect(ci).toContain("boom");
    expect(ci).toContain("Do not push");
    const review = buildFixPrompt({
      kind: "review_comments",
      repoFullName: "acme/app",
      prNumber: 12,
      branchName: "fhara/x/a",
      ownerTitle: "A",
      attempt: 2,
      maxAttempts: 3,
      details: { comments: [{ id: 1, path: "src/a.ts", line: 7, body: "nit" }] },
    });
    expect(review).toContain("src/a.ts:7");
    expect(fenced("a ``` b")).toMatch(/^````text\n/);
  });

  test("desiredNotifications: Fhara's turn vs the user's", () => {
    const base = { prNumber: 1, capReached: false, worktreeAvailable: true, fixActive: false, latestFixFailed: false };
    expect(desiredNotifications({ ...base, facts: { prState: "open", ciState: "failed" }, reactionsEnabled: true })).toEqual([]);
    expect(desiredNotifications({ ...base, facts: { prState: "open", ciState: "failed" }, reactionsEnabled: false }).map((n) => n.kind)).toEqual([
      "ci_failed",
    ]);
    expect(
      desiredNotifications({ ...base, capReached: true, facts: { prState: "open", ciState: "failed" }, reactionsEnabled: true }).map((n) => n.kind)
    ).toEqual(["ci_failed", "fix_cap_reached"]);
    expect(desiredNotifications({ ...base, facts: { prState: "merged" }, reactionsEnabled: true })).toEqual([]);
  });
});

describe("webhook → reaction → fix task", () => {
  test("a failed check run on the PR queues a fix on the same branch/worktree with the log tail", async () => {
    const { t, ownerId, pushId } = await setup();
    stubGithub();
    const res = await deliver(t, "check_run", checkRunBody("failure"), "d-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ linked: 1, reaction: "scheduled" });
    const row = await t.run(async (ctx) => await ctx.db.get(pushId));
    expect(row).toMatchObject({ ciState: "failed", headSha: SHA });

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const fixes = await fixTasks(t, ownerId);
    expect(fixes).toHaveLength(1);
    const owner = await t.run(async (ctx) => await ctx.db.get(ownerId));
    expect(fixes[0]).toMatchObject({
      status: "queued",
      parentTaskId: ownerId,
      branchName: owner!.branchName,
      worktreePath: owner!.worktreePath,
      conversationId: owner!.conversationId,
      prFix: { prNumber: 12, kind: "ci_failed" },
    });
    expect(fixes[0].command).toContain("error TS2322: bad type in src/theme.ts");
    expect(fixes[0].command).not.toContain("2026-11-09T10:00:01");
    expect((await reactions(t))[0]).toMatchObject({ status: "created", fixTaskId: fixes[0]._id });
    // Fhara owns the next step: no "needs you".
    expect(await openNotes(t)).toEqual([]);
    const lanes = await t.query(api.prFeedback.lanesByProject, { projectId: owner!.projectId });
    expect(lanes[0]).toMatchObject({ taskId: ownerId, lane: "ci_failed", fixing: true, fixAttempts: 1, failedChecks: ["build"] });
  });

  test("duplicate events are skipped: a replayed delivery and a second failure of the same commit", async () => {
    const { t } = await setup();
    stubGithub();
    await deliver(t, "check_run", checkRunBody("failure"), "d-1");
    const replay = await deliver(t, "check_run", checkRunBody("failure"), "d-1");
    expect(await replay.json()).toMatchObject({ duplicate: true });
    const second = await deliver(t, "check_run", checkRunBody("failure", { name: "lint", id: 556 }), "d-2");
    expect(await second.json()).toMatchObject({ reaction: "duplicate" });
    const rows = await reactions(t);
    expect(rows).toHaveLength(1);
    // The second failure joins the pending reaction's context.
    expect((rows[0].context as any).checks.map((c: any) => c.name)).toEqual(["build", "lint"]);
  });

  test("review comments with the same review id become one fix with file:line", async () => {
    const { t, ownerId } = await setup();
    stubGithub();
    await deliver(t, "pull_request_review_comment", commentBody(1), "c-1");
    await deliver(t, "pull_request_review_comment", commentBody(2), "c-2");
    await deliver(t, "pull_request_review", reviewBody("changes_requested"), "r-1");
    const rows = await reactions(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("changes_requested");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const fixes = await fixTasks(t, ownerId);
    expect(fixes).toHaveLength(1);
    expect(fixes[0].command).toContain("src/theme.ts:42");
    expect(fixes[0].command).toContain("Please rename the toggle.");
  });

  test("a second signal waits while a fix is in flight, then runs when it settles", async () => {
    const { t, ownerId } = await setup();
    stubGithub();
    await deliver(t, "check_run", checkRunBody("failure"), "d-1");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const review = await deliver(t, "pull_request_review", reviewBody("changes_requested"), "r-1");
    expect(await review.json()).toMatchObject({ reaction: "deferred" });

    const [fix] = await fixTasks(t, ownerId);
    await t.run(async (ctx) => await ctx.db.patch(fix._id, { status: "running", workerId: "w1", leaseExpiresAt: Date.now() + 60_000 }));
    await t.mutation(internal.orchestration.completeTask, { taskId: fix._id, status: "failed", errorMessage: "x", workerId: "w1" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const fixes = await fixTasks(t, ownerId);
    expect(fixes.map((f) => f.prFix?.kind).sort()).toEqual(["changes_requested", "ci_failed"]);
  });

  test("retry cap per PR (FHARA_PR_FIX_MAX_ATTEMPTS) stops fixes and asks the user", async () => {
    process.env.FHARA_PR_FIX_MAX_ATTEMPTS = "1";
    const { t, ownerId } = await setup();
    stubGithub();
    await deliver(t, "check_run", checkRunBody("failure"), "d-1");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const [fix] = await fixTasks(t, ownerId);
    await t.run(async (ctx) => await ctx.db.patch(fix._id, { status: "done" }));

    const res = await deliver(t, "pull_request_review", reviewBody("changes_requested", 901), "r-2");
    expect(await res.json()).toMatchObject({ reaction: "cap_reached" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await fixTasks(t, ownerId)).toHaveLength(1);
    expect((await openNotes(t)).sort()).toEqual(["changes_requested", "ci_failed", "fix_cap_reached"]);
  });

  test("reactions off: nothing is queued, the user is told, and the notice clears when CI restarts", async () => {
    const { t, ownerId, pushId } = await setup({ enabled: false });
    const res = await deliver(t, "check_run", checkRunBody("failure"), "d-1");
    expect(await res.json()).toMatchObject({ reaction: "disabled" });
    expect(await reactions(t)).toHaveLength(0);
    expect(await fixTasks(t, ownerId)).toHaveLength(0);
    expect(await openNotes(t)).toEqual(["ci_failed"]);

    await deliver(
      t,
      "pull_request",
      { action: "synchronize", repository: { full_name: "acme/app" }, pull_request: { number: 12, state: "open", head: { sha: SHA2 } } },
      "p-1"
    );
    expect(await t.run(async (ctx) => await ctx.db.get(pushId))).toMatchObject({ headSha: SHA2, ciChecks: [] });
    expect(await openNotes(t)).toEqual([]);
  });

  test("ready to merge, then merged: notification resolves, pending reactions drop, worktree release is scheduled", async () => {
    const { t, ownerId } = await setup();
    await deliver(t, "check_run", checkRunBody("success"), "d-1");
    await deliver(
      t,
      "pull_request",
      { action: "edited", repository: { full_name: "acme/app" }, pull_request: { number: 12, state: "open", mergeable: true, head: { sha: SHA } } },
      "p-1"
    );
    expect(await openNotes(t)).toEqual(["ready_to_merge"]);
    await deliver(
      t,
      "pull_request",
      { action: "closed", repository: { full_name: "acme/app" }, pull_request: { number: 12, state: "closed", merged: true, head: { sha: SHA } } },
      "p-2"
    );
    expect(await openNotes(t)).toEqual([]);
    const lanes = await t.run(async (ctx) => {
      const owner = await ctx.db.get(ownerId);
      return owner!.projectId;
    });
    expect((await t.query(api.prFeedback.lanesByProject, { projectId: lanes }))[0].lane).toBe("merged");
    const scheduled = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.some((s) => s.name.includes("releasePrWorktree"))).toBe(true);
  });

  test("no kept worktree: the fix is skipped and the user is asked", async () => {
    const { t, ownerId } = await setup({ worktree: false });
    stubGithub();
    await deliver(t, "check_run", checkRunBody("failure"), "d-1");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await fixTasks(t, ownerId)).toHaveLength(0);
    expect((await reactions(t))[0]).toMatchObject({ status: "skipped", skipReason: "worktree_gone" });
    expect(await openNotes(t)).toEqual(["ci_failed"]);
  });

  test("a fix task's commit joins the owner's PR, so the push updates it instead of opening a new one", async () => {
    const { t, ownerId, projectId } = await setup();
    stubGithub();
    await deliver(t, "check_run", checkRunBody("failure"), "d-1");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const [fix] = await fixTasks(t, ownerId);
    await t.run(async (ctx) => await ctx.db.patch(fix._id, { status: "running", workerId: "w1", leaseExpiresAt: Date.now() + 60_000 }));
    const res = await t.mutation(internal.githubPush.recordTaskCommit, {
      taskId: fix._id,
      projectId,
      workerId: "w1",
      branchName: "fhara/x/add-dark-mode",
      commitSha: SHA2,
      commitMessage: "Fhara: fix",
      filesChanged: 1,
    });
    const row = await t.run(async (ctx) => await ctx.db.get((res as any).pushId));
    expect(row).toMatchObject({ ownerTaskId: ownerId, prNumber: 12, repoFullName: "acme/app", status: "ready" });
  });
});
