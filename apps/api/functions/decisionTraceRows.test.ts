/// <reference types="vite/client" />
import { runtimeTest } from "@fhara/runtime/test";
import { describe, expect, test } from "vitest";
import { api } from "@fhara/runtime/api";
import schema from "./schema";
import { appendTaskEvent } from "./lib/taskEvents";
import { buildDecisionTrace, fallbackTrace } from "../../../packages/worker/src/orchestrator/decisionTrace";

const modules = import.meta.glob("./**/*.ts");

/** Production trace builder → real taskEvents rows in an in-memory SQLite DB. */
describe("decision trace rows contain no raw command", () => {
  test("every path writes an enum-only trace", async () => {
    const canary = `CANARY_${Date.now()}_9c1d`;
    const command = `Verify the preview URL ${canary}`;
    const t = runtimeTest(schema, modules);
    const { projectId, taskId } = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "Trace", workspacePath: "/tmp/trace" });
      const taskId = await ctx.db.insert("tasks", {
        projectId, title: "verify", command, status: "queued", updatedAt: Date.now(),
      });
      return { projectId, taskId };
    });

    const paths = [
      { source: "fast-path" as const, reasonCode: "UNAMBIGUOUS_SHAPE" as const, action: "execute" },
      { source: "llm" as const, reasonCode: "LLM_SCHEMA_VALID" as const, action: "delegate" },
      { source: "fallback" as const, reasonCode: "LLM_SCHEMA_INVALID" as const, action: "replan" },
      { source: "fallback" as const, reasonCode: "BUDGET_VETO" as const, action: "complete", fromCommand: true },
      { source: "validator-override" as const, reasonCode: "VALIDATOR_OVERRIDE" as const, action: "ask_user", proposedChoice: "code_change" },
    ];
    for (const [index, path] of paths.entries()) {
      await t.run(async (ctx) => {
        await appendTaskEvent(ctx, {
          taskId,
          projectId,
          type: "orchestrator.decision",
          payload: {
            trace: path.fromCommand
              ? fallbackTrace(command)
              : buildDecisionTrace({
                  stage: "decide",
                  choice: path.action,
                  source: path.source,
                  reasonCode: path.reasonCode,
                  ...(path.proposedChoice ? { proposedChoice: path.proposedChoice } : {}),
                }),
          },
        });
      });
      void index;
    }

    const rows = await t.query(api.taskEvents.listByTask, { taskId });
    expect(rows).toHaveLength(paths.length);
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(canary);
    expect(serialised).not.toContain(command);
  });
});
