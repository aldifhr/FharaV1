/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  OPTION_PREVIEW_CSP,
  autoPickDraft,
  canSubmit,
  htmlLooksActive,
  normalizeDraft,
  previewDocument,
  reviewReplyText,
  skipsOptionsReview,
  validateReviewShape,
} from "./lib/optionsReview";

const modules = import.meta.glob("./**/*.ts");
const SERVICE_TOKEN = "options-review-harness-token";

const OPTIONS = [
  { id: "A", title: "Dense table", kind: "markdown" as const, markdown: "| a | b |\n|---|---|\n| 1 | 2 |" },
  { id: "B", title: "Cards", kind: "html" as const, html: "<!doctype html><html><head></head><body><p>Cards</p></body></html>" },
  { id: "C", title: "Split view", kind: "markdown" as const, markdown: "Left list, right detail" },
  { id: "REF", title: "Current page", kind: "markdown" as const, markdown: "today", reference: true },
];

async function seed(t: ReturnType<typeof convexTest>, project: { optionsReviewSkipRoles?: string[] } = {}) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", ...project });
    const taskId = await ctx.db.insert("tasks", {
      projectId,
      title: "Redesign the inbox",
      command: "Redesign the inbox list",
      status: "running",
      workerId: "w1",
      leaseExpiresAt: Date.now() + 60_000,
    });
    return { projectId, taskId };
  });
}

async function createReview(t: ReturnType<typeof convexTest>, ids: { projectId: any; taskId: any }, extra: Record<string, unknown> = {}) {
  process.env.CONVEX_SERVICE_TOKEN = SERVICE_TOKEN;
  return (await t.action(api.worker.createOptionReview, {
    workerToken: SERVICE_TOKEN,
    taskId: ids.taskId,
    projectId: ids.projectId,
    subtaskKey: "design",
    role: "Designer",
    purpose: "design",
    title: "Inbox layout",
    recommended: "C",
    options: OPTIONS,
    workerId: "w1",
    ...extra,
  } as any)) as { reviewId: Id<"optionReviews">; status: "pending" | "auto"; replyText: string | null };
}

