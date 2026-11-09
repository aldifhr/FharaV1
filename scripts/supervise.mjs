#!/usr/bin/env node
/**
 * Tiny process supervisor for long-running dev services (the worker).
 *
 *   node scripts/supervise.mjs [--name worker] [--cwd packages/worker] -- <command> [args...]
 *
 * - Restarts the command whenever it exits (crash or clean exit), with
 *   exponential backoff (1s → 30s). The backoff resets once a run has stayed
 *   up for STABLE_MS.
 * - SIGINT / SIGTERM stop it cleanly: the signal is forwarded to the child's
 *   whole process group (npx → tsx → node), then SIGKILL after a grace period.
 * - Env: SUPERVISE_MAX_RESTARTS (default unlimited), SUPERVISE_GRACE_MS (10000).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MIN_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 30_000;
export const STABLE_MS = 60_000;

/** Next restart delay: doubles per consecutive quick failure, capped. */
export function nextBackoff(previousMs, uptimeMs) {
  if (uptimeMs >= STABLE_MS || !previousMs) return MIN_BACKOFF_MS;
  return Math.min(previousMs * 2, MAX_BACKOFF_MS);
}

/** Split `[--name x] [--cwd y] -- cmd args` into options and the command. */
export function parseArgs(argv) {
  const options = { name: "service", cwd: process.cwd() };
  const dash = argv.indexOf("--");
  const own = dash === -1 ? [] : argv.slice(0, dash);
  const command = dash === -1 ? argv : argv.slice(dash + 1);
  for (let i = 0; i < own.length; i += 1) {
    if (own[i] === "--name") options.name = own[++i];
    else if (own[i] === "--cwd") options.cwd = path.resolve(own[++i]);
  }
  return { options, command };
}

function main() {
  const { options, command } = parseArgs(process.argv.slice(2));
  if (command.length === 0) {
    console.error("usage: supervise.mjs [--name n] [--cwd dir] -- <command> [args...]");
    process.exit(2);
  }
  const maxRestarts = Number(process.env.SUPERVISE_MAX_RESTARTS ?? Infinity);
  const graceMs = Number(process.env.SUPERVISE_GRACE_MS ?? 10_000);
  const log = (msg) => console.log(`[supervise:${options.name}] ${msg}`);

  let child = null;
  let stopping = false;
  let restarts = 0;
  let backoff = 0;
  let timer = null;

  const start = () => {
    timer = null;
    const startedAt = Date.now();
    child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      stdio: "inherit",
      detached: true, // own process group, so a stop reaches tsx's node child too
      env: process.env,
    });
    child.on("error", (err) => log(`failed to start: ${err.message}`));
    child.on("exit", (code, signal) => {
      child = null;
      if (stopping) return process.exit(0);
      const uptime = Date.now() - startedAt;
      backoff = nextBackoff(backoff, uptime);
      restarts += 1;
      if (restarts > maxRestarts) {
        log(`exited (${signal ?? code}); restart limit ${maxRestarts} reached, giving up`);
        return process.exit(typeof code === "number" && code !== 0 ? code : 1);
      }
      log(`exited (${signal ?? `code ${code}`}) after ${Math.round(uptime / 1000)}s; restarting in ${backoff / 1000}s`);
      timer = setTimeout(start, backoff);
    });
  };

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    if (!child) return process.exit(0);
    log(`stopping (${signal})`);
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
    setTimeout(() => {
      if (!child) return;
      log("grace period over, killing");
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child?.kill("SIGKILL");
      }
      process.exit(0);
    }, graceMs).unref();
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
