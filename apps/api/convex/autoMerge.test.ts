/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { signGithubPayload } from "./lib/githubWebhook";
import { autoMergePolicy, humanGate, matchGlob, mergeVerdict, MAX_PR_FILES, type MergeFacts } from "./lib/autoMerge";
import { desiredNotifications } from "./lib/prFeedback";

/** O2 supervised auto-merge: pure rules plus the evaluate → attempt → merge flow. */

const modules = import.meta.glob("./**/*.ts");
const SECRET = "env-webhook-secret";
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ["GITHUB_WEBHOOK_SECRET", "FHARA_AUTO_MERGE_MAX_LINES", "FHARA_AUTO_MERGE_SENSITIVE", "FHARA_AUTO_MERGE_METHOD"]) saved[key] = process.env[key];
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  delete process.env.FHARA_AUTO_MERGE_MAX_LINES;
  delete process.env.FHARA_AUTO_MERGE_SENSITIVE;
  delete process.env.FHARA_AUTO_MERGE_METHOD;
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

const base: MergeFacts = {
  prNumber: 12,
  state: "open",
  headSha: SHA,
  approvedSha: SHA,
  reviewState: "none",
  checks: [{ name: "ci", status: "passed" }],
  mergeableState: "clean",
  mergeable: "mergeable",
};

describe("pure rules", () => {
  test("mergeVerdict: one reason per state, in order", () => {
    expect(mergeVerdict(base)).toEqual({ kind: "ready" });
    const cases: Array<[Partial<MergeFacts>, "wait" | "blocked", string]> = [
      [{ state: "draft" }, "blocked", "draft"],
      [{ state: "closed" }, "blocked", "closed"],
      [{ headSha: SHA2 }, "blocked", "head_mismatch"],
      [{ approvedSha: undefined }, "wait", "head_unknown"],
      [{ fixInFlight: true }, "wait", "fix_in_flight"],
      [{ reactionPending: true }, "wait", "reaction_pending"],
      [{ reviewState: "changes_requested" }, "blocked", "changes_requested"],
      [{ checks: null }, "blocked", "checks_unverified"],
      [{ checks: [] }, "wait", "checks_none"],
      [{ checks: [{ name: "ci", status: "pending" }] }, "wait", "checks_pending"],
      [{ checks: [{ name: "ci", status: "failed", conclusion: "startup_failure" }] }, "blocked", "checks_failed"],
      [{ dependencyCheck: "failed" }, "blocked", "dependency_check"],
      [{ mergeableState: "dirty" }, "blocked", "dirty"],
      [{ mergeableState: "behind" }, "blocked", "behind"],
      [{ mergeableState: "blocked" }, "blocked", "gh_blocked"],
      [{ mergeableState: "has_hooks" }, "wait", "has_hooks"],
      [{ mergeableState: "unstable" }, "blocked", "unstable"],
      [{ mergeableState: "unknown" }, "wait", "mergeability_unknown"],
    ];
    for (const [patch, kind, code] of cases) {
      const verdict = mergeVerdict({ ...base, ...patch });
      expect(verdict.kind, code).toBe(kind);
      expect((verdict as { code: string }).code).toBe(code);
      expect((verdict as { reason: string }).reason.length).toBeGreaterThan(10);
    }
  });

  test("an errored check blocks; it is never skipped", () => {
    const v = mergeVerdict({ ...base, checks: [{ name: "ci", status: "passed" }, { name: "e2e", status: "failed", conclusion: "cancelled" }] });
    expect(v).toMatchObject({ kind: "blocked", code: "checks_failed" });
    expect((v as { reason: string }).reason).toContain("e2e (cancelled)");
  });

  test("humanGate: size, sensitive paths, and fail-closed", () => {
    const policy = { maxDiffLines: 400, sensitiveGlobs: [".github/**", "**/.env*"] };
    expect(humanGate([{ filename: "src/a.ts", additions: 200, deletions: 201 }], policy)).toEqual({
      ok: false,
      code: "gate_size",
      reason: "Diff size 401 lines exceeds 400",
    });
    expect(humanGate([{ filename: ".github/workflows/x.yml", additions: 1, deletions: 0 }], policy)).toMatchObject({ ok: false, code: "gate_path" });
    expect(humanGate([{ filename: "apps/web/.env.local", additions: 1, deletions: 0 }], policy)).toMatchObject({ ok: false, code: "gate_path" });
    // A rename out of a sensitive path counts too.
    expect(humanGate([{ filename: "docs/x.yml", previousFilename: ".github/x.yml", additions: 0, deletions: 0 }], policy)).toMatchObject({ ok: false });
    expect(humanGate(null, policy)).toEqual({ ok: false, code: "gate_unverified", reason: "Could not verify the diff (the file list did not load)" });
    const many = Array.from({ length: MAX_PR_FILES }, (_, i) => ({ filename: `f${i}`, additions: 0, deletions: 0 }));
    expect(humanGate(many, policy)).toMatchObject({ ok: false, code: "gate_unverified" });
    expect(humanGate([{ filename: "src/a.ts", additions: 80, deletions: 4 }], policy)).toEqual({ ok: true, lines: 84, files: 1 });
  });

  test("glob and policy parsing", () => {
    expect(matchGlob(".github/workflows/ci.yml", ".github/**")).toBe(true);
    expect(matchGlob("a/b/c.pem", "**/*.pem")).toBe(true);
    expect(matchGlob("x.pem", "**/*.pem")).toBe(true);
    expect(matchGlob("src/github.ts", ".github/**")).toBe(false);
    expect(matchGlob("apps/api/convex/schema.ts", "apps/api/convex/schema.ts")).toBe(true);
    expect(autoMergePolicy({})).toMatchObject({ maxDiffLines: 400, method: "squash" });
    expect(autoMergePolicy({ maxDiffLines: "50", sensitive: "a/**, b.txt", method: "rebase" })).toEqual({
      maxDiffLines: 50,
      sensitiveGlobs: ["a/**", "b.txt"],
      method: "rebase",
    });
    expect(autoMergePolicy({ method: "force" }).method).toBe("squash");
  });

  test("notifications: auto-merge replaces 'ready to merge'; a gate block asks the user", () => {
    const facts = { prState: "open" as const, ciState: "passed" as const, mergeable: "mergeable" as const };
    const common = { prNumber: 12, facts, reactionsEnabled: false, capReached: false, worktreeAvailable: true, fixActive: false, latestFixFailed: false };
    expect(desiredNotifications(common).map((n) => n.kind)).toEqual(["ready_to_merge"]);
    expect(desiredNotifications({ ...common, autoMerge: { enabled: true, state: "waiting", code: "checks_pending" } })).toEqual([]);
    const blocked = desiredNotifications({ ...common, autoMerge: { enabled: true, state: "blocked", code: "gate_size", reason: "Diff size 900 lines exceeds 400" } });
    expect(blocked).toEqual([{ kind: "auto_merge_blocked", title: "PR #12 needs your merge: Diff size 900 lines exceeds 400" }]);
  });
});

