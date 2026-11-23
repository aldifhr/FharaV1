import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLocalDatabase, type LocalDatabase } from "../src/db";
import { LocalQuery } from "../src/runtime/queryBuilder";

let dir: string;
let db: LocalDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fhara-query-builder-"));
  db = openLocalDatabase(path.join(dir, "fhara.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("local query filters", () => {
  it("compares fields with literal strings and undefined", async () => {
    db.insert("skills", { name: "Built in", builtin: undefined });
    db.insert("skills", { name: "Custom", builtin: false });
    db.insert("messages", { voice: "system" });
    db.insert("messages", { voice: "user" });

    const builtin = await new LocalQuery(db, "skills")
      .filter((q) => q.eq(q.field("builtin"), undefined))
      .collect();
    const system = await new LocalQuery(db, "messages")
      .filter((q) => q.eq(q.field("voice"), "system"))
      .collect();

    expect(builtin.map((doc) => doc.name)).toEqual(["Built in"]);
    expect(system.map((doc) => doc.voice)).toEqual(["system"]);
  });

  it("supports field-to-field comparison and literal ordering values", async () => {
    db.insert("tasks", { title: "matches", updatedAt: 2, createdAt: 2 });
    db.insert("tasks", { title: "does not match", updatedAt: 1, createdAt: 2 });

    const rows = await new LocalQuery(db, "tasks")
      .filter((q) => q.eq(q.field("updatedAt"), q.field("createdAt")))
      .filter((q) => q.gt(q.field("updatedAt"), 1))
      .collect();

    expect(rows.map((doc) => doc.title)).toEqual(["matches"]);
  });
});
