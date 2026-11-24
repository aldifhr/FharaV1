import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FHARA_NOT_SYNCED, FHARA_SYNC_KEYS, ENV_SCHEMA, type EnvVar, envVar } from "@fhara/config";

/**
 * Guards (E2): apps/api/functions reads Fhara config only through
 * @fhara/config/runtime, and env:sync pushes every FharaRuntime-read var (B4).
 */
const FHARA = path.resolve(import.meta.dirname, "../../../../apps/api/functions");
const ROOT = path.resolve(import.meta.dirname, "../../../..");

const ALLOWED: Record<string, string> = {
  "appSettings.ts:const env = knob.reader === \"worker\" ? workerEnv.get(key) : process.env[key];":
    "Settings shows each api knob's raw FharaRuntime env value (scan over SETTING_KNOBS)",
  "lib/appSettings.ts:return typeof process !== \"undefined\" && process.env ? process.env : {};":
    "the knob layer's own env source (settingEnv / settingFrom)",
  "lib/childEnv.ts:return typeof process !== \"undefined\" && process.env ? process.env : {};":
    "the parent env buildChildEnv copies an allowlist from",
  "devFixtures.ts:process.env.FHARA_BACKEND_URL ??":
    "the dev-only fixtures guard compares the cloud URL from the deployment env before seeding/wiping",
  "devFixtures.ts:process.env.LOCAL_BACKEND_URL ??":
    "LOCAL_BACKEND_URL is a local-dev fallback, not a Fhara config var",
  "lib/chat/llm.ts:if (process.env.VITEST && globalConfig.baseUrl === \"http://localhost:0\") {":
    "VITEST is the test runner's own flag; this short-circuits stub LLM configs before any network call",
  "lib/chat/llm.ts:if (process.env.VITEST) {":
    "VITEST is the test runner's own flag; an empty provider pool resolves to a stub config in tests",
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
  for (const file of walk(FHARA)) {
    const rel = path.relative(FHARA, file).split(path.sep).join("/");
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
      if (line.replace(/\/\/.*$/, "").includes("process.env")) hits.push(`${rel}:${line}`);
    }
  }
  return hits;
}

describe("noRawEnv guard (FharaRuntime, E2)", () => {
  it("every process.env use in apps/api/functions is allow-listed with a reason", () => {
    expect(uses().filter((hit) => !(hit in ALLOWED))).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    const all = new Set(uses());
    expect(Object.keys(ALLOWED).filter((k) => !all.has(k))).toEqual([]);
  });
});

describe("env:sync keys", () => {
  it("scripts/env.mjs FHARA_KEYS comes from the manifest and equals FHARA_SYNC_KEYS, all read by FharaRuntime", async () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts/env.mjs"), "utf8");
    expect(src).toContain("ENV_MANIFEST.runtimeSync");
    const envMjs = path.join(ROOT, "scripts/env.mjs");
    const { FHARA_KEYS } = (await import(envMjs)) as { FHARA_KEYS: string[] };
    expect(FHARA_KEYS).toEqual([...FHARA_SYNC_KEYS]);
    for (const key of FHARA_KEYS) expect(envVar(key)?.runtimes.some((r) => r === "runtime" || r === "runtimeNode")).toBe(true);
  });
});

describe("B4: env:sync covers every var FharaRuntime reads", () => {
  it("each FharaRuntime-read var is synced or listed in FHARA_NOT_SYNCED with a reason", () => {
    const readByFharaRuntime = (ENV_SCHEMA as readonly EnvVar[])
      .filter((d) => !d.deprecated && d.runtimes.some((r) => r === "runtime" || r === "runtimeNode"))
      .map((d) => d.name);
    const synced = new Set<string>(FHARA_SYNC_KEYS);
    expect(readByFharaRuntime.filter((n) => !synced.has(n) && !(n in FHARA_NOT_SYNCED))).toEqual([]);
    expect(Object.keys(FHARA_NOT_SYNCED).filter((n) => synced.has(n))).toEqual([]);
  });

  it("the seven keys D9 found missing are synced now", () => {
    for (const key of [
      "FHARA_WORKTREE_RETENTION_HOURS",
      "FHARA_SNAPSHOT_RETENTION_DAYS",
      "CHAT_REPLY_STALE_MS",
      "TASK_WATCHDOG_STUCK_MS",
      "CONTEXT_SNAPSHOTS",
      "FHARA_GIT_AUTHOR_NAME",
      "FHARA_GIT_AUTHOR_EMAIL",
    ]) expect(FHARA_SYNC_KEYS).toContain(key);
    expect(FHARA_SYNC_KEYS).toHaveLength(17);
  });
});
