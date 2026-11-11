/**
 * Mock fixtures (docs/mock-fixtures.md): pure helpers for `devFixtures.ts`.
 *
 * A fixture is one scenario written by scripts/fixtures/make-synthetic.mjs:
 * rows by table plus a sequenced event stream. Rows point at each other with
 * "$ref:<table>/<key>" strings; the seeder swaps them for the ids it
 * inserted. Timestamps start at the generator's fixed BASE and are shifted
 * so the scenario's `anchor` lands on "now".
 *
 * Dev only. The guard below refuses Convex cloud deployments unless
 * FHARA_FIXTURES=1 is set on the deployment.
 */

import type { TableNames } from "../_generated/dataModel";

export const FIXTURE_FORMAT = 1;

/** Tables a fixture may write, in insert order. `agents` rows are looked up by role first. */
export const FIXTURE_TABLES = [
  "agents",
  "projects",
  "conversations",
  "conversationParticipants",
  "tasks",
  "plans",
  "subtasks",
  "fileChanges",
  "approvals",
  "taskPushes",
  "sideEffects",
  "taskBriefs",
  "memories",
  "messages",
] as const satisfies readonly TableNames[];
export type FixtureTable = (typeof FIXTURE_TABLES)[number];

/** Event tables, inserted after every row, in file order, with their own sequence. */
export const FIXTURE_EVENT_TABLES = ["taskEvents", "agentEvents"] as const satisfies readonly TableNames[];
export type FixtureEventTable = (typeof FIXTURE_EVENT_TABLES)[number];

/**
 * Project-scoped tables (each has a `by_project` index led by projectId).
 * Wipe also clears rows here that belong to a fixture project but were not
 * seeded (written later by clicking around the seeded UI).
 */
export const FIXTURE_PROJECT_TABLES = [
  "messages",
  "taskEvents",
  "agentEvents",
  "approvals",
  "taskSignals",
  "fileChanges",
  "taskBriefs",
  "taskPushes",
  "sideEffects",
  "memories",
  "threadStreams",
  "eventBodies",
  "subtaskLive",
  "plans",
  "subtasks",
  "conversationParticipants",
  "conversations",
  "tasks",
] as const satisfies readonly TableNames[];

export interface FixtureScenario {
  format: number;
  id: string;
  title?: string;
  base: number;
  anchor?: number;
  rows: Partial<Record<FixtureTable, Array<Record<string, unknown>>>>;
}

export type FixtureEvent = Record<string, unknown> & { table: FixtureEventTable };

// ── Guard ───────────────────────────────────────────────────────────────

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|[\w.-]+\.localhost)$/i;
const CONVEX_CLOUD = /\.convex\.(?:cloud|site)$/i;

/**
 * May fixtures be written to this deployment? Yes for a local or
 * self-hosted backend (its URL is not a *.convex.cloud host), or when the
 * deployment sets FHARA_FIXTURES=1. An unknown URL is refused without the flag.
 */
export function fixturesAllowed(input: { cloudUrl: string | undefined; flag: boolean }): { ok: boolean; reason: string } {
  if (input.flag) return { ok: true, reason: "FHARA_FIXTURES=1" };
  const raw = input.cloudUrl?.trim();
  if (!raw) return { ok: false, reason: "unknown deployment URL (set FHARA_FIXTURES=1 on a dev deployment)" };
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return { ok: false, reason: `unparseable deployment URL` };
  }
  if (LOOPBACK.test(host)) return { ok: true, reason: "local backend" };
  if (!CONVEX_CLOUD.test(host)) return { ok: true, reason: "self-hosted backend" };
  return { ok: false, reason: "Convex cloud deployment (set FHARA_FIXTURES=1 on a dev deployment to allow)" };
}

// ── Refs ────────────────────────────────────────────────────────────────

const REF = /^\$ref:([A-Za-z]+)\/([\w.-]+)$/;

export function parseRef(value: unknown): { table: string; key: string } | null {
  if (typeof value !== "string") return null;
  const m = REF.exec(value);
  return m ? { table: m[1], key: m[2] } : null;
}

export const refKey = (table: string, key: string) => `${table}/${key}`;

/**
 * Replace every "$ref:" string inside `value` (deeply). `missing` lists the
 * refs not in `ids` yet; the caller defers the field and patches it later.
 */
