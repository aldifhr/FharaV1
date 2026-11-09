/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  SNAPSHOT_SECTION_CAP,
  SNAPSHOT_TOTAL_CAP,
  buildContextSnapshot,
  capSections,
  capText,
  contextSnapshotsEnabled,
  redactSecrets,
  retentionCutoff,
  retentionDays,
  sectionShares,
  sectionsToMessages,
  splitPromptSections,
} from "./lib/contextSnapshot";
import { buildReplaySteps, diffRuns, lineDiff, type RunSide } from "./lib/replay";

const modules = import.meta.glob("./**/*.ts");

describe("redaction", () => {
  test("masks provider keys, tokens, private keys and key=value secrets anywhere in text", () => {
    const text = [
      "use sk-ant-abcdefghijklmnop1234 for the call",
      "token ghp_abcdefghijklmnopqrstuvwxyz0123",
      "github_pat_11ABCDEFG0123456789_abcdefghijk",
      "AKIAABCDEFGHIJKLMNOP is aws",
      'config {"apiKey": "plain-secret-value", "name": "ok"}',
      "LLM_API_KEY=hunter2hunter2",
      "Authorization: Bearer abcdefghijklmnopqrstu",
      "-----BEGIN PRIVATE KEY-----\nMIIBVwIBADANBg\n-----END PRIVATE KEY-----",
    ].join("\n");
    const out = redactSecrets(text);
    expect(out).not.toMatch(/sk-ant-abcdefghijklmnop1234/);
    expect(out).not.toMatch(/ghp_abcdefghijklmnop/);
    expect(out).not.toMatch(/github_pat_11ABC/);
    expect(out).not.toMatch(/AKIAABCDEFGHIJKLMNOP/);
    expect(out).not.toMatch(/plain-secret-value/);
    expect(out).not.toMatch(/hunter2hunter2/);
    expect(out).not.toMatch(/abcdefghijklmnopqrstu/);
    expect(out).not.toMatch(/MIIBVwIBADANBg/);
    // Non-secret text survives, and redaction is idempotent.
    expect(out).toContain('"name": "ok"');
    expect(redactSecrets(out)).toBe(out);
  });

  test("a built snapshot never carries the secret in sections, response or error", () => {
    const { body, meta } = buildContextSnapshot({
      callRole: "executor",
      messages: [
        { role: "system", content: "You are QA. key sk-proj-ABCDEFGHIJKLMNOPQRST" },
        { role: "user", content: "password: swordfish99" },
      ],
      response: "here ghp_abcdefghijklmnopqrstuvwxyz0123",
      error: "failed with Bearer abcdefghijklmnopqrstuvwxyz",
    });
    const all = JSON.stringify({ body, meta });
    expect(all).not.toMatch(/ABCDEFGHIJKLMNOPQRST|swordfish99|ghp_abcdef|abcdefghijklmnopqrstuvwxyz/);
  });
});

describe("caps", () => {
  test("capText keeps the head and ends with a truncation marker within the cap", () => {
    const capped = capText("x".repeat(10_000), 1_000);
    expect(capped.text.length).toBeLessThanOrEqual(1_000);
    expect(capped.text).toMatch(/…\[truncated [\d,]+ chars\]$/);
    expect(capped.truncatedChars).toBeGreaterThan(9_000);
    expect(capText("short", 100)).toEqual({ text: "short", truncatedChars: 0 });
  });

  test("capSections enforces per-section and total caps; small sections stay whole", () => {
    const sections = capSections([
      { key: "system", label: "System persona", content: "persona" },
      { key: "task", label: "Task", content: "t".repeat(200_000) },
      { key: "history", label: "History", content: "h".repeat(50_000) },
      { key: "user", label: "User", content: "u".repeat(40_000) },
    ]);
    const total = sections.reduce((n, s) => n + s.content.length, 0);
    expect(total).toBeLessThanOrEqual(SNAPSHOT_TOTAL_CAP);
    for (const s of sections) expect(s.content.length).toBeLessThanOrEqual(SNAPSHOT_SECTION_CAP);
    expect(sections[0].content).toBe("persona");
    expect(sections[1].truncatedChars).toBeGreaterThan(0);
    expect(sections[1].content).toMatch(/truncated/);
  });

  test("the snapshot's stats keep the full token estimate while the body is capped", () => {
    const { meta, body } = buildContextSnapshot({
      callRole: "planner",
      messages: [{ role: "user", content: "a".repeat(400_000) }],
      response: "r".repeat(100_000),
    });
    expect(meta.sectionStats[0].tokens).toBe(100_000);
    expect(meta.sectionStats[0].truncated).toBe(true);
    expect(meta.truncated).toBe(true);
    expect(body.response.length).toBeLessThanOrEqual(16 * 1024);
    expect(meta.bytes).toBeLessThanOrEqual(SNAPSHOT_TOTAL_CAP + 16 * 1024);
  });
});

