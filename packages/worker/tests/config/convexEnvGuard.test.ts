import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CONVEX_SYNC_KEYS, envVar } from "@fhara/config";

/**
 * Guards (E2): apps/api/convex reads Fhara config only through
 * @fhara/config/convex, and env:sync still pushes exactly today's 18 keys.
 */
const CONVEX = path.resolve(import.meta.dirname, "../../../../apps/api/convex");
const ROOT = path.resolve(import.meta.dirname, "../../../..");

const ALLOWED: Record<string, string> = {
  "appSettings.ts:const env = knob.reader === \"worker\" ? workerEnv.get(key) : process.env[key];":
    "Settings shows each api knob's raw Convex env value (scan over SETTING_KNOBS)",
  "lib/appSettings.ts:return typeof process !== \"undefined\" && process.env ? process.env : {};":
    "the knob layer's own env source (settingEnv / settingFrom)",
  "lib/childEnv.ts:return typeof process !== \"undefined\" && process.env ? process.env : {};":
    "the parent env buildChildEnv copies an allowlist from",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "_generated" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function uses(): string[] {
  const hits: string[] = [];
  for (const file of walk(CONVEX)) {
    const rel = path.relative(CONVEX, file).split(path.sep).join("/");
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
      if (line.replace(/\/\/.*$/, "").includes("process.env")) hits.push(`${rel}:${line}`);
    }
  }
  return hits;
}

describe("noRawEnv guard (Convex, E2)", () => {
  it("every process.env use in apps/api/convex is allow-listed with a reason", () => {
    expect(uses().filter((hit) => !(hit in ALLOWED))).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    const all = new Set(uses());
    expect(Object.keys(ALLOWED).filter((k) => !all.has(k))).toEqual([]);
  });
});

describe("env:sync keys (E2 keeps today's 18)", () => {
  it("scripts/env.mjs CONVEX_KEYS equals CONVEX_SYNC_KEYS, all schema vars read by Convex", () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts/env.mjs"), "utf8");
    const block = /export const CONVEX_KEYS = \[([\s\S]*?)\];/.exec(src)?.[1] ?? "";
    const keys = [...block.matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
    expect(keys).toEqual([...CONVEX_SYNC_KEYS]);
    expect(keys).toHaveLength(18);
    for (const key of keys) expect(envVar(key)?.runtimes.some((r) => r === "convex" || r === "convexNode")).toBe(true);
  });
});
