import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { AcceptanceGate } from "./subtaskContract";

/** Contract columns of a subtask definition (plan 022); absent fields stay absent. */
export function contractDefinition(subtask: {
  objective?: string;
  constraints?: string[];
  deliverable?: string;
  acceptance?: AcceptanceGate[];
}): Pick<Doc<"subtasks">, "objective" | "constraints" | "deliverable" | "acceptance"> {
  return {
    objective: subtask.objective,
    constraints: subtask.constraints,
    deliverable: subtask.deliverable,
    acceptance: subtask.acceptance,
  };
}

/**
 * Write one plan version: replaces the task's plan row, reconciles subtask
 * rows (core M5 replan semantics) and logs `plan.created`. Shared by the
 * worker's `savePlan` (after its lease check) and the Plan Inspector's user
 * edits (`planReview.editPlan`), so both produce identical rows.
 */
export interface PlanVersionInput {
  taskId: Id<"tasks">;
  projectId: Id<"projects">;
  version: number;
  strategy: string;
  createdBy: "orchestrator" | "fallback" | "user";
  goal: string;
  payload: unknown;
  subtasks: Array<{
    key: string;
    title: string;
    description: string;
    kind: Doc<"subtasks">["kind"];
    capability: string;
    dependencies: string[];
    order: number;
    allowedPaths?: string[];
    origin?: string;
    reviewRound?: number;
    objective?: string;
    constraints?: string[];
    deliverable?: string;
    acceptance?: AcceptanceGate[];
  }>;
  degradedReason?: string;
  estimate?: unknown;
  /** User edits: the version this one was edited from. */
  editedFrom?: number;
}

export async function writePlanVersion(ctx: MutationCtx, args: PlanVersionInput): Promise<number> {
    const now = Date.now();
    const existing = await ctx.db
      .query("plans")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    // A replan carries the first estimate forward (marked), so the runs page
    // can still compare the estimate the run started with to its actual.
    const priorEstimate = existing
      .slice()
      .sort((a, b) => b.version - a.version)
      .map((plan) => plan.estimate)
      .find((estimate) => estimate && typeof estimate === "object");
    for (const plan of existing) await ctx.db.delete(plan._id);
    const estimate =
      args.estimate !== undefined
        ? args.estimate
        : priorEstimate
          ? { ...(priorEstimate as Record<string, unknown>), carriedOver: true }
          : undefined;

    await ctx.db.insert("plans", {
      taskId: args.taskId,
      projectId: args.projectId,
      version: args.version,
      strategy: args.strategy,
      createdBy: args.createdBy,
      goal: args.goal,
      payload: args.payload,
      ...(args.degradedReason ? { degradedReason: args.degradedReason } : {}),
      ...(estimate !== undefined ? { estimate } : {}),
      createdAt: now,
    });

    // Replan semantics (core M5): rows whose key persists into the new plan
    // are UPDATED IN PLACE — their definition follows the new plan, but a
    // finished row (completed/skipped) keeps its status, output and
    // timestamps, so the dashboard does not show finished work as pending
    // and a crash after the replan does not re-execute (and re-pay for)
    // carried work. Their _id is kept, so executions.subtaskId stays valid.
    // Unfinished rows go back to pending; rows dropped by the new plan are
    // deleted.
    const oldSubtasks = await ctx.db
      .query("subtasks")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    const oldByKey = new Map<string, Doc<"subtasks">>();
    for (const row of oldSubtasks) {
      if (oldByKey.has(row.key)) {
        // Duplicate key rows (legacy data): keep one.
        await ctx.db.delete(row._id);
        continue;
      }
      oldByKey.set(row.key, row);
    }
    const newKeys = new Set(args.subtasks.map((subtask) => subtask.key));
    for (const [key, row] of oldByKey) {
      if (!newKeys.has(key)) await ctx.db.delete(row._id);
    }

    const preserved: string[] = [];
    for (const subtask of args.subtasks) {
      const definition = {
        title: subtask.title,
        description: subtask.description,
        kind: subtask.kind,
        capability: subtask.capability,
        dependencies: subtask.dependencies,
        order: subtask.order,
        allowedPaths: subtask.allowedPaths,
        reviewRound: subtask.reviewRound,
        ...contractDefinition(subtask),
        ...(subtask.origin !== undefined ? { origin: subtask.origin } : {}),
      };
      const prior = oldByKey.get(subtask.key);
      if (prior) {
        if (prior.status === "completed" || prior.status === "skipped") {
          await ctx.db.patch(prior._id, definition);
          preserved.push(subtask.key);
        } else {
          await ctx.db.patch(prior._id, {
            ...definition,
            status: "pending",
            attempts: 0,
            error: undefined,
            startedAt: undefined,
            completedAt: undefined,
            // A new plan version re-opens acceptance for unfinished work.
            acceptanceStatus: undefined,
            acceptanceReason: undefined,
            gateResults: undefined,
            escalation: undefined,
          });
        }
        continue;
      }
      await ctx.db.insert("subtasks", {
        taskId: args.taskId,
        projectId: args.projectId,
        key: subtask.key,
        ...definition,
        status: "pending",
        attempts: 0,
      });
    }

    await ctx.db.patch(args.taskId, {
      planVersion: args.version,
      strategy: args.strategy,
      updatedAt: now,
      errorMessage: undefined,
      // A planner version consumes the pending "Replan with note" text.
      ...(args.createdBy !== "user" ? { planReviewNote: undefined } : {}),
    });
    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "plan.created",
      payload: {
        version: args.version,
        strategy: args.strategy,
        createdBy: args.createdBy,
        ...(args.editedFrom !== undefined ? { editedFrom: args.editedFrom } : {}),
        subtasks: args.subtasks.map((subtask) => subtask.key),
        ...(preserved.length > 0 ? { preservedCompleted: preserved } : {}),
      },
      level: "info",
    });
    return args.version;
}
