import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openLocalDatabase } from "../db";
import { registerModules } from "../runtime/registry";
import { LocalExecutor, functionPath } from "../runtime/executor";

let ready: Promise<void> | null = null;

async function ensureRegistered(): Promise<void> {
  if (!ready) {
    ready = import("../../dist/functions.mjs").then((bundled) => {
      registerModules(bundled.modules as Record<string, unknown>);
    });
  }
  await ready;
}

export function runtimeTest(_schema: unknown, _modules?: unknown): any {
  const file = path.join(os.tmpdir(), `fhara-test-${randomUUID()}.db`);
  let db = openLocalDatabase(file);
  let executor = new LocalExecutor(db);

  const api = {
    query: async (reference: unknown, args: Record<string, unknown> = {}) => {
      await ensureRegistered();
      return executor.execute(functionPath(reference), args);
    },
    mutation: async (reference: unknown, args: Record<string, unknown> = {}) => {
      await ensureRegistered();
      return executor.execute(functionPath(reference), args);
    },
    action: async (reference: unknown, args: Record<string, unknown> = {}) => {
      await ensureRegistered();
      return executor.execute(functionPath(reference), args);
    },
    run: async (callback: (ctx: any) => any) => {
      await ensureRegistered();
      return callback(executor.context("internalMutation"));
    },
    finishAllScheduledFunctions: async () => {
      await executor.runDueJobs();
    },
    finishInProgressScheduledFunctions: async () => {
      await executor.runDueJobs();
    },
    fetch: async () => {
      throw new Error("HTTP actions are not supported by the local test runtime");
    },
    withIdentity: () => api,
    cleanup: () => {
      db.close();
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // a temp file may already be gone
      }
    },
    restart: () => {
      db.close();
      db = openLocalDatabase(file);
      executor = new LocalExecutor(db);
    },
  };
  return api;
}
