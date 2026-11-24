import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { getFunctionName } from "../compat/server";
import type { LocalDatabase } from "../db";
import { getFunction } from "./registry";
import { validateArgs } from "./validate";
import { LocalQuery } from "./queryBuilder";

export function functionPath(reference: unknown): string {
  if (typeof reference === "string") return reference;
  const direct = (reference as any)?.__fharaPath;
  if (typeof direct === "string") return direct;
  return getFunctionName(reference as any);
}

function tableOfId(id: string): string {
  return String(id).split(":")[0];
}

function storageDir(): string {
  return process.env.FHARA_STORAGE_DIR ?? path.join(os.homedir(), ".fhara", "storage");
}

export class LocalExecutor {
  private readonly executionContext = new AsyncLocalStorage<{
    lockHeld: boolean;
    transactionOpen: boolean;
    identity: { subject: string } | null;
  }>();
  private executionTail: Promise<void> = Promise.resolve();

  constructor(readonly db: LocalDatabase) {}

  context(kind: string): any {
    const executor = this;
    const identity = this.executionContext.getStore()?.identity ?? null;
    const baseUrl = process.env.LOCAL_BACKEND_URL ?? "http://127.0.0.1:8787";
    return {
      db: {
        get: (id: string) => this.db.get(tableOfId(id), id),
        insert: (table: string, value: Record<string, unknown>) => this.db.insert(table, value),
        patch: (id: string, patch: Record<string, unknown>) => this.db.patch(tableOfId(id), id, patch),
        replace: (id: string, value: Record<string, unknown>) => this.db.replace(tableOfId(id), id, value),
        delete: (id: string) => this.db.delete(tableOfId(id), id),
        query: (table: string) => new LocalQuery(this.db, table),
        system: { get: (id: string) => null },
        normalizeId: (table: string, id: string) => (tableOfId(id) === table ? id : null),
      },
      runQuery: (reference: unknown, args: Record<string, unknown>) =>
        executor.execute(functionPath(reference), args),
      runMutation: (reference: unknown, args: Record<string, unknown>) =>
        executor.execute(functionPath(reference), args),
      runAction: (reference: unknown, args: Record<string, unknown>) =>
        executor.execute(functionPath(reference), args),
      scheduler: {
        runAfter: (delayMs: number, reference: unknown, args: Record<string, unknown>) => {
          const id = randomUUID();
          this.db.enqueueJob(id, Date.now() + delayMs, functionPath(reference), args ?? {});
          return id;
        },
        runAt: (timestamp: number, reference: unknown, args: Record<string, unknown>) => {
          const id = randomUUID();
          this.db.enqueueJob(id, timestamp, functionPath(reference), args ?? {});
          return id;
        },
      },
      storage: {
        generateUploadUrl: () => `${baseUrl}/local/storage/upload?id=${randomUUID()}`,
        getUrl: (id: string) => `${baseUrl}/local/storage/${id}`,
        delete: (id: string) => {
          const target = path.join(storageDir(), id.replace(/[^\w.-]/g, ""));
          if (fs.existsSync(target)) fs.unlinkSync(target);
        },
        store: (id: string, body: Uint8Array) => {
          fs.mkdirSync(storageDir(), { recursive: true });
          fs.writeFileSync(path.join(storageDir(), id.replace(/[^\w.-]/g, "")), body);
        },
        read: (id: string): Uint8Array | null => {
          const target = path.join(storageDir(), id.replace(/[^\w.-]/g, ""));
          return fs.existsSync(target) ? new Uint8Array(fs.readFileSync(target)) : null;
        },
      },
      auth: { getUserIdentity: async () => identity },
      kind,
    };
  }

  async execute(
    functionRef: string,
    args: Record<string, unknown> = {},
    identity?: { subject: string } | null
  ): Promise<any> {
    const current = this.executionContext.getStore();
    if (current) {
      if (identity !== undefined) current.identity = identity;
      if (current.lockHeld) return this.executeWithinContext(functionRef, args, current);
      const fn = getFunction(functionRef);
      if (fn.kind !== "query" && fn.kind !== "internalQuery" && fn.kind !== "mutation" && fn.kind !== "internalMutation") {
        return this.executeWithinContext(functionRef, args, current);
      }
      return this.withExecutionLock(async () => {
        current.lockHeld = true;
        try {
          return await this.executeWithinContext(functionRef, args, current);
        } finally {
          current.lockHeld = false;
        }
      });
    }

    const fn = getFunction(functionRef);
    const context = {
      lockHeld: false,
      transactionOpen: false,
      identity: identity ?? null,
    };
    const run = () => this.executionContext.run(context, () => this.executeWithinContext(functionRef, args, context));
    if (fn.kind === "query" || fn.kind === "internalQuery" || fn.kind === "mutation" || fn.kind === "internalMutation") {
      return this.withExecutionLock(async () => {
        context.lockHeld = true;
        try {
          return await run();
        } finally {
          context.lockHeld = false;
        }
      });
    }
    return run();
  }

  private async withExecutionLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.executionTail;
    let release!: () => void;
    this.executionTail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async executeWithinContext(
    functionRef: string,
    args: Record<string, unknown>,
    context: { lockHeld: boolean; transactionOpen: boolean; identity: { subject: string } | null }
  ): Promise<any> {
    const fn = getFunction(functionRef);
    const errors = validateArgs(args, fn.definition.args);
    if (errors.length > 0) throw new Error(`Invalid arguments for ${functionRef}: ${errors.join("; ")}`);
    const ctx = this.context(fn.kind);
    const handler = typeof fn.definition === "function" ? fn.definition : fn.definition.handler;
    const run = () => handler(ctx, args);
    if (fn.kind === "mutation" || fn.kind === "internalMutation") {
      if (context.transactionOpen) return await run();
      context.transactionOpen = true;
      try {
        return await this.db.transactionAsync(run);
      } finally {
        context.transactionOpen = false;
      }
    }
    return await run();
  }

  async runDueJobs(): Promise<number> {
    const rows = this.db.listDueJobs(50);
    await Promise.all(
      rows.map((row) => {
        this.db.setJobStatus(row.id, "running");
        return this.execute(row.path, JSON.parse(row.args))
          .catch((error) => {
            this.db.setJobStatus(row.id, "failed");
            console.error(`[local] scheduled job ${row.path} failed:`, error);
          })
          .finally(() => {
            this.db.deleteJob(row.id);
          });
      })
    );
    return rows.length;
  }
}
