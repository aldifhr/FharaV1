/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { configuredProjectScript, isProjectScriptAllowed, parseProjectScriptLine } from "./lib/projectScriptsSchema";

const modules = import.meta.glob("./**/*.ts");

// GOAT G9 / threadbear T6: one `projects.scripts` field, exact argv only.
describe("project scripts", () => {
  test("the allowlist is exact argv: no prefixes, no extra arguments, no shell", () => {
    expect(isProjectScriptAllowed("check", ["npm", "run", "test"])).toBe(true);
    expect(isProjectScriptAllowed("check", ["npm", "run", "test", "--", "-u"])).toBe(false);
    expect(isProjectScriptAllowed("setup", ["npm", "run", "test"])).toBe(false);
    expect(parseProjectScriptLine("setup", "npm ci && curl x")).toBeNull();
    expect(parseProjectScriptLine("check", "")).toBeNull();
    expect(configuredProjectScript({ check: ["npm", "test"] }, "check")).toEqual(["npm", "test"]);
    // A stored entry that is no longer allowlisted is treated as not configured.
    expect(configuredProjectScript({ check: ["rm", "-rf", "/"] }, "check")).toBeNull();
    expect(configuredProjectScript(undefined, "setup")).toBeNull();
  });

  test("projectScripts.set stores, keeps the other script, clears with \"\" and refuses off-list commands", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.mutation(api.projects.create, { name: "P", workspacePath: "/tmp/p" });
    const read = async () => (await t.run(async (ctx) => ctx.db.get(projectId)))?.scripts;

    await t.mutation(api.projectScripts.set, { projectId, setup: "npm ci" });
    expect(await read()).toEqual({ setup: ["npm", "ci"] });
    await t.mutation(api.projectScripts.set, { projectId, check: "npm run test" });
    expect(await read()).toEqual({ setup: ["npm", "ci"], check: ["npm", "run", "test"] });
    await t.mutation(api.projectScripts.set, { projectId, setup: "" });
    expect(await read()).toEqual({ check: ["npm", "run", "test"] });
    await expect(t.mutation(api.projectScripts.set, { projectId, check: "npm run test; rm -rf /" })).rejects.toThrow(
      /not on the allowed list/
    );
    expect(await read()).toEqual({ check: ["npm", "run", "test"] });
    await t.mutation(api.projectScripts.set, { projectId, check: "" });
    expect(await read()).toBeUndefined();
  });
});