describe("lib/optionsReview", () => {
  test("validateReviewShape guards ids, counts, reference picks and recommended", () => {
    expect(validateReviewShape({ title: "T", purpose: "design", options: OPTIONS, recommended: "A" }).recommended).toBe("A");
    expect(() => validateReviewShape({ title: "T", purpose: "nope", options: OPTIONS })).toThrow(/purpose/);
    expect(() => validateReviewShape({ title: "T", purpose: "design", options: [...OPTIONS, OPTIONS[0]] })).toThrow(/Duplicate/);
    expect(() => validateReviewShape({ title: "T", purpose: "design", options: OPTIONS, recommended: "REF" })).toThrow(/reference/);
    expect(() => validateReviewShape({ title: "T", purpose: "design", options: [OPTIONS[3]] })).toThrow(/picked/);
    expect(() => validateReviewShape({ title: "T", purpose: "design", options: [{ id: "a b", title: "x", kind: "markdown", markdown: "m" }] })).toThrow(/letters/);
    expect(() => validateReviewShape({ title: "T", purpose: "design", route: "http://x", options: OPTIONS })).toThrow(/route/);
  });

  test("normalizeDraft orders picks, refuses references and picks+none, needs something to send", () => {
    const review = { title: "T", options: OPTIONS };
    expect(normalizeDraft(review, { pickedIds: ["C", "A"], notes: [] }).pickedIds).toEqual(["A", "C"]);
    expect(() => normalizeDraft(review, { pickedIds: ["REF"], notes: [] })).toThrow(/reference/);
    expect(() => normalizeDraft(review, { pickedIds: ["A"], none: true, notes: [] })).toThrow(/not both/);
    expect(() => normalizeDraft(review, { pickedIds: [], notes: [] }, true)).toThrow(/Pick an option/);
    expect(canSubmit(review, { pickedIds: [], notes: [], none: true })).toBe(true);
    expect(canSubmit(review, { pickedIds: [], notes: [] })).toBe(false);
  });

  test("reply text names picks, notes and passed-over options", () => {
    const text = reviewReplyText({ title: "T", options: OPTIONS }, { pickedIds: ["B"], notes: [{ optionId: "B", note: "less padding" }], reply: "go" });
    expect(text).toContain("Picked B. Cards.");
    expect(text).toContain("Notes on B (Cards): less padding");
    expect(text).toContain("Passed over: A. Dense table; C. Split view.");
    expect(text).not.toContain("REF.");
  });

  test("auto pick uses recommended, else first pickable; skip roles are case-insensitive and off by default", () => {
    expect(autoPickDraft({ title: "T", options: OPTIONS, recommended: "C" }).pickedIds).toEqual(["C"]);
    expect(autoPickDraft({ title: "T", options: [OPTIONS[3], OPTIONS[1]] }).pickedIds).toEqual(["B"]);
    expect(skipsOptionsReview({}, "designer")).toBe(false);
    expect(skipsOptionsReview({ optionsReviewSkipRoles: ["Designer"] }, "designer")).toBe(true);
    expect(skipsOptionsReview({ optionsReviewSkipRoles: ["designer"] }, undefined)).toBe(false);
  });

  test("previewDocument puts the CSP meta first in head, or wraps a fragment", () => {
    const doc = previewDocument('<!doctype html><html><head><meta charset="utf-8"></head><body>x</body></html>');
    expect(OPTION_PREVIEW_CSP).toContain("default-src 'none'");
    expect(doc).toMatch(/<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">/);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf('charset="utf-8"'));
    const wrapped = previewDocument("<p>bare</p>");
    expect(wrapped).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/);
    expect(wrapped).toContain("<body><p>bare</p></body>");
    const attrs = previewDocument('<html><head lang="en"></head><body></body></html>');
    expect(attrs).toContain('<head lang="en"><meta http-equiv="Content-Security-Policy"');
  });

  test("htmlLooksActive backstop", () => {
    expect(htmlLooksActive("<p>ok</p>")).toBeNull();
    expect(htmlLooksActive("<SCRIPT>")).toMatch(/script/);
    expect(htmlLooksActive('<img src=x onerror="a()">')).toMatch(/event handler/);
    expect(htmlLooksActive('<a href="javascript:a()">')).toMatch(/javascript/);
    expect(htmlLooksActive('<div style="background:url(javascript:a())">')).toMatch(/javascript/);
    expect(htmlLooksActive("<iframe>")).toMatch(/embedding/);
    expect(htmlLooksActive('<meta http-equiv="refresh" content="0">')).toMatch(/refresh/);
  });
});

