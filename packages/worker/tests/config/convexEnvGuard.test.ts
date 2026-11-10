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

describe("env:sync keys", () => {
  it("scripts/env.mjs CONVEX_KEYS comes from the manifest and equals CONVEX_SYNC_KEYS, all read by Convex", async () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts/env.mjs"), "utf8");
    expect(src).toContain("ENV_MANIFEST.convexSync");
    const envMjs = path.join(ROOT, "scripts/env.mjs");
    const { CONVEX_KEYS } = (await import(envMjs)) as { CONVEX_KEYS: string[] };
    expect(CONVEX_KEYS).toEqual([...CONVEX_SYNC_KEYS]);
    for (const key of CONVEX_KEYS) expect(envVar(key)?.runtimes.some((r) => r === "convex" || r === "convexNode")).toBe(true);
  });
});