// ---------------------------------------------------------------------------

async function setup(opts: { autoMerge?: boolean; headSha?: string } = {}) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      name: "P",
      workspacePath: "/tmp/p",
      mainBranch: "main",
      ...(opts.autoMerge === false ? {} : { autoMerge: true }),
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
    const ownerId = await ctx.db.insert("tasks", { projectId, title: "Add dark mode", command: "add dark mode", status: "done", conversationId });
    const pushApproval = await ctx.db.insert("approvals", { taskId: ownerId, projectId, kind: "git_push", summary: "Push", status: "approved", decidedBy: "user" });
    const pushId = await ctx.db.insert("taskPushes", {
      taskId: ownerId,
      projectId,
      conversationId,
      branchName: "fhara/x/add-dark-mode",
      commitSha: SHA,
      commitMessage: "Fhara: Add dark mode",
      filesChanged: 2,
      status: "pushed",
      approvalId: pushApproval,
      attempts: 1,
      repoFullName: "acme/app",
      baseBranch: "main",
      prNumber: 12,
      prUrl: "https://github.com/acme/app/pull/12",
      prState: "open",
      headSha: opts.headSha ?? SHA,
      ciState: "passed",
      ciChecks: [{ name: "ci", status: "passed" }],
      mergeable: "mergeable",
      pushedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    return { projectId, ownerId, pushId, conversationId };
  });
  return { t, ...ids };
}
type T = Awaited<ReturnType<typeof setup>>["t"];

