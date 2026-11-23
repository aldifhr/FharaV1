import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLocalDatabase } from "../src/db";
import { v } from "../src/compat/values";
import { LocalExecutor } from "../src/runtime/executor";
import { isPublicEndpoint, markFunction, registerModules } from "../src/runtime/registry";

const files: string[] = [];
const executors: LocalExecutor[] = [];

function setup() {
  const file = path.join(os.tmpdir(), `fhara-executor-${Date.now()}-${Math.random()}.db`);
  files.push(file);
  const db = openLocalDatabase(file);
  const executor = new LocalExecutor(db);
  executors.push(executor);
  registerModules({
    executorRegression: {
      claim: markFunction(
        {
          args: { workerId: v.string() },
          handler: async (ctx: any, args: { workerId: string }) => {
            const row = await ctx.db.query("tasks").withIndex("by_status", (q: any) => q.eq("status", "queued")).first();
            if (!row) return null;
            await new Promise((resolve) => setTimeout(resolve, 5));
            await ctx.db.patch(row._id, { status: "running", workerId: args.workerId });
            return row._id;
          },
        },
        "internalMutation"
      ),
      outer: markFunction(
        {
          args: {},
          handler: async (ctx: any) => {
            await ctx.db.insert("projects", { name: "outer", workspacePath: "/tmp" });
            await ctx.runMutation("executorRegression:inner", {});
            return true;
          },
        },
        "internalMutation"
      ),
      inner: markFunction(
        {
          args: {},
          handler: async (ctx: any) => {
            await ctx.db.insert("projects", { name: "inner", workspacePath: "/tmp" });
          },
        },
        "internalMutation"
      ),
      rollback: markFunction(
        {
          args: {},
          handler: async (ctx: any) => {
            await ctx.db.insert("projects", { name: "rollback", workspacePath: "/tmp" });
            await Promise.resolve();
            throw new Error("expected failure");
          },
        },
        "internalMutation"
      ),
      publicAction: markFunction({ args: {}, handler: () => true }, "action"),
    },
  });
  return { db, executor };
}

afterEach(() => {
  for (const executor of executors.splice(0)) executor.db.close();
  for (const file of files.splice(0)) fs.rmSync(file, { force: true });
});

describe("async mutation isolation", () => {
  it("does not expose internal functions through public HTTP endpoints", () => {
    setup();
    expect(isPublicEndpoint("executorRegression:claim", "mutation")).toBe(false);
    expect(isPublicEndpoint("executorRegression:publicAction", "action")).toBe(true);
  });

  it("keeps asynchronous nested mutations in the outer transaction", async () => {
    const { db, executor } = setup();
    await executor.execute("executorRegression:outer");
    expect(db.all("projects").map((row) => row.name).sort()).toEqual(["inner", "outer"]);
  });

  it("rolls back writes when an async mutation rejects", async () => {
    const { db, executor } = setup();
    await expect(executor.execute("executorRegression:rollback")).rejects.toThrow("expected failure");
    expect(db.all("projects")).toHaveLength(0);
  });

  it("serializes overlapping read-modify-write mutations", async () => {
    const { db, executor } = setup();
    const taskId = db.insert("tasks", { title: "one", command: "run", status: "queued" });
    const [a, b] = await Promise.all([
      executor.execute("executorRegression:claim", { workerId: "a" }),
      executor.execute("executorRegression:claim", { workerId: "b" }),
    ]);
    expect([a, b].filter(Boolean)).toEqual([taskId]);
  });
});
