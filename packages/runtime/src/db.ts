import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import {
  columnFor,
  fieldKinds,
  quoteIdentifier,
  tableMeta,
  tableNames,
  type StorageKind,
} from "./schemaMeta";

export interface LocalDoc {
  _id: string;
  _creationTime: number;
  [key: string]: any;
}

export function defaultDbPath(): string {
  if (process.env.FHARA_DB_PATH) return process.env.FHARA_DB_PATH;
  return path.join(os.homedir(), ".fhara", "fhara.db");
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("SQLITE_BUSY") || message.includes("database is locked");
}

type SqlValue = string | number | bigint | Uint8Array | null;

function encode(value: unknown, kind: StorageKind): SqlValue {
  if (value === undefined || value === null) return null;
  if (kind === "json") return JSON.stringify(value);
  if (kind === "number") return Number(value);
  if (kind === "integer") return typeof value === "boolean" ? (value ? 1 : 0) : Number(value);
  return String(value);
}

function decode(raw: unknown, kind: StorageKind): unknown {
  if (raw === null || raw === undefined) return undefined;
  if (kind === "json") {
    try {
      return JSON.parse(String(raw));
    } catch {
      return undefined;
    }
  }
  if (kind === "integer") return raw === 1 || raw === "true" ? true : Number(raw);
  if (kind === "number") return Number(raw);
  return String(raw);
}

function plain(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row };
}

export class LocalDatabase {
  private depth = 0;
  readonly orm: BetterSQLite3Database;

  constructor(
    readonly sqlite: Database.Database,
    readonly filePath: string
  ) {
    this.orm = drizzle(sqlite);
  }

  close(): void {
    this.sqlite.close();
  }

  enqueueJob(id: string, runAt: number, functionPath: string, args: Record<string, unknown>): void {
    this.orm.run(
      sql`INSERT INTO local_jobs (id, runAt, path, args, status) VALUES (${id}, ${runAt}, ${functionPath}, ${JSON.stringify(args)}, 'queued')`
    );
  }

  listDueJobs(limit = 50): Array<{ id: string; path: string; args: string }> {
    return this.orm.all<{ id: string; path: string; args: string }>(
      sql`SELECT id, path, args FROM local_jobs WHERE status = 'queued' AND runAt <= ${Date.now()} ORDER BY runAt LIMIT ${limit}`
    ) as Array<{ id: string; path: string; args: string }>;
  }

  setJobStatus(id: string, status: string): void {
    this.orm.run(sql`UPDATE local_jobs SET status = ${status} WHERE id = ${id}`);
  }

  deleteJob(id: string): void {
    this.orm.run(sql`DELETE FROM local_jobs WHERE id = ${id}`);
  }

