/**
 * Load the synthetic fixtures into a dev Convex deployment, or wipe them.
 *
 *   npm run fixtures:seed                      every scenario
 *   npm run fixtures:seed -- --only planned-push,held-resume
 *   npm run fixtures:wipe                      every fixture row (and rows written under fixture projects)
 *   npm run fixtures:wipe -- --only planned-push
 *   npm run fixtures:seed -- --list            print the scenarios and exit
 *
 * It calls the internal mutations devFixtures:seed / devFixtures:wipe with
 * the Convex CLI (`npx convex run`, from apps/api), so it targets whatever
 * deployment the CLI would: CONVEX_SELF_HOSTED_URL (+ ADMIN_KEY) or
 * CONVEX_DEPLOYMENT, from the environment or apps/api/.env.local.
 *
 * Guard, twice: this script refuses unless the target is local or
 * self-hosted (or FHARA_FIXTURES=1 is set here), and the mutations refuse
 * a Convex cloud deployment unless FHARA_FIXTURES=1 is set ON the
 * deployment (`npx convex env set FHARA_FIXTURES 1`, dev deployments only).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readVar } from "@fhara/config";
import { fixturesAllowed } from "../../apps/api/convex/lib/devFixtures";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const API = path.join(ROOT, "apps/api");
const SCENARIOS = path.join(ROOT, "fixtures/scenarios");

/** KEY=value lines (quotes stripped); comments and blanks ignored. */
function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

// The CLI's own lookup order: process env wins over apps/api/.env.local, then the root .env.
const source = { ...readEnvFile(path.join(ROOT, ".env")), ...readEnvFile(path.join(API, ".env.local")), ...process.env };
const env = <T>(name: string) => readVar(name, source) as T;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function targetAllowed(input: { selfHostedUrl?: string; deployment?: string; flag: boolean }): { ok: boolean; target: string; reason: string } {
  if (input.selfHostedUrl) {
    const v = fixturesAllowed({ cloudUrl: input.selfHostedUrl, flag: input.flag });
    return { ...v, target: input.selfHostedUrl };
  }
  const deployment = input.deployment?.trim() ?? "";
  if (/^(?:local|anonymous):/.test(deployment)) return { ok: true, target: deployment, reason: "local deployment" };
  if (input.flag) return { ok: true, target: deployment || "(CLI default)", reason: "FHARA_FIXTURES=1" };
  return { ok: false, target: deployment || "(CLI default)", reason: "not a local or self-hosted deployment (set FHARA_FIXTURES=1 for a dev deployment)" };
}

function listScenarios(): string[] {
  const index = JSON.parse(fs.readFileSync(path.join(SCENARIOS, "index.json"), "utf8")) as { scenarios: Array<{ id: string }> };
  return index.scenarios.map((s) => s.id);
}

function convexRun(fn: string, args: unknown): unknown {
  const res = spawnSync("npx", ["convex", "run", fn, JSON.stringify(args)], {
    cwd: API,
    encoding: "utf8",
    // The CLI needs the platform env (PATH, HOME) and its own deployment vars.
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (res.status !== 0) throw new Error(`npx convex run ${fn} failed:\n${(res.stderr || res.stdout || "").trim()}`);
  const out = res.stdout.trim();
  try {
    return JSON.parse(out.slice(out.search(/[[{]/)));
  } catch {
    return out;
  }
}

function main(): void {
  const all = listScenarios();
  if (process.argv.includes("--list")) {
    for (const id of all) console.log(id);
    return;
  }
  const wipe = process.argv.includes("--wipe");
  const only = arg("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = (only ?? []).filter((id) => !all.includes(id));
  if (unknown.length) throw new Error(`Unknown scenario(s): ${unknown.join(", ")} (have: ${all.join(", ")})`);

  const verdict = targetAllowed({
    selfHostedUrl: env<string | undefined>("CONVEX_SELF_HOSTED_URL"),
    deployment: env<string | undefined>("CONVEX_DEPLOYMENT"),
    flag: env<boolean>("FHARA_FIXTURES"),
  });
  if (!verdict.ok) {
    console.error(`fixtures: refusing ${verdict.target}: ${verdict.reason}`);
    process.exit(2);
  }
  console.log(`fixtures: ${wipe ? "wiping" : "seeding"} on ${verdict.target} (${verdict.reason})`);

  if (wipe) {
    for (const fixture of only ?? [undefined]) {
      let total = 0;
      for (let round = 0; round < 200; round++) {
        const res = convexRun("devFixtures:wipe", fixture ? { fixture } : {}) as { deleted: number; more: boolean };
        total += res.deleted;
        if (!res.more) break;
      }
      console.log(`  wiped ${fixture ?? "all fixtures"}: ${total} rows`);
    }
    return;
  }
  for (const id of only ?? all) {
    const dir = path.join(SCENARIOS, id);
    const scenario = JSON.parse(fs.readFileSync(path.join(dir, "scenario.json"), "utf8"));
    const events = fs.readFileSync(path.join(dir, "events.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const res = convexRun("devFixtures:seed", { scenario, events }) as { rows: number; events: number; reusedAgents: string[]; replaced: number };
    console.log(`  ${id}: ${res.rows} rows, ${res.events} events${res.reusedAgents?.length ? `, reused agents: ${res.reusedAgents.join(", ")}` : ""}${res.replaced ? ` (replaced ${res.replaced})` : ""}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`fixtures: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