/** GitHub stub: PR, checks, files and the merge call. */
function stubGithub(opts: { head?: string; checks?: unknown[]; filesStatus?: number; files?: unknown[]; mergeStatus?: number; mergeableState?: string } = {}) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url.replace("https://api.github.com/repos/acme/app", "")}`);
    if (url.endsWith("/pulls/12/merge")) {
      const status = opts.mergeStatus ?? 200;
      return new Response(JSON.stringify(status === 200 ? { merged: true, sha: "c".repeat(40) } : { message: "Head branch was modified" }), { status });
    }
    if (url.endsWith("/pulls/12")) {
      return new Response(
        JSON.stringify({ state: "open", draft: false, merged: false, mergeable: true, mergeable_state: opts.mergeableState ?? "clean", head: { sha: opts.head ?? SHA } }),
        { status: 200 }
      );
    }
    if (url.includes("/pulls/12/files")) {
      if (opts.filesStatus && opts.filesStatus !== 200) return new Response("boom", { status: opts.filesStatus });
      return new Response(JSON.stringify(opts.files ?? [{ filename: "src/theme.ts", additions: 80, deletions: 4 }]), { status: 200 });
    }
    if (url.includes("/check-runs")) {
      return new Response(JSON.stringify({ check_runs: opts.checks ?? [{ id: 1, name: "ci", status: "completed", conclusion: "success" }] }), { status: 200 });
    }
    if (url.includes("/status")) return new Response(JSON.stringify({ statuses: [] }), { status: 200 });
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const pushRow = (t: T, pushId: Id<"taskPushes">) => t.run(async (ctx) => await ctx.db.get(pushId));
const mergeApprovals = (t: T) => t.run(async (ctx) => (await ctx.db.query("approvals").collect()).filter((a) => a.kind === "merge_pr"));
const openNotes = (t: T) => t.run(async (ctx) => (await ctx.db.query("notifications").collect()).filter((n) => n.status === "open").map((n) => n.kind));

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

describe("evaluate → attempt → merge", () => {
  test("off by default: a green PR schedules nothing and stays a 'ready to merge' notification", async () => {
    const { t } = await setup({ autoMerge: false });
    await deliver(t, "pull_request", { action: "edited", repository: { full_name: "acme/app" }, pull_request: { number: 12, state: "open", mergeable: true, head: { sha: SHA } } }, "p-1");
    const scheduled = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.some((s) => s.name.includes("autoMerge"))).toBe(false);
    expect(await openNotes(t)).toEqual(["ready_to_merge"]);
    expect(await mergeApprovals(t)).toEqual([]);
  });

  test("on: a green PR is merged with sha pinned, an auto approval, an audit row and a chat line", async () => {
    const { t, ownerId, pushId } = await setup();
    // The webhook path schedules the evaluation.
    await deliver(t, "pull_request", { action: "edited", repository: { full_name: "acme/app" }, pull_request: { number: 12, state: "open", mergeable: true, head: { sha: SHA } } }, "p-1");
    const scheduled = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.some((s) => s.name.includes("autoMerge") && s.name.includes("evaluate"))).toBe(true);

    const calls = stubGithub();
    expect(await t.mutation(internal.autoMerge.evaluate, { ownerTaskId: ownerId })).toEqual({ scheduled: true, reason: "checking" });
    expect((await pushRow(t, pushId))?.autoMerge?.state).toBe("checking");
    const result = await t.action(internal.autoMerge.attempt, { pushId });
    expect(result).toEqual({ merged: true, reason: "merged" });
    expect(calls.filter((c) => c.startsWith("PUT"))).toEqual(["PUT /pulls/12/merge"]);
    const mergeCall = (globalThis.fetch as any).mock.calls.find((c: any[]) => String(c[0]).endsWith("/merge"));
    expect(JSON.parse(mergeCall[1].body)).toEqual({ sha: SHA, merge_method: "squash" });

    const approvals = await mergeApprovals(t);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ status: "approved", decidedBy: "auto", taskId: ownerId });
    const audit = await t.run(async (ctx) => await ctx.db.query("audit").collect());
    expect(audit.some((a) => a.action === "pr.auto_merge" && a.decision === "allowed")).toBe(true);
    const row = await pushRow(t, pushId);
    expect(row?.prState).toBe("merged");
    expect(row?.autoMerge).toMatchObject({ state: "merged", code: "merged" });
    const messages = await t.run(async (ctx) => await ctx.db.query("messages").collect());
    expect(messages.some((m) => m.content.startsWith("Merged PR #12 automatically: 1 check passed, 84 lines in 1 file."))).toBe(true);
    expect(await openNotes(t)).toEqual([]);
  });

  test("a second green signal for the same head does not start a second attempt", async () => {
    const { t, ownerId } = await setup();
    stubGithub();
    expect((await t.mutation(internal.autoMerge.evaluate, { ownerTaskId: ownerId })).scheduled).toBe(true);
    expect(await t.mutation(internal.autoMerge.evaluate, { ownerTaskId: ownerId })).toEqual({ scheduled: false, reason: "checking" });
  });

  test("an errored check blocks: no merge call, the reason is stored", async () => {
    const { t, ownerId, pushId } = await setup();
    const calls = stubGithub({ checks: [{ id: 1, name: "ci", status: "completed", conclusion: "success" }, { id: 2, name: "e2e", status: "completed", conclusion: "startup_failure" }] });
    await t.mutation(internal.autoMerge.evaluate, { ownerTaskId: ownerId });
    expect(await t.action(internal.autoMerge.attempt, { pushId })).toEqual({ merged: false, reason: "checks_failed" });
    expect(calls.some((c) => c.startsWith("PUT"))).toBe(false);
    expect((await pushRow(t, pushId))?.autoMerge).toMatchObject({ state: "blocked", code: "checks_failed" });
    expect(await mergeApprovals(t)).toEqual([]);
  });

  test("the file list fails to load: blocked (fail closed) and the user is asked", async () => {
    const { t, ownerId, pushId } = await setup();
    const calls = stubGithub({ filesStatus: 502 });
    await t.mutation(internal.autoMerge.evaluate, { ownerTaskId: ownerId });
    expect(await t.action(internal.autoMerge.attempt, { pushId })).toEqual({ merged: false, reason: "gate_unverified" });
    expect(calls.some((c) => c.startsWith("PUT"))).toBe(false);
    expect(await openNotes(t)).toEqual(["auto_merge_blocked"]);
    // Head-bound reasons are not retried on the same head... but this one is
    // transient, so the next evaluation may try again after the throttle.
  });

  test("a big diff or a sensitive path blocks and is not retried on the same head", async () => {
    const { t, ownerId, pushId } = await setup();
    stubGithub({ files: [{ filename: ".github/workflows/ci.yml", additions: 3, deletions: 1 }] });
    await t.mutation(internal.autoMerge.evaluate, { ownerTaskId: ownerId });
    expect(await t.action(internal.autoMerge.attempt, { pushId })).toEqual({ merged: false, reason: "gate_path" });
    vi.advanceTimersByTime(5 * 60_000);
    expect(await t.mutation(internal.autoMerge.evaluate, { ownerTaskId: ownerId })).toEqual({ scheduled: false, reason: "gate_path" });
  });

  test("a head the user did not approve blocks", async () => {
    const { t, ownerId, pushId } = await setup();
    // Stored facts already show a foreign head: no attempt, a stored reason.
    await t.run(async (ctx) => await ctx.db.patch(pushId, { headSha: SHA2 }));
    expect(await t.mutation(internal.autoMerge.evaluate, { ownerTaskId: ownerId })).toEqual({ scheduled: false, reason: "head_mismatch" });
    expect((await pushRow(t, pushId))?.autoMerge?.reason).toContain("commits you did not approve");
    expect(await openNotes(t)).toEqual(["auto_merge_blocked"]);
    // Live head moved between evaluate and attempt: also blocked.
    await t.run(async (ctx) => await ctx.db.patch(pushId, { headSha: SHA, autoMerge: undefined }));
    stubGithub({ head: SHA2 });
    await t.mutation(internal.autoMerge.evaluate, { ownerTaskId: ownerId });
    expect(await t.action(internal.autoMerge.attempt, { pushId })).toEqual({ merged: false, reason: "head_mismatch" });
  });

  test("GitHub refuses the merge: state failed, audit denied, the user is asked", async () => {
    const { t, ownerId, pushId } = await setup();
    stubGithub({ mergeStatus: 409 });
    await t.mutation(internal.autoMerge.evaluate, { ownerTaskId: ownerId });
    expect(await t.action(internal.autoMerge.attempt, { pushId })).toEqual({ merged: false, reason: "merge_failed" });
    const row = await pushRow(t, pushId);
    expect(row?.prState).toBe("open");
    expect(row?.autoMerge?.state).toBe("failed");
    expect(row?.autoMerge?.reason).toContain("409");
    const audit = await t.run(async (ctx) => await ctx.db.query("audit").collect());
    expect(audit.some((a) => a.action === "pr.auto_merge_failed" && a.decision === "denied")).toBe(true);
    expect(await openNotes(t)).toEqual(["auto_merge_blocked"]);
  });

  test("pending checks wait with a reason; no GitHub call", async () => {
    const { t, ownerId, pushId } = await setup();
    await t.run(async (ctx) => await ctx.db.patch(pushId, { ciState: "pending", ciChecks: [{ name: "ci", status: "pending" }] }));
    const calls = stubGithub();
    expect(await t.mutation(internal.autoMerge.evaluate, { ownerTaskId: ownerId })).toEqual({ scheduled: false, reason: "checks_pending" });
    expect((await pushRow(t, pushId))?.autoMerge).toMatchObject({ state: "waiting", reason: "Waiting for 1 check on PR #12" });
    expect(calls).toEqual([]);
    expect(await openNotes(t)).toEqual([]);
  });

  test("project switch and new-project default", async () => {
    const { t, projectId } = await setup({ autoMerge: false });
    expect((await t.query(api.autoMerge.getProjectSetting, { projectId })).enabled).toBe(false);
    await t.mutation(api.autoMerge.setProjectSetting, { projectId, enabled: true });
    expect(await t.query(api.autoMerge.getProjectSetting, { projectId })).toMatchObject({ enabled: true, maxDiffLines: 400, method: "squash" });
    await t.mutation(api.appSettings.setNewProjectDefaults, { autoMerge: true });
    const created = await t.mutation(api.projects.create, { name: "Q", workspacePath: "/tmp/q" });
    expect((await t.run(async (ctx) => await ctx.db.get(created)))?.autoMerge).toBe(true);
  });
});
