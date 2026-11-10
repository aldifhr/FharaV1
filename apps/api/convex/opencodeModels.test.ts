/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { internal } from "./_generated/api";
import schema from "./schema";
import { normalizeCatalogModels } from "./opencodeModels";

const modules = import.meta.glob("./**/*.ts");

describe("opencode model catalog", () => {
  test("the report upserts per worker and the list returns the freshest one", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.opencodeModels.report, {
      workerId: "w1",
      hostname: "alpha",
      models: ["opencode/minimax-m3.1-flash-free", "9router/muse"],
      available: true,
      command: "opencode",
    });
    await t.mutation(internal.opencodeModels.report, {
      workerId: "w2",
      hostname: "beta",
      models: ["opencode/beam-free"],
      available: true,
      command: "opencode",
    });

    const listed = await t.query(api.opencodeModels.list, {});
    expect(listed.reportedWorkers).toBe(2);
    expect(listed.available).toBe(true);
    expect(listed.models.length).toBe(1);
    expect(listed.workerId).toBe("w2");

    // A second report from the same worker replaces the row, it does not add one.
    await t.mutation(internal.opencodeModels.report, {
      workerId: "w1",
      models: ["opencode/inkling-2-small-free"],
      available: true,
    });
    const rows = await t.run((ctx) => ctx.db.query("opencodeModelCatalog").collect());
    expect(rows.length).toBe(2);
    const w1 = rows.find((row) => row.workerId === "w1");
    expect(w1?.models).toEqual(["opencode/inkling-2-small-free"]);
  });

  test("a refresh request is visible to the worker and cleared by the next report", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.opencodeModels.report, {
      workerId: "w1",
      models: ["opencode/beam-free"],
      available: true,
    });

    let state = await t.query(internal.opencodeModels.state, { workerId: "w1" });
    expect(state.hasCatalog).toBe(true);
    expect(state.refreshRequestedAt).toBe(0);

    const requested = await t.mutation(api.opencodeModels.requestRefresh, {});
    expect(requested.requested).toBe(1);

    state = await t.query(internal.opencodeModels.state, { workerId: "w1" });
    expect(state.refreshRequestedAt).toBeGreaterThan(0);
    // The request may land in the same millisecond as the report.
    expect(state.refreshRequestedAt).toBeGreaterThanOrEqual(state.updatedAt);

    await t.mutation(internal.opencodeModels.report, {
      workerId: "w1",
      models: ["opencode/beam-free"],
      available: true,
    });
    state = await t.query(internal.opencodeModels.state, { workerId: "w1" });
    expect(state.refreshRequestedAt).toBe(0);
  });

  test("an unavailable CLI is reported with its error, not as an empty list", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.opencodeModels.report, {
      workerId: "w1",
      models: [],
      available: false,
      error: "spawn opencode ENOENT",
    });
    const listed = await t.query(api.opencodeModels.list, {});
    expect(listed.available).toBe(false);
    expect(listed.error).toBe("spawn opencode ENOENT");
    expect(listed.models).toEqual([]);
  });

  test("no report yet is an empty catalog, not a crash", async () => {
    const t = convexTest(schema, modules);
    const listed = await t.query(api.opencodeModels.list, {});
    expect(listed.reportedWorkers).toBe(0);
    expect(listed.models).toEqual([]);
    expect(listed.available).toBe(false);
    expect(listed.workerId).toBeNull();
  });

  test("normalizeCatalogModels keeps provider/model ids only", () => {
    expect(
      normalizeCatalogModels([
        " opencode/beam-free ",
        "opencode/beam-free",
        "no-slash",
        "",
        "openrouter/anthropic/claude-sonnet-4",
      ])
    ).toEqual(["opencode/beam-free", "openrouter/anthropic/claude-sonnet-4"]);
    expect(normalizeCatalogModels(["a/b", "a/b", "a/b"]).length).toBe(1);
  });
});
