import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { observationsFromEvent, type ObservableEvent } from "./observations";

/**
 * Plan 025: derive the typed execution observations an event carries and
 * store them (`executionObservations`, by task). Deterministic and
 * best-effort: an event that maps to nothing writes nothing.
 */
export async function recordObservationsForEvent(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  projectId: Id<"projects">,
  event: ObservableEvent
): Promise<number> {
  const observations = observationsFromEvent(event);
  for (const observation of observations) {
    await ctx.db.insert("executionObservations", { taskId, projectId, ...observation });
  }
  return observations.length;
}
