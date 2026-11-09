import { describe, expect, test } from "vitest";
import {
  DAY_MS,
  aggregateWorkload,
  formatWorkloadTable,
  roleBucket,
  routeMatch,
  workloadSummary,
  type WorkloadInput,
  type WorkloadSubtaskInput,
} from "./workload";

const NOW = 1_800_000_000_000;
const daysAgo = (d: number) => NOW - d * DAY_MS;

const sub = (over: Partial<WorkloadSubtaskInput> & { key: string; role: string | null }): WorkloadSubtaskInput => ({
  taskId: "t1",
  kind: "code_change",
  status: "completed",
  at: daysAgo(1),
  ...over,
});

function input(over: Partial<WorkloadInput> = {}): WorkloadInput {
  return { now: NOW, sinceDays: 30, subtasks: [], executions: [], usage: [], routes: [], messages: [], ...over };
}

describe("aggregateWorkload", () => {
  test("shares of subtasks and tokens per role", () => {
    const r = aggregateWorkload(
      input({
        subtasks: [
          sub({ key: "a", role: "frontend" }),
          sub({ key: "b", role: "frontend" }),
          sub({ key: "c", role: "frontend", status: "failed" }),
          sub({ key: "d", role: "backend", status: "running" }),
          // Never assigned: not attributed to a role, not in the share base.
          sub({ key: "e", role: null, status: "pending" }),
        ],
        usage: [
          { role: "frontend", inputTokens: 600, outputTokens: 150, estimatedCost: 0.5, at: daysAgo(1) },
          { role: "Backend", inputTokens: 200, outputTokens: 50, at: daysAgo(1), estimated: true },
        ],
      })
    );
    const fe = r.rows.find((x) => x.key === "frontend")!;
    const be = r.rows.find((x) => x.key === "backend")!;
    expect(r.totals.subtasks).toBe(4);
    expect(r.totals.unassignedSubtasks).toBe(1);
    expect(fe.subtasks).toBe(3);
    expect(fe.subtaskShare).toBe(75);
    expect(fe.status).toMatchObject({ done: 2, failed: 1 });
    expect(be.status.running).toBe(1);
    expect(fe.tokens).toBe(750);
    expect(fe.tokenShare).toBe(75);
    expect(be.tokenShare).toBe(25);
    expect(fe.cost).toBe(0.5);
    expect(be.cost).toBeNull();
    expect(be.tokensEstimated).toBe(true);
    expect(r.totals.tokens).toBe(1000);
  });

  test("fallback routes are counted per role from subtask.routed, with inference for old events", () => {
    const r = aggregateWorkload(
      input({
        subtasks: [sub({ key: "api", role: "backend" }), sub({ key: "ui", role: "designer" }), sub({ key: "old", role: "frontend" })],
        routes: [
          { taskId: "t1", subtaskKey: "api", role: "backend", match: routeMatch({ match: "exact" }), at: daysAgo(1) },
          // Older event: no explicit match, agent lacks the capability → fallback.
          {
            taskId: "t1",
            subtaskKey: "ui",
            role: "designer",
            match: routeMatch({ capability: "frontend-development", capabilities: ["ui-ux-design"] }),
            at: daysAgo(1),
          },
          // Retried route of the same subtask counts as another route.
          { taskId: "t1", subtaskKey: "ui", role: "designer", match: "fallback", at: daysAgo(1) },
        ],
      })
    );
    expect(r.rows.find((x) => x.key === "backend")).toMatchObject({ routes: 1, fallbackRoutes: 0 });
    expect(r.rows.find((x) => x.key === "designer")).toMatchObject({ routes: 2, fallbackRoutes: 2 });
    expect(r.totals).toMatchObject({ routes: 3, fallbackRoutes: 2, subtasksWithoutRouteEvent: 1 });
    expect(routeMatch({ capability: "Backend Development", capabilities: ["backend-development"] })).toBe("exact");
  });

  test("zero-work roles line lists every fixed role with no subtasks", () => {
    const r = aggregateWorkload(
      input({
        subtasks: [
          sub({ key: "1", role: "frontend" }),
          sub({ key: "2", role: "frontend" }),
          sub({ key: "3", role: "frontend" }),
          sub({ key: "4", role: "backend" }),
          sub({ key: "5", role: "qa", kind: "qa" }),
          sub({ key: "6", role: "reviewer", kind: "review" }),
          sub({ key: "7", role: "devops" }),
          sub({ key: "8", role: "cto", kind: "analysis" }),
        ],
      })
    );
    expect(r.idleRoles).toEqual(["Designer", "Support", "Researcher"]);
    expect(r.summary).toBe("Frontend did 38% of subtasks; Designer, Support and Researcher did none in 30 days.");
    // Every fixed role is a row, idle ones with zeros.
    expect(r.rows.map((x) => x.key).slice(0, 9)).toEqual([
      "cto", "designer", "frontend", "backend", "qa", "support", "devops", "reviewer", "researcher",
    ]);
    expect(r.rows.find((x) => x.key === "support")).toMatchObject({ subtasks: 0, tokens: 0, subtaskShare: 0 });
  });

  test("summary handles no work, ties and full coverage", () => {
    expect(aggregateWorkload(input({ sinceDays: 7 })).summary).toBe("No subtasks ran in 7 days.");
    const tie = aggregateWorkload(input({ subtasks: [sub({ key: "a", role: "frontend" }), sub({ key: "b", role: "backend" })] }));
    expect(tie.summary).toMatch(/^Frontend and Backend each did 50% of subtasks; /);
    const all = aggregateWorkload(input()).rows.map((row) => ({ ...row, subtasks: 1 }));
    expect(workloadSummary(all, [], 90)).toBe("CTO, Designer, Frontend, Backend, QA, Support, DevOps, Reviewer and Researcher each did 11% of subtasks; every role had work in 90 days.");
  });

  test("window filter drops rows older than sinceDays across every source", () => {
    const base = {
      subtasks: [sub({ key: "new", role: "frontend", at: daysAgo(3) }), sub({ key: "old", role: "backend", at: daysAgo(20) })],
      executions: [
        { taskId: "t1", subtaskKey: "new", role: "frontend", status: "completed", startedAt: daysAgo(3), completedAt: daysAgo(3) + 60_000, at: daysAgo(3) },
        { taskId: "t1", subtaskKey: "old", role: "backend", status: "completed", startedAt: daysAgo(20), completedAt: daysAgo(20) + 1000, at: daysAgo(20) },
      ],
      usage: [
        { role: "frontend", inputTokens: 10, outputTokens: 0, at: daysAgo(3) },
        { role: "backend", inputTokens: 90, outputTokens: 0, at: daysAgo(20) },
      ],
      routes: [{ taskId: "t1", subtaskKey: "old", role: "backend", match: "fallback" as const, at: daysAgo(20) }],
      messages: [{ role: "backend", at: daysAgo(20) }, { role: "frontend", at: daysAgo(1) }],
    };
    const week = aggregateWorkload(input({ ...base, sinceDays: 7 }));
    expect(week.totals).toMatchObject({ subtasks: 1, tokens: 10, routes: 0, chatReplies: 1 });
    expect(week.rows.find((x) => x.key === "backend")).toMatchObject({ subtasks: 0, tokens: 0, timedRuns: 0, chatReplies: 0 });
    expect(week.idleRoles).toContain("Backend");
    const month = aggregateWorkload(input({ ...base, sinceDays: 30 }));
    expect(month.totals).toMatchObject({ subtasks: 2, tokens: 100, routes: 1, fallbackRoutes: 1, chatReplies: 2 });
    expect(month.rows.find((x) => x.key === "frontend")!.tokenShare).toBe(10);
  });

  test("durations, fix iterations, QA rounds, chat replies", () => {
    const r = aggregateWorkload(
      input({
        subtasks: [
          sub({ key: "ui", role: "frontend" }),
          sub({ key: "fix_qa_1", role: "frontend", origin: "fix" }),
          sub({ key: "review_fix_1", role: "frontend", origin: "review_fix" }),
          // Review re-run rows are persisted with origin review_fix too: not a fix.
          sub({ key: "review", role: "reviewer", kind: "review", origin: "review_fix" }),
          sub({ key: "qa", role: "qa", kind: "qa" }),
          // Legacy row without executions: its own timestamps count once.
          sub({ key: "legacy", role: "backend", startedAt: daysAgo(1), completedAt: daysAgo(1) + 4000 }),
        ],
        executions: [
          { taskId: "t1", subtaskKey: "ui", role: "frontend", status: "failed", startedAt: 0 + daysAgo(1), completedAt: daysAgo(1) + 1000, at: daysAgo(1) },
          { taskId: "t1", subtaskKey: "ui", role: "frontend", status: "completed", startedAt: daysAgo(1), completedAt: daysAgo(1) + 3000, at: daysAgo(1) },
          { taskId: "t1", subtaskKey: "fix_qa_1", role: "frontend", status: "completed", startedAt: daysAgo(1), completedAt: daysAgo(1) + 8000, at: daysAgo(1) },
          { taskId: "t1", subtaskKey: "qa", kind: "qa", role: "qa", status: "completed", startedAt: daysAgo(1), completedAt: daysAgo(1) + 500, at: daysAgo(1) },
          { taskId: "t1", subtaskKey: "qa", kind: "qa", role: "qa", status: "completed", at: daysAgo(1) },
        ],
        messages: [{ role: "cto", at: daysAgo(1) }, { role: "CTO", at: daysAgo(2) }, { role: null, at: daysAgo(1) }],
      })
    );
    const fe = r.rows.find((x) => x.key === "frontend")!;
    expect(fe).toMatchObject({ fixIterations: 2, timedRuns: 3, totalDurationMs: 12000, medianDurationMs: 3000, avgDurationMs: 4000 });
    expect(r.rows.find((x) => x.key === "reviewer")).toMatchObject({ fixIterations: 0, reviewRounds: 1 });
    expect(r.rows.find((x) => x.key === "qa")).toMatchObject({ qaRounds: 2 });
    expect(r.rows.find((x) => x.key === "backend")).toMatchObject({ timedRuns: 1, medianDurationMs: 4000 });
    expect(r.rows.find((x) => x.key === "cto")!.chatReplies).toBe(2);
    expect(r.rows.find((x) => x.key === "unattributed")!.chatReplies).toBe(1);
    expect(r.totals.chatReplies).toBe(3);
  });

  test("unrecognized stored roles keep their own row instead of folding into Frontend", () => {
    const r = aggregateWorkload(input({ subtasks: [sub({ key: "a", role: "Data Wizard" }), sub({ key: "b", role: "ui-ux" })] }));
    expect(roleBucket("Data Wizard")).toEqual({ key: "data-wizard", label: "Data Wizard", recognized: false });
    expect(roleBucket("Backend Developer").key).toBe("backend");
    expect(r.unrecognizedRoleSubtasks).toBe(1);
    expect(r.rows.find((x) => x.key === "data-wizard")).toMatchObject({ subtasks: 1, recognized: false });
    // Legacy ui-ux shows as its successor, Designer.
    expect(r.rows.find((x) => x.key === "designer")!.subtasks).toBe(1);
    expect(r.rows.find((x) => x.key === "frontend")!.subtasks).toBe(0);
    expect(formatWorkloadTable(r)).toContain("Data Wizard*");
  });
});
