import { describe, expect, it } from "vitest";
import { buildDecisionTray } from "@/api/convex/lib/decisionTray";
import { hasGap, highWater, mergeSequenced } from "@/api/convex/lib/eventResume";
import { holdNoticeText } from "@/api/convex/lib/providerHold";
import { buildReplaySteps } from "@/api/convex/lib/replay";
import { groupActivity } from "../../../apps/web/lib/activityGroups";
import { buildAll, type BuiltFixture } from "../../../scripts/fixtures/make-synthetic.mjs";

/**
 * Golden replay tests (T10): each fixture's event stream goes through the
 * pure reducers and selectors the thread UI uses, and the derived state is
 * snapshotted under tests/__golden__/<scenario>.json. A change to a
 * selector or a fixture shows up as a reviewable snapshot diff
 * (`npx vitest run tests/fixturesReplay.test.ts -u` to accept it).
 *
 *   events  → useSequencedEvents' merge (mergeSequenced / hasGap / highWater),
 *             fed out of order with duplicates, as a reconnecting tab sees them
 *   replay  → Run replay timeline (buildReplaySteps)
 *   tray    → Decisions tray (buildDecisionTray) from pending approvals and questions
 *   activity→ compact activity log (groupActivity) over the chat messages
 *   hold    → TaskHoldNotice line (holdNoticeText) at the scenario's "now"
 */
type Row = Record<string, unknown>;

/** "$ref:tasks/main" → "tasks/main": readable stand-in ids. */
function unref<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(/"\$ref:([^"]+)"/g, '"$1"')) as T;
}

/** Deterministic out-of-order delivery: windows of 4, reversed, each overlapping the previous by one. */
function deliveries<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += 3) out.push(rows.slice(Math.max(0, i - 1), i + 3).reverse());
  return out;
}

function derive(f: BuiltFixture) {
  const s = unref(f.scenario);
  const events = unref(f.events) as Row[];
  const rows = (table: string) => (s.rows[table] ?? []) as Row[];
  const keyOf = (table: string, row: Row) => `${table}/${String(row.fixtureKey)}`;
  const now = s.anchor;

  const streams: Record<string, unknown> = {};
  for (const table of ["taskEvents", "agentEvents"] as const) {
    const ordered = events
      .filter((e) => e.table === table)
      .map((e): Row & { _id: string; _creationTime: number; sequence: number } => ({ ...e, _id: `${table}:${String(e.taskId ?? e.conversationId)}:${String(e.sequence)}`, _creationTime: Number(e.createdAt), sequence: Number(e.sequence) }));
    if (ordered.length === 0) continue;
    let held: typeof ordered = [];
    const gaps: number[] = [];
    for (const window of deliveries(ordered)) {
      if (hasGap(highWater(held), window)) gaps.push(highWater(held));
      held = mergeSequenced(held, window);
    }
    // The client ends with exactly the ordered stream, whatever the arrival order.
    expect(held.map((e) => e._id)).toEqual(ordered.map((e) => e._id));
    streams[table] = { count: held.length, highWater: highWater(held), gapsSeen: gaps, types: held.map((e) => e.type) };
  }

  const tasks = rows("tasks").map((task) => {
    const key = keyOf("tasks", task);
    const taskEvents = events.filter((e) => e.table === "taskEvents" && e.taskId === key);
    const replay = buildReplaySteps({
      task: { command: String(task.command), createdAt: Number(task.startedAt ?? s.base), status: String(task.status), errorMessage: task.errorMessage as string | undefined, endedAt: (task.completedAt as number | undefined) ?? null },
      events: taskEvents.map((e) => ({ _id: String(e.sequence), type: String(e.type), at: Number(e.createdAt), sequence: Number(e.sequence), subtaskKey: e.subtaskKey as string | undefined, level: e.level as "info" | "warn" | "error" | undefined, message: e.message as string | undefined, payload: e.payload })),
      snapshots: [],
    });
    const hold = task.hold as { reason: string; resumeAt: number; kind: "offline" | "rate_limit" | "quota" | "auth" } | undefined;
    return {
      key,
      status: task.status,
      mode: task.mode ?? "orchestrated",
      replay: { failureIndex: replay.failureIndex, steps: replay.steps.map((st) => `${st.kind}${st.failed ? "!" : ""} ${st.label}${st.subtaskKey ? ` [${st.subtaskKey}]` : ""}`) },
      ...(hold ? { holdNotice: holdNoticeText(hold, now) } : {}),
    };
  });

  const titleOf = new Map(rows("tasks").map((t) => [keyOf("tasks", t), String(t.title)]));
  const tray = buildDecisionTray({
    approvals: rows("approvals")
      .filter((a) => a.status === "pending")
      .map((a, i) => ({ _id: keyOf("approvals", a), _creationTime: s.base + i, kind: String(a.kind), summary: String(a.summary), taskId: String(a.taskId), payload: a.payload, offerAlways: a.offerAlways as boolean | undefined, taskTitle: titleOf.get(String(a.taskId)) ?? null })),
    questions: rows("tasks")
      .filter((t) => t.status === "waiting_input" && t.pendingQuestion)
      .map((t) => ({ taskId: keyOf("tasks", t), title: String(t.title), question: String(t.pendingQuestion), options: t.pendingOptions as string[] | undefined, at: Number(t.updatedAt ?? s.base) })),
  }).map((item) => ({ kind: item.kind, title: item.title, code: item.code, actions: item.actions.map((a) => a.id), composerMode: item.composerMode }));

  const messages = rows("messages").map((m) => ({ ...m, _id: keyOf("messages", m) }));
  const activity = groupActivity(messages as Parameters<typeof groupActivity>[0], { agentLabel: (id) => id?.replace(/^agents\//, "") }).map((g) => ({ messages: g.messageIds.length, summary: g.summary, failed: g.failed, expanded: g.expandedByDefault }));

  return { scenario: s.id, title: s.title, streams, tasks, tray, activity, messages: messages.length };
}

describe("fixture replay through the UI selectors (golden)", () => {
  for (const f of buildAll()) {
    it(f.scenario.id, async () => {
      await expect(JSON.stringify(derive(f), null, 2) + "\n").toMatchFileSnapshot(`__golden__/${f.scenario.id}.json`);
    });
  }

  it("the scenarios exercise what they claim", () => {
    const d = Object.fromEntries(buildAll().map((f) => [f.scenario.id, derive(f)]));
    expect(d["command-approval"].tray.map((i) => i.kind)).toEqual(["command"]);
    expect(d["verify-loop-failed"].tasks[0].replay.failureIndex).toBeGreaterThan(0);
    expect(d["verify-loop-failed"].activity.some((g) => g.failed && g.expanded)).toBe(true);
    expect(d["held-resume"].tasks[0].holdNotice).toMatch(/^On hold: .*Retrying automatically in 3 min\.$/);
    expect(d["research-fanout"].tasks[0].replay.steps.some((s) => s.startsWith("subtask! subtask.failed [ra-2]"))).toBe(true);
    expect(d["planned-push"].tasks[0].replay.failureIndex).toBe(-1);
  });
});
