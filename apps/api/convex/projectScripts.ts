import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { assertProjectAccess } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import {
  PROJECT_SCRIPT_KINDS,
  configuredProjectScript,
  parseProjectScriptLine,
  projectScriptLine,
  type ProjectScripts,
} from "./lib/projectScriptsSchema";

/**
 * GOAT G9 / threadbear T6: set or clear the project's setup and check
 * scripts. Each argument is a command line from the allowlist
 * (lib/projectScriptsSchema.ts); "" clears that script, an omitted
 * argument keeps it. Anything not on the exact-argv allowlist is refused.
 */
export const set = mutation({
  args: {
    projectId: v.id("projects"),
    setup: v.optional(v.string()),
    check: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const project = await assertProjectAccess(ctx, args.projectId);
    const next: ProjectScripts = {};
    for (const kind of PROJECT_SCRIPT_KINDS) {
      const line = args[kind];
      if (line === undefined) {
        const kept = configuredProjectScript(project.scripts, kind);
        if (kept) next[kind] = kept;
        continue;
      }
      if (line.trim() === "") continue;
      const argv = parseProjectScriptLine(kind, line);
      if (!argv) throw new Error(`${kind === "setup" ? "Setup" : "Check"} script is not on the allowed list: ${line}`);
      next[kind] = argv;
    }
    await ctx.db.patch(args.projectId, { scripts: next.setup || next.check ? next : undefined });
    await recordAudit(ctx, {
      action: "project.update",
      target: project.name,
      projectId: args.projectId,
      details: {
        changed: ["scripts"],
        setup: next.setup ? projectScriptLine(next.setup) : null,
        check: next.check ? projectScriptLine(next.check) : null,
      },
    });
    return next;
  },
});
