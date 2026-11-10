/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { canonicalJson, verifyAuditChain } from "./lib/auditHash";

const modules = import.meta.glob("./**/*.ts");

async function seed(n: number) {
  const t = convexTest(schema, modules);
  for (let i = 1; i <= n; i++) {
    await t.mutation(internal.audit.record, {
      actor: "worker",
      tool: "cmd",
      action: "cmd.git",
      decision: "recorded",
      target: `git push #${i}`,
      details: { argv: ["push", String(i)], exitCode: 0 },
    });
  }
  const rowAt = async (seq: number) =>
    await t.run(async (ctx) => await ctx.db.query("audit").withIndex("by_seq", (q) => q.eq("seq", seq)).first());
  return { t, rowAt };
}

describe("O5 audit hash chain", () => {
  test("100 inserted rows verify", async () => {
    const { t, rowAt } = await seed(100);
    const verdict = await t.query(api.auditLog.verifyChain, {});
    expect(verdict).toMatchObject({ ok: true, checked: 100, preChain: 0, lastSeq: 100 });
    const first = await rowAt(1);
    expect(first?.prevHash).toBe("");
    expect((await rowAt(2))?.prevHash).toBe(first?.hash);
  }, 60_000);

  test("patching row 40's details → broken at row 40", async () => {
    const { t, rowAt } = await seed(100);
    const row = (await rowAt(40))!;
    await t.run(async (ctx) => await ctx.db.patch(row._id, { details: { argv: ["push", "tampered"], exitCode: 0 } }));
    const verdict = await t.query(api.auditLog.verifyChain, {});
    expect(verdict).toMatchObject({ ok: false, brokenAt: 40, reason: "row content changed" });
  }, 60_000);

  test("deleting row 60 directly → broken at row 61", async () => {
    const { t, rowAt } = await seed(100);
    const row = (await rowAt(60))!;
    await t.run(async (ctx) => await ctx.db.delete(row._id));
    expect(await t.query(api.auditLog.verifyChain, {})).toMatchObject({ ok: false, brokenAt: 61 });
  }, 60_000);

  test("deleting row 1 directly is caught too", async () => {
    const { t, rowAt } = await seed(5);
    const row = (await rowAt(1))!;
    await t.run(async (ctx) => await ctx.db.delete(row._id));
    expect(await t.query(api.auditLog.verifyChain, {})).toMatchObject({ ok: false, brokenAt: 2 });
  });

  test("a delete through the audit page is recorded and the chain still verifies", async () => {
    const { t, rowAt } = await seed(10);
    await t.mutation(api.auditLog.remove, { id: (await rowAt(4))!._id });
    await t.mutation(api.auditLog.removeMany, { ids: [(await rowAt(7))!._id, (await rowAt(8))!._id] });
    const verdict = await t.query(api.auditLog.verifyChain, {});
    expect(verdict).toMatchObject({ ok: true, lastSeq: 12 });
    const tomb = await rowAt(12);
    expect(tomb?.action).toBe("audit.delete");
    expect((tomb?.details as { deleted: Array<{ seq: number }> }).deleted.map((d) => d.seq)).toEqual([7, 8]);
  });

  test("rows from before the chain are pre-chain, not broken", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++)
        await ctx.db.insert("audit", { actor: "user", tool: "config", action: "old", decision: "recorded", createdAt: i });
    });
    await t.mutation(internal.audit.record, { actor: "worker", tool: "cmd", action: "cmd.git", decision: "recorded" });
    expect(await t.query(api.auditLog.verifyChain, {})).toMatchObject({ ok: true, checked: 1, preChain: 3 });
  });

  test("recordAudit (config writes) rows are chained", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.agents.create, { name: "Bea", role: "backend" });
    const rows = await t.run(async (ctx) => await ctx.db.query("audit").collect());
    expect(rows.every((r) => typeof r.hash === "string" && typeof r.seq === "number")).toBe(true);
    expect(await t.query(api.auditLog.verifyChain, {})).toMatchObject({ ok: true });
  });

  test("canonical JSON is key-order independent", async () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe('{"a":{"d":[1,{"x":1,"y":2}]},"b":1}');
    expect((await verifyAuditChain([])).ok).toBe(true);
  });
});
