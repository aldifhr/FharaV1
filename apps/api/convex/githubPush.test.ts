/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { buildPrBody, mapPrState } from "./githubPush";

const modules = import.meta.glob("./**/*.ts");
const SERVICE_TOKEN = "test-service-token-019";
const SHA = "0123456789abcdef0123456789abcdef01234567";

async function setup(options: { github?: boolean; ownerId?: string; repo?: boolean } = {}) {
  process.env.CONVEX_SERVICE_TOKEN = SERVICE_TOKEN;
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      name: "P",
      workspacePath: "/tmp/p",
      mainBranch: "main",
      ...(options.ownerId ? { ownerId: options.ownerId } : {}),
    });
    const conversationId = await ctx.db.insert("conversations", {
      projectId,
      status: "active",
      createdAt: Date.now(),
    });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "Add dark mode",
      command: "add dark mode",
      status: "running",
      workerId: "w1",
      leaseExpiresAt: Date.now() + 60_000,
      conversationId,
    });
    if (options.github !== false) {
      await ctx.db.insert("integrations", {
        projectId,
        type: "github",
        name: "GitHub",
        accessToken: "gho_secret_token",
        status: "active",
        createdAt: Date.now(),
        ...(options.repo === false ? {} : { githubOwner: "acme", githubRepo: "app", githubBaseBranch: "develop" }),
      });
    }
    return { projectId, conversationId, taskId };
  });
  return { t, ...ids };
}

async function commit(t: Awaited<ReturnType<typeof setup>>["t"], taskId: any, projectId: any, workerId = "w1") {
  return await t.mutation(internal.githubPush.recordTaskCommit, {
    taskId,
    projectId,
    workerId,
    branchName: "fhara/t/add-dark-mode",
    commitSha: SHA,
    commitMessage: "Fhara: Add dark mode",
    filesChanged: 3,
    ahead: 1,
    behind: 0,
    comparedTo: "main",
  });
}

describe("githubPush.recordTaskCommit", () => {
  test("creates a ready push row and a push card in the task's conversation, idempotently", async () => {
    const { t, taskId, projectId, conversationId } = await setup();
    const first = await commit(t, taskId, projectId);
    expect(first.applied).toBe(true);
    const second = await commit(t, taskId, projectId);
    expect(second.applied && second.deduped).toBe(true);
    const { pushes, cards } = await t.run(async (ctx) => ({
      pushes: await ctx.db.query("taskPushes").collect(),
      cards: (await ctx.db.query("messages").collect()).filter((m) => m.card?.kind === "push"),
    }));
    expect(pushes).toHaveLength(1);
    expect(pushes[0].status).toBe("ready");
    expect(cards).toHaveLength(1);
    expect(cards[0].conversationId).toBe(conversationId);
    expect(cards[0].taskId).toBe(taskId);
    expect(cards[0].card?.data.pushId).toBe(String(pushes[0]._id));
    expect(pushes[0].messageId).toBe(cards[0]._id);
  });

  test("a displaced worker is refused (lease fencing)", async () => {
    const { t, taskId, projectId } = await setup();
    const res = await commit(t, taskId, projectId, "w2");
    expect(res).toEqual({ applied: false, reason: "lease_lost" });
  });

  test("worker action is token-gated", async () => {
    const { t, taskId, projectId } = await setup();
    const args = {
      taskId,
      projectId,
      workerId: "w1",
      branchName: "b",
      commitSha: SHA,
      commitMessage: "m",
      filesChanged: 1,
    };
    await expect(t.action(api.worker.recordTaskCommit, { ...args, workerToken: "wrong" })).rejects.toThrow(
      "Worker authentication required"
    );
    const ok = await t.action(api.worker.recordTaskCommit, { ...args, workerToken: SERVICE_TOKEN });
    expect(ok.applied).toBe(true);
  });
});

