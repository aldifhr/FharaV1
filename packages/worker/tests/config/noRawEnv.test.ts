import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_SCHEMA, type EnvVar } from "@fhara/config";

/**
 * Guard (E1): packages/worker/src reads Fhara config only through
 * @fhara/config/worker (wenv / wenvRaw). The `process.env` uses left are
 * listed here, each with its reason; a new one fails this test.
 */
const SRC = path.resolve(import.meta.dirname, "../../src");

const ALLOWED: Record<string, string> = {
  "execution/opencodeDetect.ts:const env = input.env ?? process.env;": "PATH / PATHEXT lookup for the OpenCode binary (platform vars)",
  "execution/opencodeHome.ts:export function realOpencodePaths(env: Record<string, string | undefined> = process.env): {":
    "HOME / XDG_* locate the user's real OpenCode files (platform vars)",
  "execution/opencodeHome.ts:const source = input.sourceEnv ?? process.env;": "HOME / XDG_* source for the OpenCode child env (platform vars)",
  "execution/qa.ts:wenv(\"QA_CHROMIUM_PATH\", settingEnv) || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined;":
    "Playwright's own platform var as the QA_CHROMIUM_PATH fallback",
  "llm/resolver.ts:env: Record<string, string | undefined> = process.env":
    "a provider's user-named apiKeyEnv (dynamic name, not a Fhara var)",
  "services/appSettings.ts:export function knobEnvSnapshot(env: Record<string, string | undefined> = process.env): Array<{ key: string; value: string }> {":
    "reports the worker's raw env for every worker knob to Settings (scan over SETTING_KNOBS)",
  "tools/proxyFetch.ts:export function proxyEnv(env: Env = process.env): ProxyEnv | null {": "HTTP(S)_PROXY / NO_PROXY (platform vars)",
  "tools/proxyFetch.ts:export async function proxyAwareFetch(env: Env = process.env): Promise<FetchLike> {": "HTTP(S)_PROXY / NO_PROXY (platform vars)",
  "utils/redact.ts:export function registerEnvSecrets(env: NodeJS.ProcessEnv = process.env): void {":
    "value-based redaction scans every secret-shaped name in the env",
  "vendor/threadbear/acp/agents.ts:const source = o.source ?? process.env;": "vendored threadbear: agent detection env (platform vars)",
  "vendor/threadbear/acp/agents.ts:for (const dir of (o.pathEnv ?? process.env.PATH ?? '').split(path.delimiter)) {":
    "vendored threadbear: PATH lookup (platform var)",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function codeUses(): string[] {
  const hits: string[] = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    let inBlock = false;
    for (const rawLine of fs.readFileSync(file, "utf8").split("\n")) {
      const line = rawLine.trim();
      if (inBlock) {
        if (line.includes("*/")) inBlock = false;
        continue;
      }
      if (line.startsWith("/*")) {
        if (!line.includes("*/")) inBlock = true;
        continue;
      }
      if (line.startsWith("//") || line.startsWith("*")) continue;
      const code = line.replace(/\/\/.*$/, "");
      if (code.includes("process.env")) hits.push(`${rel}:${line}`);
    }
  }
  return hits;
}

describe("noRawEnv guard (worker, E1)", () => {
  it("every process.env use in packages/worker/src is allow-listed with a reason", () => {
    const unexpected = codeUses().filter((hit) => !(hit in ALLOWED));
    expect(unexpected).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    const uses = new Set(codeUses());
    expect(Object.keys(ALLOWED).filter((key) => !uses.has(key))).toEqual([]);
  });

  it("no Fhara var is read as env.NAME / env[\"NAME\"] outside the reader", () => {
    const names = new Set((ENV_SCHEMA as readonly EnvVar[]).map((d) => d.name));
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*(\*|\/\/)/.test(line)) return;
          for (const m of line.matchAll(/\b(?:env|source|e)(?:\.|\[\s*["'`])([A-Z][A-Z0-9_]{2,})/g)) {
            if (names.has(m[1]!)) offenders.push(`${rel}:${i + 1} ${m[1]}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
