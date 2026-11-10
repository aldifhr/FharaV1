/**
 * The parsers. One boolean parser and one validated number parser, each
 * with the dialects the code used before E1 (see schema/types.ts). A value
 * that does not parse falls back to the default and reports an issue; only
 * the `legacyNumber` dialect (index.ts, kept for parity until B3) can still
 * return NaN, and it reports that too.
 */
import type { BoolParse, EnumVar, NumberVar, StringParse } from "./schema/types";

export interface EnvIssue {
  name: string;
  raw: string;
  reason: string;
}

export type EnvIssueSink = (issue: EnvIssue) => void;

const reported = new Set<string>();
const defaultSink: EnvIssueSink = (issue) => {
  const key = `${issue.name}\u0000${issue.raw}`;
  if (reported.has(key)) return;
  reported.add(key);
  const out = (globalThis as { console?: { warn?: (...args: unknown[]) => void } }).console;
  out?.warn?.(`[fhara/config] ${issue.name}=${JSON.stringify(issue.raw)}: ${issue.reason}`);
};
let sink: EnvIssueSink = defaultSink;

/** Route parse issues elsewhere (tests, a startup validator). Returns the previous sink. */
export function setEnvIssueSink(next: EnvIssueSink | null): EnvIssueSink {
  const previous = sink;
  sink = next ?? defaultSink;
  return previous;
}

function report(name: string, raw: string, reason: string): void {
  sink({ name, raw, reason });
}

const FALSY = ["0", "false", "off", "no"];
const TRUTHY = /^(1|true|yes|on)$/i;

/** The one boolean parser. `raw` is the value after alias resolution. */
export function parseBool(name: string, raw: string | undefined, mode: BoolParse, fallback: () => boolean): boolean {
  switch (mode) {
    case "falsyList":
      if (raw === undefined) return fallback();
      return !FALSY.includes(raw.trim().toLowerCase());
    case "truthyList":
      return TRUTHY.test((raw ?? "").trim());
    case "neq0":
      return raw !== "0";
    case "neq0Trim":
      return (raw ?? "").trim() !== "0";
    case "eq1":
      return raw === "1";
  }
}

/** unset/blank → undefined (auto); 0/false → false; anything else → true. */
export function parseTristate(raw: string | undefined): boolean | undefined {
  const flag = (raw ?? "").trim().toLowerCase();
  if (flag === "") return undefined;
  return !(flag === "0" || flag === "false");
}

function clamp(value: number, min: number | undefined, max: number | undefined): number {
  return Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, value));
}

const blank = (raw: string | undefined): raw is undefined => raw === undefined || raw.trim() === "";

/** The one number parser. Invalid input → the default plus an issue. */
export function parseNumber(def: NumberVar, raw: string | undefined, fallback: () => number): number {
  const { name, min, max } = def;
  const invalid = (reason = "not a number; using the default"): number => {
    if (raw !== undefined && raw.trim() !== "") report(name, raw, reason);
    return fallback();
  };
  switch (def.parse) {
    case "clamp": {
      if (!raw) return fallback();
      const n = Number(raw);
      if (!Number.isFinite(n)) return invalid();
      return clamp(Math.floor(n), min, max);
    }
    case "clampBlank": {
      if (blank(raw)) return fallback();
      const n = Number(raw);
      if (!Number.isFinite(n)) return invalid();
      if (def.zeroMeansOff && n === 0 && (min ?? 0) > 0) return 0;
      if (def.nonPositive && n <= 0) return def.nonPositive === "off" ? 0 : fallback();
      return clamp(Math.floor(n), min, max);
    }
    case "clampParseInt": {
      if (blank(raw)) return fallback();
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n)) return invalid();
      return clamp(n, min, max);
    }
    case "legacyNumber": {
      const n = raw === undefined ? fallback() : Number(raw);
      const value = min === undefined ? n : Math.max(min, n);
      if (Number.isNaN(value) && raw !== undefined) {
        report(name, raw, "not a number; kept as NaN for parity until B3");
      }
      return value;
    }
    case "nullishNumber": {
      let n = raw === undefined ? fallback() : Number(raw);
      if (def.floor) n = Math.floor(n);
      if (!Number.isFinite(n)) n = invalid();
      return clamp(n, min, max);
    }
    case "atLeast": {
      const n = Number(raw);
      const ok = Number.isFinite(n) && (def.positive ? n > 0 : n >= (min ?? Number.NEGATIVE_INFINITY));
      if (!ok) return raw === undefined || raw.trim() === "" ? fallback() : invalid("not a valid number; using the default");
      return def.floor ? Math.floor(n) : n;
    }
    case "truthyNumber": {
      const n = Number(raw);
      if (Number.isNaN(n) && raw !== undefined && raw.trim() !== "") report(name, raw, "not a number; using the default");
      return n || fallback();
    }
    case "truthyRawNumber": {
      const n = raw ? Number(raw) : Number.NaN;
      if (Number.isFinite(n)) return n;
      return raw ? invalid() : fallback();
    }
  }
}

/** Enum: trim (+ lowercase), map input aliases, otherwise the default. */
export function parseEnum(def: EnumVar, raw: string | undefined): string {
  let value = (raw ?? "").trim();
  if (!def.caseSensitive) value = value.toLowerCase();
  value = def.map?.[value] ?? value;
  if (def.options.includes(value)) return value;
  if (value !== "" && raw !== undefined) report(def.name, raw, `not one of ${def.options.join(", ")}; using the default`);
  return def.default;
}

export function parseString(raw: string | undefined, mode: StringParse, fallback: () => string | undefined): string | undefined {
  switch (mode) {
    case "nullish":
      return raw ?? fallback();
    case "trimOr":
      return raw?.trim() || fallback();
    case "lower":
      return (raw ?? fallback() ?? "").toLowerCase();
  }
}