describe("githubPush.postTaskCard", () => {
  test("inserts a verification card into the task conversation and dedupes by key", async () => {
    const { t, taskId, projectId, conversationId } = await setup();
    const data = { iteration: 0, outcome: "passed", checks: [], idempotencyKey: "verify:0" };
    const a = await t.mutation(internal.githubPush.postTaskCard, { taskId, projectId, workerId: "w1", kind: "verification", data });
    const b = await t.mutation(internal.githubPush.postTaskCard, { taskId, projectId, workerId: "w1", kind: "verification", data });
    expect(a.applied && b.applied).toBe(true);
    const cards = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).filter((m) => m.card?.kind === "verification")
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].conversationId).toBe(conversationId);
    expect(cards[0].card?.data.taskId).toBe(String(taskId));
  });

  test("the same key updates a live card in place (QA checklist)", async () => {
    const { t, taskId, projectId } = await setup();
    const key = "qa:0:1";
    await t.mutation(internal.githubPush.postTaskCard, {
      taskId, projectId, workerId: "w1", kind: "qa",
      data: { outcome: "running", rows: [{ label: "1440 px, desktop", status: "running" }], idempotencyKey: key },
    });
    await t.mutation(internal.githubPush.postTaskCard, {
      taskId, projectId, workerId: "w1", kind: "qa",
      data: { outcome: "passed", rows: [{ label: "1440 px, desktop", status: "passed" }], idempotencyKey: key },
    });
    const cards = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).filter((m) => m.card?.kind === "qa")
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].card?.data.outcome).toBe("passed");
  });

  test("refuses a worker that does not hold the lease", async () => {
    const { t, taskId, projectId } = await setup();
    const res = await t.mutation(internal.githubPush.postTaskCard, {
      taskId,
      projectId,
      workerId: "other",
      kind: "qa",
      data: { outcome: "passed" },
    });
    expect(res).toEqual({ applied: false, reason: "lease_lost" });
  });
});

