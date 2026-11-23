import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_SCHEMA, type EnvVar, varsFor } from "@fhara/config";
import { WEB_CLIENT_VARS } from "@fhara/config/web-client";

/**
 * Guards: apps/web reads Fhara config only through lib/env.server.ts
 * (@fhara/config/web-server) and lib/env.client.ts (the browser bridge).
 * Electron and the plain-node launchers read defaults from the generated
 * env-manifest.json. Every `process.env` use left is listed here with its
 * reason; a new one fails this test.
 */
const ROOT = path.resolve(import.meta.dirname, "../../../..");
const WEB = path.join(ROOT, "apps/web");

const SCAN_DIRS = ["apps/web/app", "apps/web/lib", "apps/web/components", "apps/web/src", "electron"];
const SCAN_FILES = ["apps/web/playwright.config.ts"];

const ALLOWED: Record<string, string> = {
  "apps/web/lib/requestGuard.ts:export function isAllowedHost(hostHeader: string | null, env: Record<string, string | undefined> = process.env): boolean {":
    "pure module unit-tested by plain node (no package imports); FHARA_ALLOWED_HOSTS parity is pinned in webParity",
  "apps/web/lib/requestGuard.ts:export function checkApiRequest(input: GuardInput, env: Record<string, string | undefined> = process.env): GuardResult {":
    "pure module unit-tested by plain node; the env source is injectable",
  "apps/web/lib/projectFilesPolicy.ts:env: Record<string, string | undefined> = process.env,":
    "injectable env for tests; WORKSPACE_ROOT is read through serverEnv and the shared resolver (B7)",
  "apps/web/playwright.config.ts:forbidOnly: !!process.env.CI,": "CI (platform var, Playwright)",
  "apps/web/playwright.config.ts:retries: process.env.CI ? 2 : 0,": "CI (platform var, Playwright)",
  "apps/web/playwright.config.ts:workers: process.env.CI ? 1 : undefined,": "CI (platform var, Playwright)",
  "apps/web/playwright.config.ts:reporter: process.env.CI ? [[\"line\"], [\"html\"]] : [[\"html\", { open: \"never\" }]],": "CI (platform var, Playwright)",
  "apps/web/playwright.config.ts:reuseExistingServer: !process.env.CI,": "CI (platform var, Playwright)",
  "electron/main.cjs:const DEV_SERVER_URL = process.env.DEV_SERVER_URL || envDefault(\"DEV_SERVER_URL\");":
    "plain-node electron: `||` dialect, default from env-manifest.json",
};

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx?|mjs|cjs|js)$/.test(entry.name) && !/\.test\.(tsx?|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function files(): string[] {
  const out = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
  for (const f of SCAN_FILES) if (fs.existsSync(path.join(ROOT, f))) out.push(path.join(ROOT, f));
  return out;
}

function uses(): string[] {
  const hits: string[] = [];
  for (const file of files()) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    let inBlock = false;
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (inBlock) {
        if (line.includes("*/")) inBlock = false;
        continue;
      }
      if (line.startsWith("/*")) {
        if (!line.includes("*/")) inBlock = true;
        continue;
      }
      if (line.startsWith("//") || line.startsWith("*")) continue;
      if (line.replace(/\/\/.*$/, "").includes("process.env")) hits.push(`${rel}:${line}`);
    }
  }
  return hits;
}

describe("noRawEnv guard (web + electron)", () => {
  it("every process.env use in apps/web and electron is allow-listed with a reason", () => {
    expect(uses().filter((hit) => !(hit in ALLOWED))).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    const all = new Set(uses());
    expect(Object.keys(ALLOWED).filter((k) => !all.has(k))).toEqual([]);
  });

  it("every webClient var is declared for webClient in the schema", () => {
    const schemaClient = varsFor("webClient").map((d) => d.name);
    expect([...WEB_CLIENT_VARS].sort()).toEqual([...schemaClient].sort());
    const client = fs.readFileSync(path.join(WEB, "lib/env.client.ts"), "utf8");
    expect(client).toContain("publicFharaRuntimeUrl");
    const elsewhere = uses().filter(
      (hit) => schemaClient.some((name) => hit.includes(`process.env.${name}`)) && !hit.startsWith("apps/web/lib/env.client.ts:")
    );
    expect(elsewhere).toEqual([]);
  });

  it("no browser module imports the server-only env reader", () => {
    const offenders = files()
      .filter((f) => f.startsWith(path.join(WEB, "app")) || f.startsWith(path.join(WEB, "components")))
      .filter((f) => !f.includes(`${path.sep}api${path.sep}`))
      .filter((f) => /env\.server|@fhara\/config\/web-server/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("every Fhara var the web server reads is declared for webServer in the schema", () => {
    const names = new Set((ENV_SCHEMA as readonly EnvVar[]).map((d) => d.name));
    const server = new Set(varsFor("webServer").map((d) => d.name));
    const offenders: string[] = [];
    for (const file of files().filter((f) => f.startsWith(path.join(WEB, "app")) || f.startsWith(path.join(WEB, "lib")))) {
      const src = fs.readFileSync(file, "utf8");
      for (const m of src.matchAll(/serverEnv(?:Raw)?\("([A-Z0-9_]+)"/g)) {
        if (!names.has(m[1]!) || !server.has(m[1]!)) offenders.push(`${path.relative(ROOT, file)} ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
