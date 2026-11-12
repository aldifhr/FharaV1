/**
 * Global automation hold (GOAT G3): one persisted switch that stops every
 * path Fhara takes on its own, while a person's own requests still run.
 *
 * Adapted from GOAT `apps/server/src/automationHold.ts`
 * (https://github.com/goat-si/goat, commit 718f5b11), MIT License,
 * Copyright (c) 2026 T3 Tools Inc., Copyright (c) 2026 goat-si contributors.
 * Modified by Fhara, 2026-11: the hold file and Effect service became the
 * `appSettings.automationHold` field read by plain Convex helpers; "who may
 * act" is decided per path (auto-merge, issue intake, cron wrappers, the
 * worker claim of automatic tasks). See THIRD_PARTY_NOTICES.md (## GOAT).
 *
 * This is not the O3 per-task hold (`tasks.pausedBy === "held"`, a provider
 * outage pausing one task). That one pauses a task; this one stops
 * automation from starting anything, and touches no task row.
 */
import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { DataModel, Doc } from "../_generated/dataModel";

type Ctx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>;

export type AutomationHold = { heldAt: number; reason?: string };

/** The code and line auto-merge records while the hold is on. */
export const AUTOMATION_HELD_CODE = "automation_held";
export const AUTOMATION_HELD_REASON = "Automation is held (Settings → Scheduled tasks)";

/** The current hold, or null when automation may act. */
export async function loadAutomationHold(ctx: Ctx): Promise<AutomationHold | null> {
  const row = await ctx.db.query("appSettings").first();
  return row?.automationHold ?? null;
}

export async function isAutomationHeld(ctx: Ctx): Promise<boolean> {
  return (await loadAutomationHold(ctx)) !== null;
}

/**
 * Work Fhara started on its own rather than a person: a PR-feedback fix
 * task (O1 reactions). Everything else in the queue was started by the
 * user (the composer, Start on an issue draft).
 */
export function isAutomaticTask(task: Pick<Doc<"tasks">, "prFix">): boolean {
  return task.prFix !== undefined;
}

/**
 * Cron jobs the hold stops. The watchdog, lease recovery and the chat-reply
 * sweep keep running: they keep the user's own running work alive and
 * settled, and none of them starts anything new.
 */
export const HELD_CRON_JOBS: ReadonlySet<string> = new Set([
  "refresh task pull requests",
  "prune context snapshots",
  "sweep stale task worktrees",
]);

/** A cron run holds when automation is held and the run was not a person's "Run now". */
export function cronHeld(name: string, trigger: string | undefined, hold: AutomationHold | null): boolean {
  return hold !== null && HELD_CRON_JOBS.has(name) && trigger !== "manual";
}
