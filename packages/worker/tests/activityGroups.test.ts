import { describe, expect, it } from "vitest";
// The web app has no unit-test runner; its pure modules are tested here.
import {
  activityItemOf,
  groupActivity,
  groupByIndex,
  summarizeActivity,
  type ActivityMessageLike,
} from "../../../apps/web/lib/activityGroups";

let seq = 0;
const msg = (partial: Partial<ActivityMessageLike>): ActivityMessageLike => ({
  _id: `m${++seq}`,
  authorType: "agent",
  agentId: "frontend",
  taskId: "t1",
  content: "",
  ...partial,
});
const changes = (files: number, agentId = "frontend") =>
  msg({ agentId, card: { kind: "changes", data: { files: Array.from({ length: files }, (_, i) => ({ path: `f${i}.ts` })) } } });
const verification = (checks: Array<[string, string]>, outcome = "passed", agentId = "frontend") =>
  msg({
    agentId,
    card: { kind: "verification", data: { outcome, checks: checks.map(([name, status]) => ({ name, status })) } },
  });

describe("activityItemOf", () => {
  it("classifies cards and handoffs; normal replies and push cards are not activity", () => {
    expect(activityItemOf(changes(2))?.category).toBe("edit");
    expect(activityItemOf(verification([["lint", "passed"]]))?.category).toBe("check");
    expect(activityItemOf(msg({ card: { kind: "qa", data: { outcome: "failed" } } }))?.failed).toBe(true);
    expect(activityItemOf(msg({ content: "Delegation: CTO → Backend (api): add route" }))?.category).toBe("delegate");
    expect(activityItemOf(msg({ content: "@reviewer please look" }))?.category).toBe("delegate");
    expect(activityItemOf(msg({ content: "Read 3 files" }))?.category).toBe("read");
    expect(activityItemOf(msg({ content: "Here is what I changed and why." }))).toBeNull();
    expect(activityItemOf(msg({ card: { kind: "push", data: { pushId: "p" } } }))).toBeNull();
    expect(activityItemOf(msg({ authorType: "user", card: { kind: "changes", data: { files: [] } } }))).toBeNull();
  });

  it("does not count not-run steps, and keeps failed checks out of successes", () => {
    const item = activityItemOf(verification([["typecheck", "passed"], ["lint", "failed"], ["test", "not_run"]], "failed"))!;
    expect(item.checks?.map((c) => c.name)).toEqual(["typecheck", "lint"]);
    expect(item.failed).toBe(true);
  });
});

describe("summarizeActivity", () => {
  it("puts file changes first, then checks, and names a failed check", () => {
    const items = [verification([["typecheck", "passed"], ["lint", "failed"], ["build", "passed"]], "failed"), changes(2)].map(
      (m) => activityItemOf(m)!
    );
    expect(summarizeActivity(items, "Frontend")).toBe("Frontend · Edited 2 files, ran typecheck/lint/build (failed lint)");
  });

  it("shows at most two categories plus +N more", () => {
    const items = [
      changes(1),
      verification([["lint", "passed"]]),
      msg({ content: "Delegation: CTO → QA (qa): check" }),
      msg({ content: "Read 2 files" }),
    ].map((m) => activityItemOf(m)!);
    expect(summarizeActivity(items)).toBe("Edited 1 file, ran lint +2 more");
  });

  it("counts repeated runs instead of naming duplicates", () => {
    const items = [verification([["lint", "failed"]], "failed"), verification([["lint", "passed"]])].map((m) => activityItemOf(m)!);
    expect(summarizeActivity(items)).toBe("Ran 2 checks (failed lint)");
  });
});

describe("groupActivity", () => {
  it("groups consecutive activity from one agent and leaves single cards alone", () => {
    const list = [
      msg({ authorType: "user", agentId: undefined, content: "do it" }),
      changes(2),
      verification([["lint", "passed"]]),
      msg({ content: "All done, here is the summary." }),
      changes(1),
    ];
    const groups = groupActivity(list, { agentLabel: () => "Frontend" });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ start: 1, end: 2, failed: false, expandedByDefault: false });
    expect(groups[0].summary).toBe("Frontend · Edited 2 files, ran lint");
    expect(groupByIndex(groups).get(2)?.id).toBe(groups[0].id);
    expect(groupByIndex(groups).has(4)).toBe(false);
  });

  it("splits on a different agent or block", () => {
    const list = [changes(1, "frontend"), changes(1, "backend"), changes(1, "backend"), { ...changes(1, "backend"), taskId: "t2" }];
    const groups = groupActivity(list);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ start: 1, end: 2, agentId: "backend" });
  });

  it("only the latest failing group starts expanded", () => {
    const list = [
      verification([["lint", "failed"]], "failed"),
      changes(1),
      msg({ content: "between" }),
      verification([["test", "failed"]], "failed"),
      changes(1),
      msg({ content: "between" }),
      changes(1),
      verification([["test", "passed"]]),
    ];
    const groups = groupActivity(list);
    expect(groups.map((g) => [g.failed, g.expandedByDefault])).toEqual([
      [true, false],
      [true, true],
      [false, false],
    ]);
  });
});
