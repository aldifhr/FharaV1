/**
 * The worker's `tasks.direct` state patch (threadbear T2), shared by
 * directThreads.appendEvents and its token-gated wrapper in worker.ts.
 * Moved out of directThreads.ts; D8 adds the goal patch (lib/directGoalSchema.ts).
 */
import { v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { applyGoalPatch, goalWorkerPatchValidator } from "./directGoalSchema";

export const directStatusValidator = v.union(
  v.literal("idle"),
  v.literal("starting"),
  v.literal("running"),
  v.literal("waiting"),
  v.literal("stopped"),
  v.literal("error")
);

export const directEngineValidator = v.union(v.literal("opencode-acp"), v.literal("api-loop"));

export const directPatchValidator = v.object({
  status: v.optional(directStatusValidator),
  sessionId: v.optional(v.union(v.string(), v.null())),
  turnId: v.optional(v.union(v.string(), v.null())),
  engine: v.optional(directEngineValidator),
  deliveredSeq: v.optional(v.number()),
  idleSince: v.optional(v.union(v.number(), v.null())),
  error: v.optional(v.union(v.string(), v.null())),
  stoppedMidTurn: v.optional(v.boolean()),
  allowRules: v.optional(v.array(v.string())),
  mcpSetHash: v.optional(v.string()),
  goal: v.optional(goalWorkerPatchValidator),
});

export type DirectPatch = Infer<typeof directPatchValidator>;

export function applyDirectPatch(direct: NonNullable<Doc<"tasks">["direct"]>, patch: DirectPatch, lastSeq: number, now = Date.now()) {
  const next = { ...direct, lastSeq: Math.max(direct.lastSeq, lastSeq) };
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.engine !== undefined) next.engine = patch.engine;
  if (patch.deliveredSeq !== undefined) next.deliveredSeq = Math.max(direct.deliveredSeq ?? 0, patch.deliveredSeq);
  if (patch.sessionId !== undefined) next.sessionId = patch.sessionId ?? undefined;
  if (patch.turnId !== undefined) next.turnId = patch.turnId ?? undefined;
  if (patch.idleSince !== undefined) next.idleSince = patch.idleSince ?? undefined;
  if (patch.error !== undefined) next.error = patch.error ? patch.error.slice(0, 1000) : undefined;
  if (patch.stoppedMidTurn !== undefined) next.stoppedMidTurn = patch.stoppedMidTurn;
  if (patch.allowRules !== undefined) next.allowRules = patch.allowRules.slice(-50);
  if (patch.mcpSetHash !== undefined) next.mcpSetHash = patch.mcpSetHash.slice(0, 64);
  if (patch.goal !== undefined) next.goal = applyGoalPatch(direct.goal, patch.goal, now);
  return next;
}
