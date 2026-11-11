/**
 * @fhara/config for plain-node scripts: the generated
 * packages/config/env-manifest.json (npm run env:example) plus the two
 * helpers the scripts need. Plain node cannot import the TypeScript package.
 */
import { createRequire } from "node:module";

export const ENV_MANIFEST = createRequire(import.meta.url)("../packages/config/env-manifest.json");

/** The manifest entry of a var (throws on a name the schema does not know). */
export function manifestVar(name) {
  const entry = ENV_MANIFEST.vars.find((v) => v.name === name);
  if (!entry) throw new Error(`${name} is not in packages/config/env-manifest.json`);
  return entry;
}

/** A var's value with its legacy aliases applied (name first, then aliases; empty counts as unset). */
export function withAliases(env, name) {
  for (const key of [name, ...(manifestVar(name).aliases ?? [])]) {
    if (env[key]) return env[key];
  }
  return undefined;
}

/**
 * The one bool dialect (B2), same as @fhara/config parseBool: unset/blank →
 * fallback; 1|true|yes|on → true; 0|false|no|off → false; anything else →
 * fallback.
 */
export function envFlag(env, name, fallback = false) {
  manifestVar(name);
  const value = String(env[name] ?? "").trim().toLowerCase();
  if (value === "") return fallback;
  if (ENV_MANIFEST.bool.true.includes(value)) return true;
  if (ENV_MANIFEST.bool.false.includes(value)) return false;
  return fallback;
}
