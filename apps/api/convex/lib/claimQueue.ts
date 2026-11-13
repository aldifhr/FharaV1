/**
 * Bug 10 (head-of-line blocking): the queued rows a claim may skip — legacy
 * direct threads, and automatic tasks while automation is held — must not
 * hide a claimable task behind them. The claim scans the queue oldest-first
 * past those rows instead of looking at a fixed first page.
 */
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { isAutomaticTask } from "./automationHold";
import { isLegacyDirect } from "./legacyDirect";

/** Upper bound on queued rows one claim reads (keeps a claim's reads bounded). */
export const CLAIM_SCAN_LIMIT = 1000;

/** The oldest queued task this claim may take, or null. */
export async function firstClaimableTask(ctx: MutationCtx, automationHeld: boolean): Promise<Doc<"tasks"> | null> {
  let scanned = 0;
  const queue = ctx.db.query("tasks").withIndex("by_status", (q) => q.eq("status", "queued")).order("asc");
  for await (const task of queue) {
    if (!isLegacyDirect(task) && !(automationHeld && isAutomaticTask(task))) return task;
    scanned += 1;
    if (scanned >= CLAIM_SCAN_LIMIT) break;
  }
  return null;
}
