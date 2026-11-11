/**
 * Mock fixtures (docs/mock-fixtures.md): load synthetic scenarios into a
 * dev deployment so the UI and its flows can be developed without a slow
 * real LLM or GitHub, and wipe them again.
 *
 *   npm run fixtures:seed   -> devFixtures:seed, once per scenario
 *   npm run fixtures:wipe   -> devFixtures:wipe until nothing is left
 *
 * Internal only (the Convex CLI calls them with the deployment's admin
 * key); never reachable from the web client or the worker. Both refuse a
 * Convex cloud deployment unless FHARA_FIXTURES=1 is set on it
 * (lib/devFixtures.ts fixturesAllowed). Every inserted row is recorded in
 * `devFixtureRows`, so a wipe deletes exactly what a seed wrote, plus rows
 * later written under a fixture project or conversation.
 */
import { v } from "convex/values";
import { cenv, cenvRaw } from "@fhara/config/convex";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  checkScenario,
  FIXTURE_PROJECT_TABLES,
  FIXTURE_TABLES,
  fixtureShift,
  fixturesAllowed,
  refKey,
  resolveRefs,
  shiftTimes,
  type FixtureEvent,
  type FixtureScenario,
} from "./lib/devFixtures";
import { normalizeRoleKey } from "./lib/roles";

/**
 * The seeder writes rows of many tables from data, so it talks to the db
 * through this loose view (table names come from FIXTURE_TABLES; the
 * schema still validates every insert and patch at runtime).
 */
interface LooseDb {
  insert(table: string, doc: Record<string, unknown>): Promise<string>;
  patch(id: string, fields: Record<string, unknown>): Promise<void>;
  delete(id: string): Promise<void>;
  get(id: string): Promise<Record<string, unknown> | null>;
  query(table: string): {
    withIndex(index: string, range: (q: { eq(field: string, value: unknown): unknown }) => unknown): { take(n: number): Promise<Array<{ _id: string }>> };
    take(n: number): Promise<Array<Record<string, unknown> & { _id: string }>>;
  };
}
const loose = (ctx: MutationCtx): LooseDb => ctx.db as unknown as LooseDb;

function assertAllowed(): void {
  const verdict = fixturesAllowed({ cloudUrl: cenvRaw("CONVEX_CLOUD_URL"), flag: cenv("FHARA_FIXTURES") });
  if (!verdict.ok) throw new Error(`devFixtures refused: ${verdict.reason}`);
}

const WIPE_BATCH = 400;
/** Registry name of the agents fixtures created (wiped only by a full wipe, last). */
const SHARED_FIXTURE = "_shared";

/** Delete up to `budget` rows of one fixture; returns how many were deleted. */
async function wipeFixture(ctx: MutationCtx, fixture: string, budget: number): Promise<{ deleted: number; more: boolean }> {
  const db = loose(ctx);
  const registry = await ctx.db
    .query("devFixtureRows")
    .withIndex("by_fixture", (q) => q.eq("fixture", fixture))
    .take(Math.max(1, budget));
  let deleted = 0;
  // Rows written later under a fixture project / conversation (UI clicks on
  // seeded data). Projects and conversations are fixture-only, so all of it goes.
  for (const entry of registry.filter((r) => r.table === "projects")) {
    for (const table of FIXTURE_PROJECT_TABLES) {
      if (deleted >= budget) return { deleted, more: true };
      const rows = await db
        .query(table)
        .withIndex("by_project", (q) => q.eq("projectId", entry.rowId))
        .take(budget - deleted);
      for (const row of rows) {
        await db.delete(row._id);
        deleted += 1;
      }
    }
  }
  for (const entry of registry.filter((r) => r.table === "conversations")) {
    if (deleted >= budget) return { deleted, more: true };
    const rows = await db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", entry.rowId))
      .take(budget - deleted);
    for (const row of rows) {
      await db.delete(row._id);
      deleted += 1;
    }
  }
  for (const entry of registry) {
    if (deleted >= budget) return { deleted, more: true };
    if (await db.get(entry.rowId)) {
      await db.delete(entry.rowId);
      deleted += 1;
    }
    await ctx.db.delete(entry._id);
  }
  const left = await ctx.db
    .query("devFixtureRows")
    .withIndex("by_fixture", (q) => q.eq("fixture", fixture))
    .first();
  return { deleted, more: left !== null };
}

/**
 * Load one scenario (scenario.json + events.ndjson as parsed JSON).
 * Re-seeding a scenario replaces it: its previous rows are wiped first.
 */
