import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunBundleJson, buildRunBundleMarkdown } from "../../lib/runExport.ts";

const run = (title) => ({
  task: {
    _id: `task-${title}`,
    title,
    projectName: "Demo",
    status: "done",
    phase: null,
    branchName: null,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_060_000,
    errorMessage: null,
    command: null,
  },
  totals: {
    durationMs: 60_000,
    inputTokens: 10,
    outputTokens: 5,
    calls: 1,
    estimatedCost: 0.01,
    byModel: {},
    byAgent: [],
    unattributed: null,
  },
  steps: [{ type: "plan", title: "Plan", status: "done", role: "cto", plans: [], detail: "Plan detail" }],
  events: [],
  handoffs: [],
  edges: [],
  eventsTruncated: false,
});

const opts = { exportedAt: Date.UTC(2026, 0, 2, 3, 4, 5), appVersion: "1.0.0" };

test("JSON bundle keeps every full trace in order with export metadata", () => {
  const doc = JSON.parse(buildRunBundleJson([run("first"), run("second")], { ...opts, projectId: "p1" }));
  assert.equal(doc.exportedAt, "2026-01-02T03:04:05.000Z");
  assert.equal(doc.appVersion, "1.0.0");
  assert.equal(doc.projectId, "p1");
  assert.equal(doc.count, 2);
  assert.deepEqual(doc.runs.map((r) => r.task.title), ["first", "second"]);
  assert.equal(doc.runs[0].steps[0].detail, "Plan detail");
  const bare = JSON.parse(buildRunBundleJson([run("x")], { exportedAt: opts.exportedAt }));
  assert.equal("projectId" in bare, false);
  assert.equal("appVersion" in bare, false);
});

test("Markdown bundle joins whole run reports, not just row summaries", () => {
  const md = buildRunBundleMarkdown([run("first"), run("second")], opts);
  assert.equal(md.includes("# Run report: first"), true);
  assert.equal(md.includes("# Run report: second"), true);
  assert.equal(md.includes("## Plan"), true);
  assert.equal(md.includes("## Timeline (1 steps)"), true);
  assert.equal(md.split("\n\n---\n\n").length, 2);
});