describe("githubPush.requestPush → claim → complete", () => {
  test("ready → requested (with an approved git_push approval) → pushing → pushed", async () => {
    const { t, taskId, projectId } = await setup();
    const { pushId } = (await commit(t, taskId, projectId)) as any;

    const req = await t.mutation(api.githubPush.requestPush, { pushId, openPr: true });
    expect(req).toEqual({ status: "requested", changed: true });
    // Idempotent: a second click does not create a second approval.
    const again = await t.mutation(api.githubPush.requestPush, { pushId, openPr: true });
    expect(again).toEqual({ status: "requested", changed: false });
    const approvals = await t.run(async (ctx) => await ctx.db.query("approvals").collect());
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ kind: "git_push", status: "approved", taskId });

    const claim = await t.mutation(internal.githubPush.claimPushRequest, { workerId: "w9" });
    expect(claim).toMatchObject({
      pushId,
      commitSha: SHA,
      owner: "acme",
      repo: "app",
      baseBranch: "develop",
      openPr: true,
      token: "gho_secret_token",
    });
    expect(claim?.prBody).toContain("## Verification");
    expect(claim?.prBody).toContain("not run");
    // Nothing else to claim while it is leased.
    expect(await t.mutation(internal.githubPush.claimPushRequest, { workerId: "w8" })).toBeNull();

    // Only the claiming worker may complete it.
    const wrong = await t.mutation(internal.githubPush.completePushRequest, {
      pushId,
      workerId: "w8",
      outcome: "pushed",
    });
    expect(wrong).toEqual({ applied: false, reason: "lease_lost" });

    const done = await t.mutation(internal.githubPush.completePushRequest, {
      pushId,
      workerId: "w9",
      outcome: "pushed",
      pr: { number: 42, url: "https://github.com/acme/app/pull/42", title: "Add dark mode", state: "draft" },
    });
    expect(done).toEqual({ applied: true });
    const view = await t.query(api.githubPush.get, { pushId });
    expect(view).toMatchObject({ status: "pushed", prNumber: 42, prState: "draft" });
    expect(JSON.stringify(view)).not.toContain("gho_secret_token");

    // A late duplicate completion is refused, not applied.
    const late = await t.mutation(internal.githubPush.completePushRequest, {
      pushId,
      workerId: "w9",
      outcome: "failed",
      error: "x",
    });
    expect(late).toEqual({ applied: false, reason: "not_pushing" });
    // Pushed with a PR: another click is a no-op.
    expect(await t.mutation(api.githubPush.requestPush, { pushId, openPr: true })).toEqual({
      status: "pushed",
      changed: false,
    });
  });

  test("failed push can be retried from the card", async () => {
    const { t, taskId, projectId } = await setup();
    const { pushId } = (await commit(t, taskId, projectId)) as any;
    await t.mutation(api.githubPush.requestPush, { pushId, openPr: false });
    await t.mutation(internal.githubPush.claimPushRequest, { workerId: "w9" });
    await t.mutation(internal.githubPush.completePushRequest, {
      pushId,
      workerId: "w9",
      outcome: "failed",
      error: "remote rejected",
    });
    expect((await t.query(api.githubPush.get, { pushId }))?.status).toBe("failed");
    const retry = await t.mutation(api.githubPush.requestPush, { pushId, openPr: false });
    expect(retry).toEqual({ status: "requested", changed: true });
  });

  test("push only, then open the PR later re-queues the pushed row", async () => {
    const { t, taskId, projectId } = await setup();
    const { pushId } = (await commit(t, taskId, projectId)) as any;
    await t.mutation(api.githubPush.requestPush, { pushId, openPr: false });
    await t.mutation(internal.githubPush.claimPushRequest, { workerId: "w9" });
    await t.mutation(internal.githubPush.completePushRequest, { pushId, workerId: "w9", outcome: "pushed" });
    expect(await t.mutation(api.githubPush.requestPush, { pushId, openPr: false })).toEqual({
      status: "pushed",
      changed: false,
    });
    expect(await t.mutation(api.githubPush.requestPush, { pushId, openPr: true })).toEqual({
      status: "requested",
      changed: true,
    });
  });

  test("requires a connected GitHub repository", async () => {
    const { t, taskId, projectId } = await setup({ repo: false });
    const { pushId } = (await commit(t, taskId, projectId)) as any;
    await expect(t.mutation(api.githubPush.requestPush, { pushId, openPr: true })).rejects.toThrow(
      /Connect GitHub/
    );
  });

  test("enforces project access when the project has an owner", async () => {
    const { t, taskId, projectId } = await setup({ ownerId: "alice" });
    const { pushId } = (await commit(t, taskId, projectId)) as any;
    await expect(
      t.withIdentity({ subject: "mallory" }).mutation(api.githubPush.requestPush, { pushId, openPr: true })
    ).rejects.toThrow(/Unauthorized/);
    await expect(t.query(api.githubPush.get, { pushId })).rejects.toThrow(/Unauthorized/);
    const ok = await t.withIdentity({ subject: "alice" }).mutation(api.githubPush.requestPush, { pushId, openPr: true });
    expect(ok.status).toBe("requested");
  });

  test("a revoked approval fails the request at claim time instead of pushing", async () => {
    const { t, taskId, projectId } = await setup();
    const { pushId } = (await commit(t, taskId, projectId)) as any;
    await t.mutation(api.githubPush.requestPush, { pushId, openPr: true });
    await t.run(async (ctx) => {
      const approval = (await ctx.db.query("approvals").collect())[0];
      await ctx.db.patch(approval._id, { status: "rejected" });
    });
    expect(await t.mutation(internal.githubPush.claimPushRequest, { workerId: "w9" })).toBeNull();
    const view = await t.query(api.githubPush.get, { pushId });
    expect(view?.status).toBe("failed");
    expect(view?.error).toMatch(/approval/i);
  });

  test("a stale pushing lease is requeued, then failed after the attempt bound", async () => {
    const { t, taskId, projectId } = await setup();
    const { pushId } = (await commit(t, taskId, projectId)) as any;
    await t.mutation(api.githubPush.requestPush, { pushId, openPr: false });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claim = await t.mutation(internal.githubPush.claimPushRequest, { workerId: `w${attempt}`, leaseMs: 1 });
      expect(claim?.pushId).toBe(pushId);
      await t.run(async (ctx) => ctx.db.patch(pushId, { leaseExpiresAt: Date.now() - 1_000 }));
    }
    expect(await t.mutation(internal.githubPush.claimPushRequest, { workerId: "w4" })).toBeNull();
    const view = await t.query(api.githubPush.get, { pushId });
    expect(view?.status).toBe("failed");
  });

  test("worker claim/complete actions are token-gated", async () => {
    const { t } = await setup();
    await expect(
      t.action(api.worker.claimPushRequest, { workerId: "w1", workerToken: "wrong" })
    ).rejects.toThrow("Worker authentication required");
    expect(await t.action(api.worker.claimPushRequest, { workerId: "w1", workerToken: SERVICE_TOKEN })).toBeNull();
  });
});