  version(): number {
    const row = this.orm.get<Record<string, unknown>>(
      sql`SELECT value FROM local_meta WHERE key = 'changeVersion'`
    ) as Record<string, unknown> | undefined;
    return row ? Number(row.value) : 0;
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return this.orm.transaction(() => {
          this.depth++;
          try {
            return fn();
          } finally {
            this.depth--;
          }
        });
      } catch (error) {
        if (isBusy(error) && attempt < 5) {
          sleep(20 * (attempt + 1));
          continue;
        }
        throw error;
      }
    }
    throw new Error("SQLite transaction could not be started");
  }

  private bumpVersion(): void {
    this.orm.run(
      sql`UPDATE local_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'changeVersion'`
    );
  }

  get(table: string, id: string): LocalDoc | null {
    const meta = tableMeta(table);
    const kinds = fieldKinds(table);
    const row = this.orm.get<Record<string, unknown>>(
      sql`SELECT * FROM ${sql.raw(quoteIdentifier(table))} WHERE id = ${id}`
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToDoc(meta.name, plain(row), kinds);
  }

  all(table: string): LocalDoc[] {
    const meta = tableMeta(table);
    const kinds = fieldKinds(table);
    const rows = this.orm.all<Record<string, unknown>>(sql.raw(
      `SELECT * FROM ${quoteIdentifier(table)}`
    )) as Record<string, unknown>[];
    return rows.map((row) => this.rowToDoc(meta.name, plain(row), kinds));
  }

  insert(table: string, value: Record<string, unknown>): string {
    return this.transaction(() => this.insertRaw(table, value));
  }

  insertRaw(table: string, value: Record<string, unknown>): string {
    const meta = tableMeta(table);
    const id = String(value._id ?? `${table}:${Date.now().toString(36)}:${randomUUID()}`);
    const createdAt = Number(value._creationTime ?? Date.now());
    const known = new Set(meta.fields.map((field) => field.name));
    const extra: Record<string, unknown> = {};
    const columns = ["id", "_creationTime", ...meta.fields.map((field) => quoteIdentifier(field.name)), "extra"];
    const values: SqlValue[] = [id, createdAt];
    for (const field of meta.fields) values.push(encode(value[field.name], field.kind));
    for (const [key, fieldValue] of Object.entries(value)) {
      if (key === "_id" || key === "_creationTime" || known.has(key)) continue;
      extra[key] = fieldValue;
    }
    values.push(JSON.stringify(extra));
    this.orm.run(
      sql`INSERT INTO ${sql.raw(quoteIdentifier(table))} (${sql.raw(columns.join(", "))}) VALUES (${sql.join(values.map((value) => sql`${value}`), sql`, `)})`
    );
    this.writeFts(table, id, value);
    this.bumpVersion();
    return id;
  }

  patch(table: string, id: string, patch: Record<string, unknown>): boolean {
    return this.transaction(() => this.patchRaw(table, id, patch));
  }

  patchRaw(table: string, id: string, patch: Record<string, unknown>): boolean {
    const current = this.get(table, id);
    if (!current) return false;
    this.replaceRaw(table, id, { ...current, ...patch });
    return true;
  }

  replace(table: string, id: string, value: Record<string, unknown>): boolean {
    return this.transaction(() => this.replaceRaw(table, id, value));
  }

  replaceRaw(table: string, id: string, value: Record<string, unknown>): boolean {
    const meta = tableMeta(table);
    const exists = this.orm.get(
      sql`SELECT 1 FROM ${sql.raw(quoteIdentifier(table))} WHERE id = ${id}`
    );
    if (!exists) return false;
    const known = new Set(meta.fields.map((field) => field.name));
    const extra: Record<string, unknown> = {};
    const pairs: Array<[string, SqlValue]> = [];
    for (const field of meta.fields) {
      pairs.push([quoteIdentifier(field.name), encode(value[field.name], field.kind)]);
    }
    for (const [key, fieldValue] of Object.entries(value)) {
      if (key === "_id" || key === "_creationTime" || known.has(key)) continue;
      extra[key] = fieldValue;
    }
    pairs.push(["extra", JSON.stringify(extra)]);
    this.orm.run(
      sql`UPDATE ${sql.raw(quoteIdentifier(table))} SET ${sql.join(pairs.map(([column, fieldValue]) => sql`${sql.raw(column)} = ${fieldValue}`), sql`, `)} WHERE id = ${id}`
    );
    const row = this.orm.get(
      sql`SELECT * FROM ${sql.raw(quoteIdentifier(table))} WHERE id = ${id}`
    ) as Record<string, unknown>;
    this.writeFts(table, id, this.rowToDoc(meta.name, plain(row), fieldKinds(table)));
    this.bumpVersion();
    return true;
  }

  delete(table: string, id: string): boolean {
    return this.transaction(() => this.deleteRaw(table, id));
  }

  deleteRaw(table: string, id: string): boolean {
    const meta = tableMeta(table);
    const result = this.orm.run(
      sql`DELETE FROM ${sql.raw(quoteIdentifier(table))} WHERE id = ${id}`
    ) as unknown as { changes: number };
    for (const index of meta.searchIndexes) {
      this.orm.run(
        sql`DELETE FROM ${sql.raw(quoteIdentifier(`fts_${table}_${index.name}`))} WHERE ref = ${id}`
      );
    }
    if (result.changes > 0) this.bumpVersion();
    return result.changes > 0;
  }

  search(table: string, indexName: string, term: string): string[] {
    const meta = tableMeta(table);
    const index = meta.searchIndexes.find((entry) => entry.name === indexName);
    if (!index) throw new Error(`Unknown search index ${table}.${indexName}`);
    const fts = quoteIdentifier(`fts_${table}_${indexName}`);
    const rows = this.orm.all<Record<string, unknown>>(
      sql`SELECT ref FROM ${sql.raw(fts)} WHERE ${sql.raw(fts)} MATCH ${term}`
    ) as Record<string, unknown>[];
    return rows.map((row) => String(row.ref));
  }

  private writeFts(table: string, id: string, doc: Record<string, unknown>): void {
    for (const index of tableMeta(table).searchIndexes) {
      const fts = quoteIdentifier(`fts_${table}_${index.name}`);
      this.orm.run(sql`DELETE FROM ${sql.raw(fts)} WHERE ref = ${id}`);
      const columns = ["ref", index.searchField, ...index.filterFields];
      const values = [id, doc[index.searchField], ...index.filterFields.map((field) => doc[field])];
      this.orm.run(
        sql`INSERT INTO ${sql.raw(fts)} (${sql.raw(columns.map(quoteIdentifier).join(", "))}) VALUES (${sql.join(values.map((value) => sql`${value === undefined ? null : String(value)}`), sql`, `)})`
      );
    }
  }

  private rowToDoc(table: string, row: Record<string, unknown>, kinds: Map<string, StorageKind>): LocalDoc {
    const doc: LocalDoc = { _id: String(row.id), _creationTime: Number(row._creationTime) };
    for (const [field, kind] of kinds) {
      const value = decode(row[field], kind);
      if (value !== undefined) doc[field] = value;
    }
    if (typeof row.extra === "string") {
      try {
        Object.assign(doc, JSON.parse(row.extra));
      } catch {
        // a corrupt extra column must not hide the rest of the document
      }
    }
    return doc;
  }
}

