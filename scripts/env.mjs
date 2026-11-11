#!/usr/bin/env node
/**
 * One .env for the whole repo (the root `.env`).
 *
 *   node scripts/env.mjs sync              push the Convex keys from .env to the Convex deployment
 *   node scripts/env.mjs run -- <cmd...>   run a command with the root .env loaded
 *
 * - The worker already reads the root .env; the web app loads it in
 *   next.config.mjs. Convex functions cannot read files: their env lives on
 *   the deployment, so `sync` copies the keys they use (CONVEX_KEYS) there,
 *   setting only the ones that changed. Values are never printed.
 * - Variables already in the process environment win over the file.
 * - `sync` never fails the caller: with no deployment configured it warns
 *   and exits 0, so `npm run dev` still starts.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDotenv } from "./doctor.mjs";
import { ENV_MANIFEST } from "./envManifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = path.join(ROOT, "apps", "api");
const isWin = process.platform === "win32";

/**
 * Keys read by Convex functions, pushed by `sync`. The list comes from
 * @fhara/config (CONVEX_SYNC_KEYS) through its generated manifest, since
 * plain node cannot import the TypeScript package.
 */
export const CONVEX_KEYS = [...ENV_MANIFEST.convexSync];

/** Root .env merged under the current process env (process env wins). */
export function loadRootEnv(env = process.env) {
  const file = path.join(ROOT, ".env");
  const parsed = fs.existsSync(file) ? parseDotenv(fs.readFileSync(file, "utf8")) : {};
  const merged = { ...env };
  for (const [key, value] of Object.entries(parsed)) {
    if (merged[key] === undefined || merged[key] === "") merged[key] = value;
  }
  return { merged, parsed };
}

/** Which keys need setting on the deployment (new or different values). */
export function keysToSync(wanted, current) {
  return Object.keys(wanted).filter(
    (key) => CONVEX_KEYS.includes(key) && wanted[key] !== "" && current[key] !== wanted[key]
  );
}

function convex(args, env) {
  return spawnSync("npx", ["convex", ...args], {
    cwd: API_DIR,
    env,
    encoding: "utf8",
    shell: isWin,
    windowsHide: true,
  });
}

function sync() {
  const { merged } = loadRootEnv();
  const listed = convex(["env", "list"], merged);
  if (listed.status !== 0) {
    console.warn("[env] skipped Convex sync: no deployment reachable (run `npx convex dev` once, or set CONVEX_SELF_HOSTED_URL).");
    return 0;
  }
  const current = parseDotenv(listed.stdout ?? "");
  const wanted = Object.fromEntries(CONVEX_KEYS.filter((k) => merged[k]).map((k) => [k, merged[k]]));
  const changed = keysToSync(wanted, current);
  for (const key of changed) {
    const set = convex(["env", "set", key, wanted[key]], merged);
    if (set.status !== 0) console.warn(`[env] could not set ${key} on Convex`);
  }
  console.log(changed.length ? `[env] Convex env updated: ${changed.join(", ")}` : "[env] Convex env up to date");
  return 0;
}

function run(command) {
  if (command.length === 0) {
    console.error("usage: node scripts/env.mjs run -- <command...>");
    return Promise.resolve(2);
  }
  const { merged } = loadRootEnv();
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: "inherit",
      env: merged,
      shell: isWin,
      windowsHide: true,
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "sync") process.exit(sync());
  else if (mode === "run") run(rest[0] === "--" ? rest.slice(1) : rest).then((code) => process.exit(code));
  else {
    console.error("usage: node scripts/env.mjs sync | run -- <command...>");
    process.exit(2);
  }
}
