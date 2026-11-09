import { stallEventType } from "@/utils/stallDetector";
import type { RunContext } from "./types";

/**
 * Repeated-output detector for the fix loops (review / verification / QA):
 * when the checker reports the SAME output (hash of its findings) on the
 * SAME staged code (snapshot of the file changes) N times in a row, the
 * fix round changed nothing — the loop stops instead of spending another
 * identical round. A fix that changed the code but drew the same finding
 * is progress and keeps its bounded iterations. Returns the stop
 * message (already logged as `stall.repeated_output`) or null.
 */
export async function repeatedOutputStop(
  ctx: Pick<RunContext, "repeatGuard" | "deps" | "taskId" | "project"> & { state?: Pick<RunContext["state"], "fileChanges"> },
  loop: "review" | "verification" | "qa",
  output: string
): Promise<string | null> {
  if (!ctx.repeatGuard) return null;
  // Content-level snapshot: hashes when present, else the content itself
  // (outputHash below digests it).
  const snapshot = ctx.state
    ? Array.from(ctx.state.fileChanges.values())
        .map((change) => `${change.filePath}:${change.changeType}:${change.newContentHash ?? change.newContent ?? change.diff ?? ""}`)
        .sort()
        .join("\n")
    : "";
  const seen = ctx.repeatGuard.observe(loop, `${output}\n#code:${snapshot}`);
  if (!seen.repeated) return null;
  const message = `Repeated output: the ${loop} loop produced the same result on unchanged code ${seen.count} times in a row (hash ${seen.hash}); stopping the fix loop`;
  await ctx.deps.api
    .logEvent({
      taskId: ctx.taskId,
      projectId: ctx.project._id,
      type: stallEventType("repeated_output"),
      payload: {
        kind: "repeated_output",
        action: "stop_loop",
        reason: message,
        detail: { loop, hash: seen.hash, count: seen.count, limit: ctx.repeatGuard.limit },
      },
      level: "error",
    })
    .catch(() => undefined);
  return message;
}