describe("optionReviews (Convex)", () => {
  test("create stores a pending review and one options card; saveDraft never answers", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const created = await createReview(t, ids);
    expect(created.status).toBe("pending");
    expect(created.replyText).toBeNull();
    const cards = await t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((m) => m.card?.kind === "options"));
    expect(cards).toHaveLength(1);
    expect((cards[0].card as any).data.reviewId).toBe(String(created.reviewId));

    const view = await t.query(api.optionReviews.get, { reviewId: created.reviewId });
    expect(view?.status).toBe("pending");
    expect(view?.role).toBe("designer");
    const saved = await t.mutation(api.optionReviews.saveDraft, {
      reviewId: created.reviewId,
      revision: view!.revision,
      draft: { pickedIds: ["B"], notes: [{ optionId: "B", note: "tighter" }] },
    });
    expect(saved.revision).toBe(view!.revision + 1);
    // Same draft again: no new revision.
    const again = await t.mutation(api.optionReviews.saveDraft, {
      reviewId: created.reviewId,
      revision: saved.revision,
      draft: { pickedIds: ["B"], notes: [{ optionId: "B", note: "tighter" }] },
    });
    expect(again.revision).toBe(saved.revision);
    // Stale revision refused.
    await expect(
      t.mutation(api.optionReviews.saveDraft, { reviewId: created.reviewId, revision: 0, draft: { pickedIds: ["A"], notes: [] } })
    ).rejects.toThrow(/changed/);
    const worker = await t.action(api.worker.getOptionReview, { workerToken: SERVICE_TOKEN, reviewId: created.reviewId } as any);
    expect(worker?.status).toBe("pending");
    expect(worker?.replyText).toBeNull();
  });

  test("submit answers once, a repeated identical submit is idempotent, a different one is refused", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const { reviewId } = await createReview(t, ids);
    const draft = { pickedIds: ["A"], notes: [], reply: "Go with the table" };
    const first = await t.mutation(api.optionReviews.submit, { reviewId, revision: 0, draft });
    expect(first).toEqual({ status: "answered", repeated: false });
    const retry = await t.mutation(api.optionReviews.submit, { reviewId, revision: 0, draft });
    expect(retry).toEqual({ status: "answered", repeated: true });
    await expect(t.mutation(api.optionReviews.submit, { reviewId, revision: 1, draft: { pickedIds: ["C"], notes: [] } })).rejects.toThrow(
      /already answered/
    );
    await expect(t.mutation(api.optionReviews.saveDraft, { reviewId, revision: 1, draft: { pickedIds: ["C"], notes: [] } })).rejects.toThrow(
      /already answered/
    );
    const events = await t.run(async (ctx) => (await ctx.db.query("taskEvents").collect()).filter((e) => e.type === "options_review.answered"));
    expect(events).toHaveLength(1);
    const brief = await t.run(async (ctx) => await ctx.db.query("taskBriefs").withIndex("by_task", (q) => q.eq("taskId", ids.taskId)).first());
    expect(brief?.decisions?.some((d) => d.includes("user picked A (Dense table)"))).toBe(true);
    const worker = await t.action(api.worker.getOptionReview, { workerToken: SERVICE_TOKEN, reviewId } as any);
    expect(worker?.status).toBe("answered");
    expect(worker?.replyText).toContain("Picked A. Dense table.");
  });

  test("submit refuses an empty answer and an unknown option", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const { reviewId } = await createReview(t, ids);
    await expect(t.mutation(api.optionReviews.submit, { reviewId, revision: 0, draft: { pickedIds: [], notes: [] } })).rejects.toThrow(/Pick an option/);
    await expect(t.mutation(api.optionReviews.submit, { reviewId, revision: 0, draft: { pickedIds: ["Z"], notes: [] } })).rejects.toThrow(/Unknown/);
    const none = await t.mutation(api.optionReviews.submit, { reviewId, revision: 0, draft: { pickedIds: [], notes: [], none: true } });
    expect(none.repeated).toBe(false);
  });

  test("a project that skips the role auto-picks the recommended option at create", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, { optionsReviewSkipRoles: ["designer"] });
    const created = await createReview(t, ids);
    expect(created.status).toBe("auto");
    expect(created.replyText).toContain("picked automatically");
    expect(created.replyText).toContain("Picked C. Split view.");
    const row = await t.run(async (ctx) => await ctx.db.get(created.reviewId));
    expect(row?.status).toBe("auto");
    expect(row?.decidedBy).toBe("auto");
    expect(row?.response?.pickedIds).toEqual(["C"]);
    // Another role in the same project still asks.
    const other = await createReview(t, ids, { role: "frontend" });
    expect(other.status).toBe("pending");
  });

  test("setSkipRoles normalizes and clears", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    expect((await t.mutation(api.optionReviews.setSkipRoles, { projectId: ids.projectId, roles: [" Designer ", "designer", ""] })).roles).toEqual([
      "designer",
    ]);
    await t.mutation(api.optionReviews.setSkipRoles, { projectId: ids.projectId, roles: [] });
    const project = await t.run(async (ctx) => await ctx.db.get(ids.projectId));
    expect(project?.optionsReviewSkipRoles).toBeUndefined();
  });

  test("create refuses active html, a lost lease and a terminal task", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await expect(
      createReview(t, ids, { options: [{ id: "A", title: "x", kind: "html", html: "<p onclick=\"a()\">x</p>" }], recommended: undefined })
    ).rejects.toThrow(/event handler/);
    await expect(createReview(t, ids, { workerId: "w2" })).rejects.toThrow(/Lease lost/);
    await t.run(async (ctx) => ctx.db.patch(ids.taskId, { status: "done" }));
    await expect(createReview(t, ids)).rejects.toThrow(/already done/);
  });
});