export const seed = internalMutation({
  args: { scenario: v.any(), events: v.array(v.any()), now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ fixture: string; rows: number; events: number; reusedAgents: string[]; replaced: number }> => {
    assertAllowed();
    const errors = checkScenario(args.scenario, args.events);
    if (errors.length > 0) throw new Error(`Invalid fixture: ${errors.slice(0, 5).join("; ")}`);
    const scenario = args.scenario as FixtureScenario;
    const events = args.events as FixtureEvent[];
    const fixture = scenario.id;
    const db = loose(ctx);

    let replaced = 0;
    for (;;) {
      const res = await wipeFixture(ctx, fixture, 4000);
      replaced += res.deleted;
      if (!res.more) break;
    }

    const now = args.now ?? Date.now();
    const shift = fixtureShift(scenario, now);
    const ids = new Map<string, string>();
    const deferred: Array<{ id: string; field: string; value: unknown }> = [];
    const reusedAgents: string[] = [];
    let rowCount = 0;
    const register = async (table: string, rowId: string) => {
      // Agents a fixture had to create are shared by every scenario seeded
      // after it, so they belong to no single fixture: only a full wipe removes them.
      await ctx.db.insert("devFixtureRows", { fixture: table === "agents" ? SHARED_FIXTURE : fixture, table, rowId, createdAt: now });
    };

    // Existing agents are reused by role, so the seeded tasks show the real team.
    const existingAgents = (await db.query("agents").take(500)).filter((a) => a.isEnabled !== false);

    for (const table of FIXTURE_TABLES) {
      for (const raw of scenario.rows[table] ?? []) {
        const { fixtureKey: key, ...fields } = raw as Record<string, unknown> & { fixtureKey?: string };
        if (table === "agents") {
          const role = normalizeRoleKey(String(fields.role));
          const found = existingAgents.find((a) => normalizeRoleKey(String(a.role ?? "")) === role);
          if (found) {
            ids.set(refKey(table, String(key)), found._id);
            reusedAgents.push(role);
            continue;
          }
          fields.description = "Fixture agent (devFixtures); removed by fixtures:wipe.";
        }
        const doc: Record<string, unknown> = {};
        const later: Array<{ field: string; value: unknown }> = [];
        for (const [field, value] of Object.entries(shiftTimes(fields, scenario.base, shift))) {
          const resolved = resolveRefs(value, ids);
          if (resolved.missing.length > 0) later.push({ field, value });
          else doc[field] = resolved.value;
        }
        const id = await db.insert(table, doc);
        await register(table, id);
        rowCount += 1;
        if (key !== undefined) ids.set(refKey(table, String(key)), id);
        for (const item of later) deferred.push({ id, ...item });
      }
    }

    const maxSeq = new Map<string, number>();
    for (const raw of events) {
      const { table, ...fields } = raw;
      const resolved = resolveRefs(shiftTimes(fields, scenario.base, shift), ids);
      if (resolved.missing.length > 0) throw new Error(`Unresolved ${resolved.missing[0]} in a ${table} row`);
      const doc = resolved.value as Record<string, unknown>;
      const id = await db.insert(table, doc);
      await register(table, id);
      if (table === "taskEvents" && typeof doc.taskId === "string" && typeof doc.sequence === "number") {
        maxSeq.set(doc.taskId, Math.max(maxSeq.get(doc.taskId) ?? 0, doc.sequence));
      }
    }

    for (const item of deferred) {
      const resolved = resolveRefs(item.value, ids);
      if (resolved.missing.length > 0) throw new Error(`Unresolved ${resolved.missing[0]} in field ${item.field}`);
      await db.patch(item.id, { [item.field]: resolved.value });
    }
    // Later real appends continue the stream gaplessly (lib/taskEvents.ts).
    for (const [taskId, seq] of maxSeq) await ctx.db.patch(taskId as Id<"tasks">, { eventSequence: seq });

    return { fixture, rows: rowCount, events: events.length, reusedAgents, replaced };
  },
});

/** Delete fixture rows, one batch per call; call again while `more` is true. */
export const wipe = internalMutation({
  args: { fixture: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ deleted: number; more: boolean; fixtures: string[] }> => {
    assertAllowed();
    const fixtures = args.fixture
      ? [args.fixture]
      : Array.from(new Set((await ctx.db.query("devFixtureRows").take(WIPE_BATCH)).map((r) => r.fixture))).sort(
          (a, b) => Number(a === SHARED_FIXTURE) - Number(b === SHARED_FIXTURE)
        );
    let deleted = 0;
    let more = false;
    for (const fixture of fixtures) {
      const res = await wipeFixture(ctx, fixture, WIPE_BATCH - deleted);
      deleted += res.deleted;
      more ||= res.more;
      if (deleted >= WIPE_BATCH) {
        more = true;
        break;
      }
    }
    if (!args.fixture && !more) more = (await ctx.db.query("devFixtureRows").first()) !== null;
    return { deleted, more, fixtures };
  },
});
