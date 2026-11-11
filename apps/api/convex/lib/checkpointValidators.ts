/**
 * GOAT G5: the `checkpoints` table (one row per hidden-ref checkpoint of a
 * task worktree, lib/checkpointRefs.ts). Kept out of schema.ts, which is at
 * its line budget.
 */
import { v } from "convex/values";

/** One changed path since the previous checkpoint (`git diff --numstat -z`, vendor/goat/diffs.ts). */
export const checkpointFileValidator = v.object({
  path: v.string(),
  previousPath: v.optional(v.string()),
  additions: v.number(),
  deletions: v.number(),
});

export const checkpointKindValidator = v.union(v.literal("subtask"), v.literal("apply"));

/** Most files stored on one row; `filesTruncated` says more changed. The diff action reads git for the full list. */
export const CHECKPOINT_FILES_LIMIT = 200;

/** What the worker reports for one capture. */
export const checkpointRecordFields = {
  taskId: v.id("tasks"),
  n: v.number(),
  ref: v.string(),
  commitSha: v.string(),
  treeSha: v.string(),
  headSha: v.optional(v.string()),
  previousSha: v.optional(v.string()),
  kind: checkpointKindValidator,
  subtaskKey: v.optional(v.string()),
  files: v.array(checkpointFileValidator),
  filesTruncated: v.optional(v.boolean()),
  filesChanged: v.number(),
  additions: v.number(),
  deletions: v.number(),
};

export const checkpointFields = {
  ...checkpointRecordFields,
  projectId: v.id("projects"),
  createdAt: v.number(),
  /** Set when the worktree sweep (or a discard / PR release) deleted the ref; the commit may be gone after gc. */
  refDeletedAt: v.optional(v.number()),
};
