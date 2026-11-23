import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLocalDatabase, type LocalDatabase } from "../src/db";
import { tableMeta, tableNames } from "../src/schemaMeta";

let dir: string;
let file: string;
let db: LocalDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fhara-local-db-"));
  file = path.join(dir, "fhara.db");
  db = openLocalDatabase(file);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("schema metadata", () => {
  it("reads the live FharaRuntime schema", () => {
    expect(tableNames().length).toBeGreaterThan(60);
    expect(tableMeta("projects").indexes.map((index) => index.name)).toContain("by_owner");
    expect(tableMeta("tasks").searchIndexes[0]).toMatchObject({
      name: "search_title",
      searchField: "title",
    });
  });
});

describe("SQLite document store", () => {
  it("generates system fields and reads documents back", () => {
    const id = db.insert("projects", {
      name: "Demo",
      workspacePath: "D:/demo",
      ownerId: "user-1",
      customMarker: "kept",
    });
    const doc = db.get("projects", id);
    expect(doc?._id).toBe(id);
    expect(id.startsWith("projects:")).toBe(true);
    expect(typeof doc?._creationTime).toBe("number");
    expect(doc).toMatchObject({ name: "Demo", ownerId: "user-1", customMarker: "kept" });
  });

  it("patches documents and persists unknown fields", () => {
    const id = db.insert("projects", { name: "Demo", workspacePath: "D:/demo", extraFlag: 1 });
    expect(db.patch("projects", id, { name: "Renamed" })).toBe(true);
    expect(db.get("projects", id)).toMatchObject({ name: "Renamed", extraFlag: 1 });
    expect(db.patch("projects", "projects:missing", { name: "No" })).toBe(false);
  });

  it("supports the declared compound indexes", () => {
    db.insert("projects", { name: "A", workspacePath: "a", ownerId: "u1", createdAt: 10 });
    db.insert("projects", { name: "B", workspacePath: "b", ownerId: "u1", createdAt: 20 });
    db.insert("projects", { name: "C", workspacePath: "c", ownerId: "u2", createdAt: 30 });
    const rows = db.sqlite
      .prepare("SELECT name FROM projects WHERE ownerId = ? ORDER BY createdAt DESC")
      .all("u1") as { name: string }[];
    expect(rows.map((row) => row.name)).toEqual(["B", "A"]);
  });

  it("indexes the declared search field", () => {
    const id = db.insert("messages", {
      content: "banana milestone reached",
      authorType: "user",
      projectId: "p1",
    });
    expect(db.search("messages", "search_content", "banana")).toContain(id);
    expect(db.delete("messages", id)).toBe(true);
    expect(db.search("messages", "search_content", "banana")).not.toContain(id);
  });

  it("tracks a change version across reopen", () => {
    const before = db.version();
    const id = db.insert("projects", { name: "Persisted", workspacePath: "D:/persisted" });
    expect(db.version()).toBe(before + 1);
    db.close();
    db = openLocalDatabase(file);
    expect(db.version()).toBe(before + 1);
    expect(db.get("projects", id)?.name).toBe("Persisted");
  });
});