describe("section split", () => {
  test("system persona, shared instructions, skills, memory, tools, history, task context and user message", () => {
    const sections = splitPromptSections([
      {
        role: "system",
        content: [
          "You are the Frontend developer.",
          "## Working rules\nKeep diffs small.",
          "## Skill: tailwind\nUse tokens.",
          "## Skill: testing\nWrite tests.",
          "## Memory\nStanding notes.\n- prefer pnpm",
          "## Repo tools (read-only)\nTools:\n- grep {\"pattern\": regex}\n- read_file {\"path\": file}",
        ].join("\n\n"),
      },
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
      {
        role: "user",
        content: "Shared task context:\nGoal: ship pricing\n- fe-1 done\n\nContract for this subtask:\n- Objective: page\n\nBuild the pricing page now.",
      },
    ]);
    const by = Object.fromEntries(sections.map((s) => [s.key, s.content]));
    expect(by.system).toBe("You are the Frontend developer.");
    expect(by.shared).toContain("Keep diffs small.");
    expect(by.skills).toContain("## Skill: tailwind");
    expect(by.skills).toContain("## Skill: testing");
    expect(by.memory).toContain("prefer pnpm");
    expect(by.tools).toContain("read_file");
    expect(by.history).toContain("[assistant] earlier answer");
    expect(by.task).toContain("Goal: ship pricing");
    expect(by.task).toContain("Contract for this subtask:");
    expect(by.user).toBe("Build the pricing page now.");
    // Ordered by the canonical section order.
    expect(sections.map((s) => s.key)).toEqual(["system", "shared", "skills", "memory", "history", "tools", "task", "user"]);
  });

  test("headings inside a skill body stay under Skills (not Shared instructions)", () => {
    const sections = splitPromptSections([
      {
        role: "system",
        content: [
          "You are the Backend developer.",
          "## Working rules\nKeep diffs small.",
          "## Skill: release-checklist\nFollow these steps.",
          "## Steps\n1. Bump the version.\n2. Tag.",
          "### Tools you may use\nnpm, git.",
          "## Task hygiene\nOne commit per change.",
          "## Skill: testing\nWrite tests.",
          "## Notes\nPrefer vitest.",
          "## Memory\nStanding notes.\n- prefer pnpm",
          "## Repo tools (read-only)\nTools:\n- grep {\"pattern\": regex}",
        ].join("\n\n"),
      },
      { role: "user", content: "Do it." },
    ]);
    const by = Object.fromEntries(sections.map((s) => [s.key, s.content]));
    expect(by.shared).toBe("## Working rules\nKeep diffs small.");
    for (const text of ["Bump the version.", "Tools you may use", "One commit per change.", "Prefer vitest."]) {
      expect(by.skills).toContain(text);
      expect(by.shared).not.toContain(text);
    }
    expect(by.task ?? "").not.toContain("One commit per change.");
    expect(by.memory).toContain("prefer pnpm");
    expect(by.memory).not.toContain("Prefer vitest.");
    expect(by.tools).toContain("grep");
  });

  test("the on-demand skill index counts as Skills", () => {
    const sections = splitPromptSections([
      { role: "system", content: "Persona.\n\n## Skills (load on demand)\n- tailwind: styling\n\n## Usage\nCall load_skill." },
      { role: "user", content: "hi" },
    ]);
    const by = Object.fromEntries(sections.map((s) => [s.key, s.content]));
    expect(by.skills).toContain("tailwind: styling");
    expect(by.skills).toContain("Call load_skill.");
    expect(by.shared).toBeUndefined();
  });

  test("snapshot meta lists skills, tools, memory and history; shares sum to ~100", () => {
    const { meta } = buildContextSnapshot({
      callRole: "chat",
      messages: [
        { role: "system", content: "Persona\n\n## Skill: deploy\nsteps\n\n## Memory\nnotes\n\n## Repo tools (read-only)\n- grep {\"pattern\": x}" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "what now?" },
      ],
    });
    expect(meta.skillNames).toEqual(["deploy"]);
    expect(meta.toolNames).toContain("grep");
    expect(meta.memoryIncluded).toBe(true);
    expect(meta.historyMessages).toBe(2);
    const shares = sectionShares(meta.sectionStats);
    const sum = shares.reduce((n, s) => n + s.share, 0);
    expect(sum).toBeGreaterThan(99);
    expect(sum).toBeLessThan(101);
  });

  test("sectionsToMessages leaves tool definitions out unless enabled", () => {
    const sections = [
      { key: "system" as const, content: "P" },
      { key: "tools" as const, content: "TOOLS" },
      { key: "user" as const, content: "Q" },
    ];
    expect(sectionsToMessages(sections).system).not.toContain("TOOLS");
    expect(sectionsToMessages(sections, { toolsEnabled: true }).system).toContain("TOOLS");
    expect(sectionsToMessages(sections).messages.at(-1)).toEqual({ role: "user", content: "Q" });
  });
});

