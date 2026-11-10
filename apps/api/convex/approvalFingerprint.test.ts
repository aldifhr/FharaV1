/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { APPROVAL_SHOWN_TTL_MS, approvalFingerprint, checkShown, stableStringify } from "./lib/approvalFingerprint";

/** O6: a decision binds to what was shown (fingerprint) and when (TTL). */

const modules = import.meta.glob("./**/*.ts");

async function setup(kind: "git_push" | "run_command" = "git_push") {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
    const taskId = await ctx.db.insert("tasks", { projectId, title: "T", command: "do", status: "needs_approval" });
    const approvalId = await ctx.db.insert("approvals", {
      taskId,
      projectId,
      kind,
      summary: kind === "run_command" ? "Run npm test" : "Push branch",
      ...(kind === "run_command" ? { payload: { command: "npm test", inline: true }, arguments: { command: "npm", args: ["test"] } } : {}),
      status: "pending",
    });
    return { projectId, taskId, approvalId };
  });
  return { t, ...ids };
}

describe("pure", () => {
  test("stable JSON ignores key order and undefined", () => {
    expect(stableStringify({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe('{"a":[1,{"d":2}],"b":1}');
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  test("fingerprint changes with what is shown; check honours the TTL", async () => {
    const a = { _id: "x", kind: "git_push", summary: "Push" };
    const fp = await approvalFingerprint(a);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(await approvalFingerprint({ ...a, summary: "Push other" })).not.toBe(fp);
    const now = 1_000_000_000;
    expect(await checkShown(a, {}, now)).toEqual({ ok: true });
    expect(await checkShown(a, { fingerprint: fp, shownAt: now - 1000 }, now)).toEqual({ ok: true });
    expect((await checkShown(a, { fingerprint: "0".repeat(16), shownAt: now }, now)).ok).toBe(false);
    expect(await checkShown(a, { fingerprint: fp, shownAt: now - APPROVAL_SHOWN_TTL_MS - 1 }, now)).toMatchObject({ ok: false, reason: expect.stringContaining("10 minutes") });
    expect((await checkShown(a, { fingerprint: fp }, now)).ok).toBe(false);
    expect((await checkShown(a, { fingerprint: fp, shownAt: now + 10 * 60_000 }, now)).ok).toBe(false);
  });
});

describe("approve / reject / respond", () => {
  test("the pending list carries the fingerprint; approve with it works", async () => {
    const { t, projectId, approvalId } = await setup();
    const [row] = await t.query(api.approvals.listPendingForProject, { projectId });
    expect(row.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const inbox = await t.query(api.inbox.list, {});
    expect(inbox.approvals[0].fingerprint).toBe(row.fingerprint);
    await t.mutation(api.approvals.approve, { approvalId, fingerprint: row.fingerprint, shownAt: Date.now() });
    expect((await t.run(async (ctx) => await ctx.db.get(approvalId)))?.status).toBe("approved");
  });

  test("a changed approval is refused with 'changed since it was shown'", async () => {
    const { t, projectId, approvalId } = await setup();
    const [row] = await t.query(api.approvals.listPendingForProject, { projectId });
    await t.run(async (ctx) => await ctx.db.patch(approvalId, { summary: "Push a different branch" }));
    await expect(t.mutation(api.approvals.approve, { approvalId, fingerprint: row.fingerprint, shownAt: Date.now() })).rejects.toThrow(/changed since it was shown/);
    await expect(t.mutation(api.approvals.reject, { approvalId, fingerprint: row.fingerprint, shownAt: Date.now() })).rejects.toThrow(/changed since it was shown/);
    expect((await t.run(async (ctx) => await ctx.db.get(approvalId)))?.status).toBe("pending");
  });

  test("shown too long ago is refused; no fingerprint keeps the old behaviour", async () => {
    const { t, projectId, approvalId } = await setup();
    const [row] = await t.query(api.approvals.listPendingForProject, { projectId });
    await expect(
      t.mutation(api.approvals.approve, { approvalId, fingerprint: row.fingerprint, shownAt: Date.now() - APPROVAL_SHOWN_TTL_MS - 5_000 })
    ).rejects.toThrow(/10 minutes/);
    await t.mutation(api.approvals.approve, { approvalId });
    expect((await t.run(async (ctx) => await ctx.db.get(approvalId)))?.status).toBe("approved");
  });

  test("command respond is bound the same way", async () => {
    const { t, projectId, approvalId } = await setup("run_command");
    const [row] = await t.query(api.approvals.listPendingForProject, { projectId });
    await expect(t.mutation(api.commandApprovals.respond, { approvalId, decision: "allow", fingerprint: "f".repeat(16), shownAt: Date.now() })).rejects.toThrow(
      /changed since it was shown/
    );
    const res = await t.mutation(api.commandApprovals.respond, { approvalId, decision: "allow", fingerprint: row.fingerprint, shownAt: Date.now() });
    expect(res.decision).toBe("allow");
  });
});
