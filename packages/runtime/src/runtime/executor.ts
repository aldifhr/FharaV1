import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
  constructor(readonly db: LocalDatabase) {}

  context(kind: string): any {
    const executor = this;
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
      auth: { getUserIdentity: async () => null },
      kind,
    };
  }

  async execute(functionRef: string, args: Record<string, unknown> = {}): Promise<any> {
    const fn = getFunction(functionRef);
    const errors = validateArgs(args, fn.definition.args);
    if (errors.length > 0) throw new Error(`Invalid arguments for ${functionRef}: ${errors.join("; ")}`);
    const ctx = this.context(fn.kind);
    const handler = typeof fn.definition === "function" ? fn.definition : fn.definition.handler;
    const run = () => handler(ctx, args);
    if (fn.kind === "mutation" || fn.kind === "internalMutation") {
      let result: unknown;
      this.db.transaction(() => {
        result = run();
      });
      return await result;
    }
    return await run();
  }

  runDueJobs(): number {
    const rows = this.db.listDueJobs(50);
    let ran = 0;
    for (const row of rows) {
      this.db.setJobStatus(row.id, "running");
      void this.execute(row.path, JSON.parse(row.args))
        .catch((error) => {
          this.db.setJobStatus(row.id, "failed");
          console.error(`[local] scheduled job ${row.path} failed:`, error);
        })
        .finally(() => {
          this.db.deleteJob(row.id);
          ran++;
        });
    }
    return ran;
  }
}