export function resolveRefs(value: unknown, ids: ReadonlyMap<string, string>): { value: unknown; missing: string[] } {
  const missing: string[] = [];
  const walk = (v: unknown): unknown => {
    const ref = parseRef(v);
    if (ref) {
      const id = ids.get(refKey(ref.table, ref.key));
      if (id === undefined) missing.push(refKey(ref.table, ref.key));
      return id ?? v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[k] = walk(inner);
      return out;
    }
    return v;
  };
  return { value: walk(value), missing };
}

// ── Time ────────────────────────────────────────────────────────────────

/** Values further than this from BASE are not timestamps (counts, durations, sizes). */
const TIME_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

function isTimeKey(key: string): boolean {
  return key === "at" || key === "idleSince" || /At$/.test(key);
}

/** Shift every timestamp-like number (keys `at`, `idleSince`, `*At`) by `shiftMs`, deeply. */
export function shiftTimes<T>(value: T, base: number, shiftMs: number): T {
  if (shiftMs === 0) return value;
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === "number") {
      return key !== null && isTimeKey(key) && Math.abs(v - base) <= TIME_WINDOW_MS ? v + shiftMs : v;
    }
    if (Array.isArray(v)) return v.map((inner) => walk(inner, key === null ? null : key));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[k] = walk(inner, k);
      return out;
    }
    return v;
  };
  return walk(value, null) as T;
}

/** The shift that maps the scenario's anchor to `now`. */
export function fixtureShift(scenario: Pick<FixtureScenario, "base" | "anchor">, now: number): number {
  return now - (scenario.anchor ?? scenario.base);
}

// ── Shape check ─────────────────────────────────────────────────────────

/** Structural checks the Convex validators cannot do (the schema checks the rest on insert). */
export function checkScenario(scenario: unknown, events: unknown): string[] {
  const errors: string[] = [];
  const s = scenario as Partial<FixtureScenario> | null;
  if (!s || typeof s !== "object") return ["scenario is not an object"];
  if (s.format !== FIXTURE_FORMAT) errors.push(`format ${String(s.format)} (expected ${FIXTURE_FORMAT})`);
  if (typeof s.id !== "string" || !/^[a-z0-9-]+$/.test(s.id)) errors.push("id must be a lowercase slug");
  if (typeof s.base !== "number") errors.push("base must be a number");
  const keys = new Set<string>();
  for (const [table, rows] of Object.entries(s.rows ?? {})) {
    if (!(FIXTURE_TABLES as readonly string[]).includes(table)) {
      errors.push(`unknown table ${table}`);
      continue;
    }
    for (const row of rows ?? []) {
      const key = row.fixtureKey;
      if (key !== undefined) {
        if (typeof key !== "string") errors.push(`${table}: fixtureKey must be a string`);
        else if (keys.has(refKey(table, key))) errors.push(`duplicate ${refKey(table, key)}`);
        else keys.add(refKey(table, key));
      }
      if (table === "agents" && typeof row.role !== "string") errors.push(`agents/${String(key)}: role is required`);
    }
  }
  if (!Array.isArray(events)) errors.push("events must be an array");
  else {
    const lastSeq = new Map<string, number>();
    for (const [i, e] of (events as FixtureEvent[]).entries()) {
      if (!(FIXTURE_EVENT_TABLES as readonly string[]).includes(e?.table)) {
        errors.push(`event ${i}: unknown table ${String(e?.table)}`);
        continue;
      }
      if (typeof e.sequence !== "number") {
        errors.push(`event ${i}: sequence is required`);
        continue;
      }
      // Gapless, increasing per stream: what the UI's sequence cursor expects.
      const stream = e.table === "taskEvents" ? `t:${String(e.taskId)}` : e.conversationId ? `c:${String(e.conversationId)}` : `t:${String(e.taskId)}`;
      const prev = lastSeq.get(`${e.table}:${stream}`) ?? 0;
      if (e.sequence !== prev + 1) errors.push(`event ${i}: ${e.table} sequence ${e.sequence} after ${prev}`);
      lastSeq.set(`${e.table}:${stream}`, e.sequence);
    }
  }
  // Every ref points at a row the scenario defines.
  const refs: string[] = [];
  const collect = (v: unknown) => {
    const ref = parseRef(v);
    if (ref) refs.push(refKey(ref.table, ref.key));
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  };
  collect(s.rows);
  collect(events);
  for (const ref of new Set(refs)) if (!keys.has(ref)) errors.push(`dangling ${ref}`);
  return errors;
}
