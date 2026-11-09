#!/usr/bin/env node
// Run `next dev` / `next start` bound to 127.0.0.1 unless FHARA_HOST says
// otherwise (release audit P0-4: Next listens on every interface by
// default, which puts the unauthenticated /api routes on the LAN).
//
//   FHARA_HOST=0.0.0.0 npm run dev   # deliberately expose (also set FHARA_ALLOWED_HOSTS)
//
// FHARA_HOST is read from the environment or the repo-root .env, the same
// file next.config.mjs loads.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";

const [mode, ...rest] = process.argv.slice(2);
if (mode !== "dev" && mode !== "start") {
  console.error("usage: node scripts/next.mjs <dev|start> [next args]");
  process.exit(2);
}

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webDir, "../..");
nextEnv.loadEnvConfig(repoRoot, mode === "dev");

const hasHostFlag = rest.some((arg) => arg === "-H" || arg === "--hostname" || arg.startsWith("--hostname="));
const host = (process.env.FHARA_HOST ?? "").trim() || "127.0.0.1";
const args = [mode, ...(hasHostFlag ? [] : ["-H", host]), ...rest];

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, ...args], { cwd: webDir, stdio: "inherit" });
const forward = (signal) => () => child.kill(signal);
process.on("SIGINT", forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