describe("githubPush PR refresh selection", () => {
  test("lists only open/draft PRs not checked recently, bounded", async () => {
    const { t, taskId, projectId } = await setup();
    const now = Date.now();
    await t.run(async (ctx) => {
      const base = {
        taskId,
        projectId,
        branchName: "b",
        commitSha: SHA,
        commitMessage: "m",
        filesChanged: 1,
        status: "pushed" as const,
        attempts: 1,
        createdAt: now,
        updatedAt: now,
      };
      await ctx.db.insert("taskPushes", { ...base, prNumber: 1, prState: "open", prCheckedAt: now - 3_600_000 });
      await ctx.db.insert("taskPushes", { ...base, prNumber: 2, prState: "draft", prCheckedAt: now - 3_600_000 });
      await ctx.db.insert("taskPushes", { ...base, prNumber: 3, prState: "open", prCheckedAt: now });
      await ctx.db.insert("taskPushes", { ...base, prNumber: 4, prState: "merged", prCheckedAt: now - 3_600_000 });
    });
    const ids = await t.query(internal.githubPush.listPrsToRefresh, { now });
    const numbers = await t.run(async (ctx) => Promise.all(ids.map(async (id) => (await ctx.db.get(id))?.prNumber)));
    expect(numbers.sort()).toEqual([1, 2]);
  });
});

describe("githubPush helpers", () => {
  test("mapPrState", () => {
    expect(mapPrState({ state: "open", draft: true })).toBe("draft");
    expect(mapPrState({ state: "open" })).toBe("open");
    expect(mapPrState({ state: "closed", merged: true })).toBe("merged");
    expect(mapPrState({ state: "closed", merged_at: "2026-01-01" })).toBe("merged");
    expect(mapPrState({ state: "closed" })).toBe("closed");
  });

  test("buildPrBody never reports a missing stage as passed", () => {
    const body = buildPrBody({
      title: "T",
      command: "do T\n\n--- Conversation context ---\nsecret chatter",
      commitSha: SHA,
      filesChanged: 2,
      verification: {
        taskId: "t",
        iteration: 0,
        outcome: "failed",
        checks: [
          { name: "typecheck", status: "passed" },
          { name: "test", status: "failed" },
          { name: "build", status: "not_run", detail: "no script" },
        ],
      },
      qa: null,
    });
    expect(body).toContain("typecheck: ✅ passed");
    expect(body).toContain("test: ❌ failed");
    expect(body).toContain("build: ⏭️ not run — no script");
    expect(body).toMatch(/## QA\n\n- not run/);
    expect(body).not.toContain("secret chatter");
  });
});

describe("tasks.createFromCommand conversation link", () => {
  test("stores the chat conversation on the task so stage cards can find it", async () => {
    const { t, projectId, conversationId } = await setup();
    const taskId = await t.mutation(api.tasks.createFromCommand, {
      projectId,
      command: "build a landing page",
      conversationId,
    });
    const task = await t.run(async (ctx) => await ctx.db.get(taskId));
    expect(task?.conversationId).toBe(conversationId);
  });
});

describe("githubPush.holdPush and the card view", () => {
  test("hold is recorded, then cleared by an approval; the view carries stage results", async () => {
    const { t, taskId, projectId } = await setup();
    const { pushId } = (await commit(t, taskId, projectId)) as any;
    await t.mutation(internal.githubPush.postTaskCard, {
      taskId, projectId, workerId: "w1", kind: "verification",
      data: { outcome: "passed", checks: [{ name: "test", status: "passed", counts: { passed: 9, total: 9 } }] },
    });
    expect(await t.mutation(api.githubPush.holdPush, { pushId })).toEqual({ held: true, status: "ready" });
    let view = await t.query(api.githubPush.get, { pushId });
    expect(view?.heldAt).toBeTypeOf("number");
    expect(view?.verification?.checks[0]).toMatchObject({ name: "test", counts: { passed: 9, total: 9 } });
    expect(view?.qa).toBeNull();
    expect(view?.projectName).toBe("P");
    await t.mutation(api.githubPush.requestPush, { pushId, openPr: true });
    view = await t.query(api.githubPush.get, { pushId });
    expect(view?.heldAt).toBeUndefined();
    expect(await t.mutation(api.githubPush.holdPush, { pushId })).toEqual({ held: false, status: "requested" });
  });
});
