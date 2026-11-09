import type { ActionCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import type { RepoToolCall, RepoToolResult } from "../chat/repoTools";

/**
 * Run one READ-ONLY repo tool (list_files / grep / read_file) through the
 * worker queue, the same path grounded chat replies use (repoTools.ts):
 * enqueue, poll, always delete the row. Never throws.
 *
 * Kept separate from chat.ts (a "use node" module) so the Reviewer actions
 * can run in the default runtime.
 */
const WAIT_MS = 20_000;
const CLAIM_WAIT_MS = 3_000;
const POLL_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function callReadOnlyRepoTool(
  ctx: ActionCtx,
  projectId: Id<"projects">,
  call: RepoToolCall
): Promise<RepoToolResult & { unclaimed?: boolean }> {
  let callId: Id<"repoToolCalls">;
  try {
    callId = await ctx.runMutation(internal.repoTools.enqueue, {
      projectId,
      tool: call.tool,
      args: JSON.stringify(call.args ?? {}),
    });
  } catch (error) {
    return { ok: false, text: `Tool unavailable (${error instanceof Error ? error.message : "enqueue failed"}); treat as not checked.` };
  }
  try {
    const startedAt = Date.now();
    while (Date.now() < startedAt + WAIT_MS) {
      await sleep(POLL_MS);
      const row = await ctx.runQuery(internal.repoTools.get, { callId });
      if (!row) break;
      if (row.status === "done") return { ok: true, text: row.result ?? "", files: row.files ?? [] };
      if (row.status === "error") return { ok: false, text: row.error ?? "Tool failed." };
      if (row.status === "pending" && Date.now() - startedAt >= CLAIM_WAIT_MS) {
        return { ok: false, text: "No worker picked up this tool call; treat it as not checked.", unclaimed: true };
      }
    }
    return { ok: false, text: "No worker answered this tool call in time; treat it as not checked." };
  } finally {
    await ctx.runMutation(internal.repoTools.remove, { callId }).catch(() => undefined);
  }
}