describe("kill switch and retention", () => {
  test("CONTEXT_SNAPSHOTS=0 disables; anything else enables", () => {
    expect(contextSnapshotsEnabled({ CONTEXT_SNAPSHOTS: "0" })).toBe(false);
    expect(contextSnapshotsEnabled({ CONTEXT_SNAPSHOTS: "off" })).toBe(false);
    expect(contextSnapshotsEnabled({})).toBe(true);
    expect(contextSnapshotsEnabled({ CONTEXT_SNAPSHOTS: "1" })).toBe(true);
  });

  test("retention defaults to 14 days and clamps", () => {
    expect(retentionDays(undefined)).toBe(14);
    expect(retentionDays(0)).toBe(14);
    expect(retentionDays(3.7)).toBe(3);
    expect(retentionDays(9999)).toBe(365);
    expect(retentionCutoff(100 * 86_400_000, undefined)).toBe(86 * 86_400_000);
  });
});

function snapshotArgs(projectId: any, extra: Record<string, unknown> = {}) {
  const { meta, body } = buildContextSnapshot({
    callRole: "executor",
    messages: [{ role: "system", content: "P sk-ant-abcdefghijklmnop1234" }, { role: "user", content: "do it" }],
    response: "ok",
    model: "m1",
    inputTokens: 10,
    outputTokens: 2,
  });
  return { projectId, source: "worker" as const, meta, body, ...extra };
}

