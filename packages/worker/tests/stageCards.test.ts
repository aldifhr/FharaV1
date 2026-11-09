import { describe, expect, it, vi } from "vitest";
import {
  applyQaCheck,
  buildChangesCard,
  buildQaCard,
  buildVerificationCard,
  plannedQaRows,
  postStageCard,
} from "@/services/runner/cards";
import { parseTestCounts } from "@/execution/verification";

describe("buildVerificationCard", () => {
  it("never reports a step that did not run as passed", () => {
    const card = buildVerificationCard(
      {
        checks: [
          { name: "web:typecheck", status: "passed", durationMs: 1200, details: "`npm run typecheck` passed in 1.2s" },
          { name: "web:lint", status: "failed", durationMs: 800, details: "`npm run lint` exited with code 1. error x\nmore" },
        ],
        ran: ["web:typecheck", "web:lint"],
        skipped: [],
      },
      { iteration: 0, durationMs: 2100 }
    );
    expect(card.outcome).toBe("failed");
    expect(card.checks.map((c) => [c.name, c.status])).toEqual([
      ["typecheck", "passed"],
      ["lint", "failed"],
      ["test", "not_run"],
      ["build", "not_run"],
    ]);
    expect(card.checks[2].detail).toMatch(/earlier failure/);
    expect(card.logTail).toContain("error x");
    expect(card.durationMs).toBe(2100);
  });

  it("marks steps without a script as not run and keeps the outcome inconclusive", () => {
    const card = buildVerificationCard(
      {
        checks: [{ name: "verification", status: "inconclusive", details: "No typecheck/lint/test scripts found" }],
        ran: [],
        skipped: ["app:typecheck", "app:lint", "app:test"],
      },
      { iteration: 0 }
    );
    expect(card.outcome).toBe("inconclusive");
    expect(card.checks.every((c) => c.status === "not_run")).toBe(true);
    expect(card.checks.filter((c) => c.detail === "no script")).toHaveLength(3);
  });

  it("treats the 'no package.json' placeholder (recorded as passed upstream) as not run", () => {
    const card = buildVerificationCard(
      {
        checks: [{ name: "verification", status: "passed", details: "No package.json found for the changed files" }],
        ran: [],
        skipped: [],
      },
      { iteration: 0 }
    );
    expect(card.outcome).toBe("inconclusive");
    expect(card.checks[0].status).toBe("not_run");
  });

  it("passes counts through only when the runner printed them", () => {
    const card = buildVerificationCard(
      {
        checks: [{ name: "app:test", status: "passed", counts: { passed: 9, total: 9 } }],
        ran: ["app:test"],
        skipped: [],
      },
      { iteration: 0, steps: ["test"] }
    );
    expect(card.outcome).toBe("passed");
    expect(card.checks[0].counts).toEqual({ passed: 9, total: 9 });
  });
});

describe("parseTestCounts", () => {
  it("reads vitest, jest, node:test and mocha summaries", () => {
    expect(parseTestCounts(" Test Files  2 passed (2)\n      Tests  9 passed (9)")).toEqual({ passed: 9, total: 9 });
    expect(parseTestCounts("Tests  1 failed | 8 passed (9)")).toEqual({ passed: 8, total: 9 });
    expect(parseTestCounts("Tests:       2 skipped, 7 passed, 9 total")).toEqual({ passed: 7, total: 9 });
    expect(parseTestCounts("# tests 4\n# pass 4\n# fail 0")).toEqual({ passed: 4, total: 4 });
    expect(parseTestCounts("  5 passing (20ms)\n  1 failing")).toEqual({ passed: 5, total: 6 });
    expect(parseTestCounts("all good")).toBeUndefined();
  });
});

describe("QA checklist", () => {
  it("walks the viewports: settled rows, the next one running, pending ones not run at the end", () => {
    let rows = plannedQaRows(true);
    expect(rows.map((r) => [r.label, r.status])).toEqual([
      ["1440 px, desktop", "running"],
      ["768 px, tablet", "pending"],
      ["375 px, iPhone", "pending"],
    ]);
    rows = applyQaCheck(rows, { label: "application reachable", status: "passed", details: "http://localhost:3000" });
    expect(rows[0].status).toBe("running");
    rows = applyQaCheck(rows, { label: "desktop viewport", status: "passed" });
    expect(rows.map((r) => r.status)).toEqual(["passed", "running", "pending"]);
    rows = applyQaCheck(rows, { label: "tablet viewport", status: "failed", details: "Console errors: boom" });
    expect(rows.map((r) => r.status)).toEqual(["passed", "failed", "running"]);
    expect(rows[1].detail).toBe("Console errors: boom");

    const final = buildQaCard({
      outcome: "failed",
      iteration: 0,
      checks: [
        { label: "application reachable", status: "passed", details: "http://localhost:3000" },
        { label: "tablet viewport", status: "failed", details: "Console errors: boom" },
      ],
      rows,
    });
    expect(final.rows?.map((r) => r.status)).toEqual(["passed", "failed", "not_run"]);
    expect(final.urls).toEqual(["http://localhost:3000"]);
    expect(final.issues).toEqual(["tablet viewport: Console errors: boom"]);
  });

  it("structural mode has a single row", () => {
    const rows = applyQaCheck(plannedQaRows(false), { label: "structural check", status: "passed" });
    expect(rows).toEqual([{ label: "structural check", status: "passed" }]);
  });

  it("a running card keeps running rows", () => {
    const card = buildQaCard({ outcome: "running", iteration: 0, checks: [], rows: plannedQaRows(true) });
    expect(card.rows?.[0].status).toBe("running");
  });
});

describe("buildChangesCard", () => {
  it("summarises files with line counts", () => {
    const card = buildChangesCard(
      [
        { filePath: "site/lib/pricing.ts", changeType: "modified", diff: "--- a\n+++ b\n@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d" },
        { filePath: "site/app/Tier.tsx", changeType: "new", diff: "+x\n+y" },
      ],
      { subtaskKey: "impl" }
    );
    expect(card.files).toEqual([
      { path: "site/lib/pricing.ts", changeType: "modified", additions: 2, deletions: 1 },
      { path: "site/app/Tier.tsx", changeType: "new", additions: 2, deletions: 0 },
    ]);
    expect([card.additions, card.deletions]).toEqual([4, 1]);
  });
});

describe("postStageCard", () => {
  it("is best-effort: a failed post becomes a warn event, never a throw", async () => {
    const api = {
      postTaskCard: vi.fn(async () => {
        throw new Error("down");
      }),
      logEvent: vi.fn(async () => undefined),
    };
    await expect(
      postStageCard(api as any, { taskId: "t", projectId: "p", kind: "qa", data: buildQaCard({ outcome: "passed", iteration: 0, checks: [] }) })
    ).resolves.toBeUndefined();
    expect(api.logEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "card.post_failed", level: "warn" }));
  });

  it("tolerates a test fake without postTaskCard", async () => {
    await expect(
      postStageCard({ logEvent: async () => undefined } as any, {
        taskId: "t",
        projectId: "p",
        kind: "verification",
        data: buildVerificationCard({ checks: [], ran: [], skipped: [] }, { iteration: 0 }),
      })
    ).resolves.toBeUndefined();
  });
});
