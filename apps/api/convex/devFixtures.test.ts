/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import {
  checkScenario,
  FIXTURE_EVENT_TABLES,
  FIXTURE_TABLES,
  fixtureShift,
  fixturesAllowed,
  resolveRefs,
  shiftTimes,
  type FixtureEvent,
  type FixtureScenario,
} from "./lib/devFixtures";
import { DIRECT_EVENT_TYPES } from "./lib/directThreads";

const modules = import.meta.glob("./**/*.ts");

// The committed fixtures (scripts/fixtures/make-synthetic.mjs). Every one is
// seeded below through the real schema, so a fixture that drifts from the
// validators fails here.
const scenarioFiles = import.meta.glob("../../../fixtures/scenarios/*/scenario.json", { eager: true, import: "default" }) as Record<string, FixtureScenario>;
const eventFiles = import.meta.glob("../../../fixtures/scenarios/*/events.ndjson", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;

const fixtures = Object.entries(scenarioFiles).map(([file, scenario]) => {
  const raw = eventFiles[file.replace(/scenario\.json$/, "events.ndjson")] ?? "";
  const events = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as FixtureEvent);
  return { scenario, events };
});
const byId = (id: string) => fixtures.find((f) => f.scenario.id === id)!;

const NOW = Date.UTC(2026, 10, 11, 0, 0, 0);
const ALL_TABLES = [...FIXTURE_TABLES, ...FIXTURE_EVENT_TABLES] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

function allowed() {
  vi.stubEnv("FHARA_FIXTURES", "1");
  return convexTest(schema, modules);
}

async function dump(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const out: Record<string, Array<Record<string, unknown>>> = {};
    for (const table of ALL_TABLES) out[table] = (await ctx.db.query(table).collect()) as Array<Record<string, unknown>>;
    out.devFixtureRows = (await ctx.db.query("devFixtureRows").collect()) as Array<Record<string, unknown>>;
    return out;
  });
}

describe("committed fixtures", () => {
  test("the expected scenarios exist", () => {
    expect(fixtures.map((f) => f.scenario.id).sort()).toEqual(
      ["command-approval", "direct-idle", "held-resume", "personal-chat", "planned-push", "research-fanout", "verify-loop-failed"].sort()
    );
  });

  test.each(fixtures.map((f) => [f.scenario.id, f] as const))("%s passes the structural check", (_id, f) => {
    expect(checkScenario(f.scenario, f.events)).toEqual([]);
  });

  test.each(fixtures.map((f) => [f.scenario.id, f] as const))("%s seeds through the real schema with every ref resolved", async (_id, f) => {
    const t = allowed();
    const res = await t.mutation(internal.devFixtures.seed, { scenario: f.scenario, events: f.events, now: NOW });
    expect(res.events).toBe(f.events.length);
    const rows = await dump(t);
    expect(JSON.stringify(rows)).not.toContain("$ref:");
    // Every non-reused row is registered for the wipe.
    const seeded = ALL_TABLES.reduce((n, table) => n + rows[table].length, 0);
    expect(rows.devFixtureRows).toHaveLength(seeded);
    // Times are shifted onto "now": nothing still sits at the generator's BASE.
    for (const task of rows.tasks) expect(Math.abs(Number(task.updatedAt ?? NOW) - NOW)).toBeLessThan(2 * 60 * 60_000);
    // Each task's eventSequence is the stream's high-water mark (later appends continue it).
    for (const task of rows.tasks) {
      const seqs = rows.taskEvents.filter((e) => e.taskId === task._id).map((e) => Number(e.sequence));
      expect(task.eventSequence ?? 0).toBe(seqs.length ? Math.max(...seqs) : 0);
    }
  });

  test("direct-idle uses only direct thread event types and lastSeq is the last event", async () => {
    const f = byId("direct-idle");
    const types = new Set(f.events.map((e) => String(e.type)));
    for (const type of types) expect(type === "thread.created" || (DIRECT_EVENT_TYPES as readonly string[]).includes(type)).toBe(true);
    const t = allowed();
    await t.mutation(internal.devFixtures.seed, { scenario: f.scenario, events: f.events, now: NOW });
    const [task] = (await dump(t)).tasks;
    expect(task.mode).toBe("direct");
    expect((task.direct as { lastSeq: number }).lastSeq).toBe(f.events.length);
  });

  test("held-resume: resumeAt is in the future after the shift", async () => {
    const f = byId("held-resume");
    const t = allowed();
    await t.mutation(internal.devFixtures.seed, { scenario: f.scenario, events: f.events, now: NOW });
    const [task] = (await dump(t)).tasks;
    expect(task.pausedBy).toBe("held");
    expect((task.hold as { resumeAt: number }).resumeAt).toBeGreaterThan(NOW);
  });
});