describe("storage, retention prune and the kill switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test("record stores a light row plus a separate body; get joins them; secrets re-redacted", async () => {
    const t = convexTest(schema, modules);
    const { projectId, taskId } = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" });
      const taskId = await ctx.db.insert("tasks", { projectId, title: "T", command: "c", status: "running" });
      return { projectId, taskId };
    });
    // Worker records without projectId: derived from the task.
    const args = snapshotArgs(undefined, { taskId, subtaskKey: "fe-1" });
    args.body.sections[0].content += " LLM_API_KEY=plaintextsecret";
    const id = await t.mutation(internal.contextSnapshots.record, args);
    expect(id).not.toBeNull();
    const list = await t.query(api.contextSnapshots.forTask, { taskId });
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("sections");
    const full = await t.query(api.contextSnapshots.get, { snapshotId: id! });
    expect(full?.projectId).toBe(projectId);
    expect(JSON.stringify(full)).not.toMatch(/plaintextsecret|abcdefghijklmnop1234/);
    expect(full?.sections.map((s) => s.key)).toEqual(["system", "user"]);
  });

  test("CONTEXT_SNAPSHOTS=0 records nothing", async () => {
    vi.stubEnv("CONTEXT_SNAPSHOTS", "0");
    const t = convexTest(schema, modules);
    const projectId = await t.run((ctx) => ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" }));
    const id = await t.mutation(internal.contextSnapshots.record, snapshotArgs(projectId));
    expect(id).toBeNull();
    const rows = await t.run((ctx) => ctx.db.query("contextSnapshots").collect());
    expect(rows).toHaveLength(0);
  });

  test("prune deletes rows (and bodies) past each project's retention only", async () => {
    const t = convexTest(schema, modules);
    const day = 86_400_000;
    const now = 1_800_000_000_000;
    const { short, long } = await t.run(async (ctx) => {
      const short = await ctx.db.insert("projects", { name: "S", workspacePath: "/tmp/s", contextSnapshotRetentionDays: 2 });
      const long = await ctx.db.insert("projects", { name: "L", workspacePath: "/tmp/l" });
      return { short, long };
    });
    for (const projectId of [short, long]) {
      for (const age of [1, 5, 20]) {
        const id = await t.mutation(internal.contextSnapshots.record, snapshotArgs(projectId));
        await t.run((ctx) => ctx.db.patch(id!, { createdAt: now - age * day }));
      }
    }
    const result = await t.mutation(internal.contextSnapshots.prune, { now });
    // short (2 days): drops 5d and 20d; long (default 14): drops 20d.
    expect(result.deleted).toBe(3);
    const left = await t.run(async (ctx) => {
      const rows = await ctx.db.query("contextSnapshots").collect();
      const bodies = await ctx.db.query("contextSnapshotBodies").collect();
      return { rows, bodies };
    });
    expect(left.rows).toHaveLength(3);
    expect(left.bodies).toHaveLength(3);
    const ages = left.rows.map((r) => `${r.projectId === short ? "S" : "L"}${Math.round((now - r.createdAt) / day)}`).sort();
    expect(ages).toEqual(["L1", "L5", "S1"]);
  });

  test("setRetention clamps and audits", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run((ctx) => ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p" }));
    expect(await t.mutation(api.contextSnapshots.setRetention, { projectId, days: 5000 })).toBe(365);
    const audit = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(audit.some((a) => a.action === "project.context_snapshot_retention")).toBe(true);
  });
});

