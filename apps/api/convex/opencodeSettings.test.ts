/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("app-wide OpenCode runtime", () => {
  test("unset reads as the built-in runtime and is not configured", async () => {
    const t = convexTest(schema, modules);
    const settings = await t.query(api.opencodeSettings.get, {});
    expect(settings).toEqual({ runtime: "api", model: "", configured: false });
  });

  test("set stores the runtime and the model, and reads them back", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.opencodeSettings.set, {
      runtime: "opencode",
      model: " opencode/beam-free ",
    });
    const settings = await t.query(api.opencodeSettings.get, {});
    expect(settings).toEqual({
      runtime: "opencode",
      model: "opencode/beam-free",
      configured: true,
    });

    // A second set upserts the same row.
    await t.mutation(api.opencodeSettings.set, { runtime: "api" });
    const rows = await t.run((ctx) => ctx.db.query("opencodeSettings").collect());
    expect(rows.length).toBe(1);
    const after = await t.query(api.opencodeSettings.get, {});
    expect(after.runtime).toBe("api");
    expect(after.model).toBe("");
  });

  test("an invalid model id is refused", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.opencodeSettings.set, { runtime: "opencode", model: "no slash here" })
    ).rejects.toThrow(/provider\/model/);
  });

  test("refuses an anonymous write once the deployment is owned", async () => {
    const t = convexTest(schema, modules);
    // Local single-user mode: no owned project, so the guard is a no-op.
    await t.mutation(api.opencodeSettings.set, { runtime: "opencode", model: "opencode/beam-free" });
    await t.run(async (ctx) => {
      await ctx.db.insert("projects", { name: "P", workspacePath: "/tmp/p", ownerId: "owner-1" });
    });
    await expect(
      t.mutation(api.opencodeSettings.set, { runtime: "api" })
    ).rejects.toThrow(/sign in/i);
    expect((await t.query(api.opencodeSettings.get, {})).runtime).toBe("opencode");
  });

  test("the run context carries the setting only when it was written", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run((ctx) =>
      ctx.db.insert("projects", { name: "P", workspacePath: "p" })
    );
    const taskId = await t.run((ctx) =>
      ctx.db.insert("tasks", {
        projectId,
        title: "t",
        command: "c",
        status: "queued",
      })
    );

    let context = await t.query(internal.orchestration.getRunContext, { taskId });
    expect(context?.opencodeRuntime).toBeUndefined();
    expect(context?.opencodeModel).toBeUndefined();

    await t.mutation(api.opencodeSettings.set, {
      runtime: "opencode",
      model: "opencode/beam-free",
    });
    context = await t.query(internal.orchestration.getRunContext, { taskId });
    expect(context?.opencodeRuntime).toBe("opencode");
    expect(context?.opencodeModel).toBe("opencode/beam-free");
  });
});
