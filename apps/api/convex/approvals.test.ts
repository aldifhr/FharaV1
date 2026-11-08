/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
function makeT() {
  return convexTest(schema, modules);
}

async function setup() {
  const t = makeT();
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      name: "P",
      workspacePath: "/tmp/p",
    });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "Do work",
      command: "do it",
      status: "needs_approval",
    });
    const approvalId = await ctx.db.insert("approvals", {
      taskId,
      projectId,
      kind: "git_push",
      summary: "Push branch",
      status: "pending",
    });
    return { projectId, taskId, approvalId };
  });
  return { t, ...ids };
}

describe("approvals.hold", () => {
  test("keeps the approval pending and records an approval.held event", async () => {
    const { t, approvalId } = await setup();
    const held = await t.mutation(api.approvals.hold, { approvalId });
    expect(held).toBe(true);
    const approval = await t.query(api.approvals.getById, { approvalId });
    expect(approval?.status).toBe("pending");
    const events = await t.query(api.taskEvents.listByTask, {
      taskId: approval!.taskId,
    });
    expect(events.some((e) => e.type === "approval.held")).toBe(true);
  });

  test("throws when the approval was already resolved", async () => {
    const { t, approvalId } = await setup();
    await t.mutation(api.approvals.approve, { approvalId });
    await expect(t.mutation(api.approvals.hold, { approvalId })).rejects.toThrow(
      /already approved/
    );
  });
});