export function openLocalDatabase(filePath = defaultDbPath()): LocalDatabase {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  const orm = drizzle(sqlite);
  orm.run(sql`CREATE TABLE IF NOT EXISTS local_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  orm.run(sql`INSERT OR IGNORE INTO local_meta (key, value) VALUES ('changeVersion', '0')`);
  orm.run(
    sql`CREATE TABLE IF NOT EXISTS local_jobs (id TEXT PRIMARY KEY, runAt INTEGER NOT NULL, path TEXT NOT NULL, args TEXT NOT NULL, status TEXT NOT NULL)`
  );

  for (const table of tableNames()) {
    const meta = tableMeta(table);
    const columns = ['"id" TEXT PRIMARY KEY', '"_creationTime" INTEGER NOT NULL'];
    for (const field of meta.fields) {
      const type = field.kind === "number" ? "REAL" : field.kind === "integer" ? "INTEGER" : "TEXT";
      columns.push(`${quoteIdentifier(field.name)} ${type}`);
    }
    columns.push('"extra" TEXT');
    orm.run(sql.raw(`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table)} (${columns.join(", ")})`));

    for (const index of meta.indexes) {
      const fields = index.fields.map(columnFor).map(quoteIdentifier).join(", ");
      orm.run(
        sql.raw(
          `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`idx_${table}_${index.name}`)} ON ${quoteIdentifier(table)} (${fields})`
        )
      );
    }
    for (const index of meta.searchIndexes) {
      const columns = ["ref", index.searchField, ...index.filterFields];
      orm.run(
        sql.raw(
          `CREATE VIRTUAL TABLE IF NOT EXISTS ${quoteIdentifier(`fts_${table}_${index.name}`)} USING fts5(${columns.map((column) => (column === index.searchField ? quoteIdentifier(column) : `${quoteIdentifier(column)} UNINDEXED`)).join(", ")})`
        )
      );
    }
  }

  return new LocalDatabase(sqlite, filePath);
}
