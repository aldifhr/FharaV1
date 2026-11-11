/**
 * Pure reader: resolve a var's raw value from a source (aliases with `??`),
 * then parse it with the var's dialect, falling back to its default
 * (derived defaults read their inputs through the same source).
 */
import { parseBool, parseEnum, parseNumber, parseString, parseTristate } from "./parse";
import { envVar } from "./schema";
import type { EnvGet, EnvVar } from "./schema/types";

/** A record (process.env, a test env) or a lookup (settingEnv: UI override, then process.env). */
export type EnvSource = Readonly<Record<string, string | undefined>> | ((name: string) => string | undefined);

export interface ReadOptions {
  /** Replace the schema default for this read (e.g. a caller-supplied LLM timeout). */
  fallback?: unknown;
}

export function lookup(source: EnvSource, name: string): string | undefined {
  return typeof source === "function" ? source(name) : source[name];
}

/** The raw value: `name`, then each alias, first one that is not undefined. */
export function rawFrom(def: Pick<EnvVar, "name" | "aliases">, source: EnvSource, useAliases = true): string | undefined {
  const own = lookup(source, def.name);
  if (own !== undefined || !useAliases || !def.aliases) return own;
  for (const alias of def.aliases) {
    const value = lookup(source, alias);
    if (value !== undefined) return value;
  }
  return undefined;
}

function defaultOf(def: EnvVar, source: EnvSource, options: ReadOptions | undefined): unknown {
  if (options && "fallback" in options) return options.fallback;
  const value = (def as { default?: unknown }).default;
  if (typeof value !== "function") return value;
  const get: EnvGet = (name) => {
    const other = envVar(name);
    if (!other) throw new Error(`@fhara/config: unknown var ${name} in the default of ${def.name}`);
    return readDef(other, source);
  };
  return (value as (get: EnvGet) => unknown)(get);
}

/** Read one var by its definition. */
export function readDef(def: EnvVar, source: EnvSource, options?: ReadOptions): unknown {
  const raw = rawFrom(def, source);
  const fallback = () => defaultOf(def, source, options);
  switch (def.type) {
    case "int":
      return parseNumber(def, raw, fallback as () => number);
    case "bool":
      return parseBool(def.name, raw, fallback as () => boolean);
    case "tristate":
      return parseTristate(raw);
    case "enum":
      return parseEnum(def, raw);
    default:
      return parseString(raw, def.parse ?? "nullish", fallback as () => string | undefined);
  }
}

export function readVar(name: string, source: EnvSource, options?: ReadOptions): unknown {
  const def = envVar(name);
  if (!def) throw new Error(`@fhara/config: unknown env var ${name}`);
  return readDef(def, source, options);
}

/** The schema default of a var (derived defaults evaluated against an empty env). */
export function schemaDefault(name: string, source: EnvSource = {}): unknown {
  const def = envVar(name);
  if (!def) throw new Error(`@fhara/config: unknown env var ${name}`);
  return defaultOf(def, source, undefined);
}