describe("replay step building", () => {
  test("orders instruction, classification, plan, routing, LLM calls, QA and marks the first failure", () => {
    const { steps, failureIndex } = buildReplaySteps({
      task: { command: "Build pricing", createdAt: 0, status: "failed", errorMessage: "QA failed" },
      events: [
        { _id: "e1", type: "task.classified", at: 10, sequence: 1 },
        { _id: "e2", type: "plan.created", at: 20, sequence: 2 },
        { _id: "e3", type: "subtask.routed", at: 30, sequence: 3, subtaskKey: "fe-1" },
        { _id: "e4", type: "subtask.chunk", at: 35, sequence: 4 },
        { _id: "e5", type: "qa.failed", at: 60, sequence: 5, subtaskKey: "qa-1", message: "button missing" },
        { _id: "e6", type: "task.failed", at: 70, sequence: 6, level: "error" },
      ],
      snapshots: [
        { _id: "s0", at: 15, callRole: "planner", model: "m" },
        { _id: "s1", at: 40, callRole: "executor", subtaskKey: "fe-1", agentRole: "frontend" },
        { _id: "s2", at: 50, callRole: "qa", subtaskKey: "qa-1" },
      ],
    });
    expect(steps.map((s) => s.kind)).toEqual([
      "instruction",
      "classification",
      "llm",
      "plan",
      "routing",
      "llm",
      "llm",
      "qa",
      "result",
    ]);
    expect(steps.some((s) => s.eventType === "subtask.chunk")).toBe(false);
    expect(steps[failureIndex].eventType).toBe("qa.failed");
    expect(steps[2].snapshotId).toBe("s0");
  });

  test("a failed task with no failing event gets a synthetic failure step", () => {
    const { steps, failureIndex } = buildReplaySteps({
      task: { command: "x", createdAt: 0, status: "failed", errorMessage: "boom", endedAt: 9 },
      events: [],
      snapshots: [],
    });
    expect(steps[failureIndex]).toMatchObject({ kind: "result", failed: true, detail: "boom" });
  });

  test("a failed LLM call is the failure point", () => {
    const { steps, failureIndex } = buildReplaySteps({
      task: { command: "x", createdAt: 0, status: "failed" },
      events: [],
      snapshots: [{ _id: "s1", at: 5, callRole: "executor", error: "429 rate limited" }],
    });
    expect(steps[failureIndex].snapshotId).toBe("s1");
  });
});

describe("run diff", () => {
  const side = (over: Partial<RunSide>): RunSide => ({
    label: "A",
    status: "done",
    plan: [{ key: "fe-1", title: "Build UI", capability: "frontend" }],
    routed: [{ subtaskKey: "fe-1", agentRole: "Frontend" }],
    calls: [
      {
        snapshotId: "a1",
        callRole: "executor",
        subtaskKey: "fe-1",
        sections: [
          { key: "system", tokens: 5, content: "persona" },
          { key: "user", tokens: 3, content: "build" },
        ],
        response: "done",
      },
    ],
    ...over,
  });

  test("marks same, changed and one-sided rows across plan, routing, prompts, outputs and errors", () => {
    const a = side({});
    const b = side({
      status: "failed",
      errorMessage: "boom",
      plan: [
        { key: "fe-1", title: "Build UI", capability: "frontend" },
        { key: "qa-1", title: "Test UI", capability: "qa" },
      ],
      routed: [{ subtaskKey: "fe-1", agentRole: "Backend" }],
      calls: [
        {
          snapshotId: "b1",
          callRole: "executor",
          subtaskKey: "fe-1",
          sections: [
            { key: "system", tokens: 5, content: "persona" },
            { key: "user", tokens: 4, content: "build it" },
            { key: "memory", tokens: 2, content: "notes" },
          ],
          response: "failed",
          error: "429",
        },
      ],
    });
    const rows = diffRuns(a, b);
    const find = (group: string, key: string) => rows.find((r) => r.group === group && r.key === key);
    expect(find("plan", "#1")?.mark).toBe("same");
    expect(find("plan", "#2")?.mark).toBe("only_b");
    expect(find("routing", "#1")?.mark).toBe("changed");
    expect(find("prompt", "executor:fe-1#1 · system")?.mark).toBe("same");
    expect(find("prompt", "executor:fe-1#1 · user")?.mark).toBe("changed");
    expect(find("prompt", "executor:fe-1#1 · memory")?.mark).toBe("only_b");
    expect(find("output", "executor:fe-1#1")?.mark).toBe("changed");
    expect(find("error", "executor:fe-1#1")?.mark).toBe("only_b");
    expect(find("error", "task")?.mark).toBe("only_b");
  });

  test("lineDiff marks removed and added lines", () => {
    expect(lineDiff("a\nb\nc", "a\nc\nd")).toEqual([
      { op: "=", text: "a" },
      { op: "-", text: "b" },
      { op: "=", text: "c" },
      { op: "+", text: "d" },
    ]);
  });
});
