import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CONVEX_SYNC_KEYS, ENV_SCHEMA, type EnvVar, exampleValue, renderApiEnvExample, renderEnvExample, renderManifest, schemaDefault } from "@fhara/config";
import { ROOT_ENV_FILE } from "../../src/utils/rootEnv";

/**
 * Guards (E4): the env docs are generated from the schema. A stale copy
 * fails here with the command that regenerates it.
 */
const ROOT = path.resolve(import.meta.dirname, "../../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const STALE = "stale: run `npm run env:example`";

describe("generated env files (E4)", () => {
  it(".env.example is up to date", () => {
    expect(read(".env.example"), STALE).toBe(renderEnvExample());
  });

  it("apps/api/.env.example is up to date", () => {
    expect(read("apps/api/.env.example"), STALE).toBe(renderApiEnvExample());
  });

  it("packages/config/env-manifest.json is up to date", () => {
    expect(read("packages/config/env-manifest.json"), STALE).toBe(renderManifest());
  });

  it("there is no per-app web .env.example duplicating the root one", () => {
    expect(fs.existsSync(path.join(ROOT, "apps/web/.env.example"))).toBe(false);
  });
});

describe(".env.example content (E4)", () => {
  const text = renderEnvExample();
  const all = ENV_SCHEMA as readonly EnvVar[];

  it("has one header, not two", () => {
    expect(text.match(/one \.env for the whole repo/gi)).toHaveLength(1);
    expect(text).not.toMatch(/npx convex env set NAME value/);
  });

  it("lists every current var once with its schema default, and every legacy name as a note", () => {
    for (const def of all) {
      if (def.deprecated) {
        expect(text).toContain(`# ${def.name}: ${def.deprecated}`);
        expect(text).not.toMatch(new RegExp(`^#? ?${def.name}=`, "m"));
        continue;
      }
      const lines = text.split("\n").filter((l) => new RegExp(`^(# )?${def.name}=`).test(l));
      expect(lines, def.name).toHaveLength(1);
      expect(lines[0]!.replace(/^# /, "")).toBe(`${def.name}=${exampleValue(def)}`);
    }
  });

  it("documents the code defaults, not the old drifted ones (D1, D2) and no dead var", () => {
    expect(text).toContain(`# ORCHESTRATOR_SUBTASK_TIMEOUT_MS=${schemaDefault("ORCHESTRATOR_SUBTASK_TIMEOUT_MS")}`);
    expect(text).toContain("# ORCHESTRATOR_SUBTASK_TIMEOUT_MS=900000");
    expect(text).toContain("# WORKER_POLL_INTERVAL_MS=1500");
    expect(text).not.toContain("MODEL_CAPABILITY_ROUTING");
  });

  it("only required vars are uncommented; secrets never carry a value", () => {
    const set = text.split("\n").filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l));
    expect(set.map((l) => l.split("=")[0]).sort()).toEqual(all.filter((d) => d.required?.length && !d.deprecated).map((d) => d.name).sort());
    for (const def of all.filter((d) => d.secret)) {
      expect(text).not.toMatch(new RegExp(`^(# )?${def.name}=.+$`, "m"));
    }
  });

  it("marks exactly the env:sync keys as synced to Convex", () => {
    const synced = text
      .split("\n")
      .map((line, i, lines) => (line.includes("synced to Convex by npm run dev") ? lines[i + 1]!.replace(/^# /, "").split("=")[0] : null))
      .filter(Boolean);
    expect(new Set(synced)).toEqual(new Set(CONVEX_SYNC_KEYS.filter((k) => !envVar(k)?.deprecated)));
  });
});

function envVar(name: string) {
  return (ENV_SCHEMA as readonly EnvVar[]).find((d) => d.name === name);
}

describe("worker dotenv path (E4)", () => {
  it("is file-relative and names the repo-root .env", () => {
    expect(ROOT_ENV_FILE).toBe(path.join(ROOT, ".env"));
  });
});