describe("seed and wipe", () => {
  test("re-seeding replaces the scenario instead of duplicating it", async () => {
    const f = byId("planned-push");
    const t = allowed();
    await t.mutation(internal.devFixtures.seed, { scenario: f.scenario, events: f.events, now: NOW });
    const first = await dump(t);
    const again = await t.mutation(internal.devFixtures.seed, { scenario: f.scenario, events: f.events, now: NOW });
    const second = await dump(t);
    expect(again.replaced).toBeGreaterThan(0);
    for (const table of ALL_TABLES) expect(second[table].length).toBe(first[table].length);
  });

  test("existing agents are reused by role and survive the wipe; real rows are untouched", async () => {
    const t = allowed();
    const { realAgent, realProject } = await t.run(async (ctx) => ({
      realAgent: await ctx.db.insert("agents", { name: "Our CTO", role: "CTO", status: "idle", isEnabled: true }),
      realProject: await ctx.db.insert("projects", { name: "Real project", workspacePath: "/tmp/real" }),
    }));
    for (const f of fixtures) await t.mutation(internal.devFixtures.seed, { scenario: f.scenario, events: f.events, now: NOW });
    const seeded = await dump(t);
    const fixtureTasks = seeded.tasks.filter((task) => (task.assignedAgentIds as string[] | undefined)?.length);
    expect(fixtureTasks.length).toBeGreaterThan(0);
    expect(seeded.agents.filter((a) => String(a.role).toLowerCase() === "cto")).toHaveLength(1);
    // A user clicks in the seeded UI: a row the seeder did not write, under a fixture project.
    const fixtureProject = seeded.projects.find((p) => String(p.name).startsWith("[fixture]"))!;
    await t.run((ctx) => ctx.db.insert("messages", { projectId: fixtureProject._id as never, authorType: "user", content: "typed later" }));

    let guard = 0;
    for (;;) {
      const res = await t.mutation(internal.devFixtures.wipe, {});
      if (!res.more || ++guard > 50) break;
    }
    const after = await dump(t);
    expect(after.devFixtureRows).toHaveLength(0);
    expect(after.agents.map((a) => a._id)).toEqual([realAgent]);
    expect(after.projects.map((p) => p._id)).toEqual([realProject]);
    for (const table of ALL_TABLES.filter((x) => x !== "agents" && x !== "projects")) expect(after[table]).toHaveLength(0);
    // Wiping again is a no-op.
    expect(await t.mutation(internal.devFixtures.wipe, {})).toMatchObject({ deleted: 0, more: false });
  });

  test("wipe of one fixture leaves the others", async () => {
    const t = allowed();
    for (const id of ["planned-push", "personal-chat"]) {
      const f = byId(id);
      await t.mutation(internal.devFixtures.seed, { scenario: f.scenario, events: f.events, now: NOW });
    }
    await t.mutation(internal.devFixtures.wipe, { fixture: "planned-push" });
    const rows = await dump(t);
    // The agents planned-push created stay: personal-chat still points at its CTO.
    expect(new Set(rows.devFixtureRows.map((r) => r.fixture))).toEqual(new Set(["personal-chat", "_shared"]));
    expect(rows.conversations).toHaveLength(1);
    expect(rows.agents.map((a) => a._id)).toContain(rows.conversations[0].agentId);
  });

  test("an invalid fixture is refused before anything is written", async () => {
    const t = allowed();
    const bad = { ...byId("planned-push").scenario, rows: { widgets: [{ fixtureKey: "x" }] } };
    await expect(t.mutation(internal.devFixtures.seed, { scenario: bad, events: [], now: NOW })).rejects.toThrow(/unknown table widgets/);
    expect((await dump(t)).devFixtureRows).toHaveLength(0);
  });
});

describe("guard", () => {
  test("refuses a Convex cloud deployment without FHARA_FIXTURES", async () => {
    vi.stubEnv("FHARA_FIXTURES", "");
    vi.stubEnv("CONVEX_CLOUD_URL", "https://happy-otter-123.convex.cloud");
    const t = convexTest(schema, modules);
    const f = byId("personal-chat");
    await expect(t.mutation(internal.devFixtures.seed, { scenario: f.scenario, events: f.events })).rejects.toThrow(/refused/);
    await expect(t.mutation(internal.devFixtures.wipe, {})).rejects.toThrow(/refused/);
  });

  test("allows a local backend without the flag", async () => {
    vi.stubEnv("FHARA_FIXTURES", "");
    vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3299");
    const t = convexTest(schema, modules);
    const f = byId("personal-chat");
    await expect(t.mutation(internal.devFixtures.seed, { scenario: f.scenario, events: f.events })).resolves.toMatchObject({ fixture: "personal-chat" });
  });

  test("fixturesAllowed", () => {
    const at = (cloudUrl: string | undefined, flag = false) => fixturesAllowed({ cloudUrl, flag }).ok;
    expect(at("http://127.0.0.1:3210")).toBe(true);
    expect(at("http://localhost:3299")).toBe(true);
    expect(at("http://[::1]:3210")).toBe(true);
    expect(at("https://convex.example.internal")).toBe(true); // self-hosted
    expect(at("https://happy-otter-123.convex.cloud")).toBe(false);
    expect(at("https://happy-otter-123.convex.cloud", true)).toBe(true);
    expect(at(undefined)).toBe(false);
    expect(at("not a url")).toBe(false);
  });
});

describe("helpers", () => {
  test("resolveRefs replaces whole-string refs deeply and reports missing ones", () => {
    const ids = new Map([["tasks/main", "t1"]]);
    const out = resolveRefs({ a: "$ref:tasks/main", b: ["$ref:tasks/main", "@frontend $ref:tasks/main"], c: "$ref:messages/x" }, ids);
    expect(out.value).toEqual({ a: "t1", b: ["t1", "@frontend $ref:tasks/main"], c: "$ref:messages/x" });
    expect(out.missing).toEqual(["messages/x"]);
  });

  test("shiftTimes moves timestamp keys only", () => {
    const base = 1_000_000_000_000;
    const shifted = shiftTimes({ createdAt: base, durationMs: 5000, sequence: 3, hold: { resumeAt: base + 1 }, toolSteps: [{ at: base }], other: base }, base, 10);
    expect(shifted).toEqual({ createdAt: base + 10, durationMs: 5000, sequence: 3, hold: { resumeAt: base + 11 }, toolSteps: [{ at: base + 10 }], other: base });
    expect(fixtureShift({ base, anchor: base + 60_000 }, base + 120_000)).toBe(60_000);
  });
});
