/**
 * Scheduled tasks: the webhook trigger (GOAT G8, idea #3b).
 *
 * `POST /hooks/scheduled/<scheduledTaskId>` fires that scheduled task once,
 * outside its clock. Another tool (CI, a form, a phone shortcut) calls it
 * with the task's own secret token; the token is shown once when it is made
 * and only its SHA-256 is stored (lib/webhookVerification.ts).
 *
 * - A missing or wrong token → 401, before anything else is revealed beyond
 *   "no such hook" (404). A paused task → 409.
 * - G3 hold: an authenticated delivery while automation is held → 503 with
 *   `retry-after`, and nothing is recorded, so the sender's retry after the
 *   hold is released still fires (GOAT webhookAutomationHold).
 * - Idempotent per delivery id (`x-fhara-delivery`, `idempotency-key`,
 *   `x-github-delivery`, `x-delivery-id`, `x-request-id`): the fire key
 *   `hook:<id>:<deliveryId>` dispatches once; a repeat answers 200 with
 *   `duplicate: true`. A delivery with no id is never deduplicated.
 * - The task's command (or message) is a template: `{{body.x}}`,
 *   `{{headers.x}}`, `{{query.x}}`, `{{request}}` render from the delivery,
 *   framed as untrusted data (lib/webhookTemplate.ts).
 *
 * Firing is the user's standing command, the same as the clock: it creates a
 * task or sends a chat message; chat itself still never starts a task.
 */
import { action, httpAction, internalMutation, internalQuery, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { assertProjectAccess } from "./lib/authz";
import { loadAutomationHold } from "./lib/automationHold";
import { recordAudit } from "./lib/recordAudit";
import { renderWebhookPrompt } from "./lib/webhookTemplate";
import { deliveryIdFrom, generateWebhookToken, hashWebhookToken, presentedWebhookToken, verifyWebhookToken } from "./lib/webhookVerification";
import { dispatchScheduledTarget, recordOutOfBandRun, scheduledTaskView } from "./scheduledTasks";

export const SCHEDULED_HOOK_PREFIX = "/hooks/scheduled/";
/** Larger bodies are refused (413); GOAT's relay uses the same cap. */
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

type HookFire =
  | { status: "dispatched"; taskId?: Id<"tasks">; messageId?: Id<"messages"> }
  | { status: "duplicate" | "held" | "disabled" | "not_found" };

const json = (status: number, body: Record<string, unknown>, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** What the HTTP action needs to authenticate and render; never leaves the server. */
export const hookTarget = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("scheduledTasks", args.id);
    const task = id ? await ctx.db.get(id) : null;
    if (!task) return null;
    return {
      scheduledTaskId: task._id,
      enabled: task.enabled,
      tokenHash: task.webhookTokenHash ?? null,
      template: task.target.kind === "task" ? task.target.command : task.target.content,
      held: (await loadAutomationHold(ctx)) !== null,
    };
  },
});

/** One delivery. Re-checks the hold and the pause inside the transaction. */
export const fireFromHook = internalMutation({
  args: { scheduledTaskId: v.id("scheduledTasks"), deliveryId: v.string(), text: v.string() },
  handler: async (ctx, args): Promise<HookFire> => {
    const task = await ctx.db.get(args.scheduledTaskId);
    if (!task) return { status: "not_found" };
    if (!task.enabled) return { status: "disabled" };
    if ((await loadAutomationHold(ctx)) !== null) return { status: "held" };
    const fireKey = `hook:${task._id}:${args.deliveryId}`;
    const earlier = await ctx.db
      .query("scheduledTaskRuns")
      .withIndex("by_fire_key", (q) => q.eq("fireKey", fireKey))
      .take(20);
    // A failed attempt does not claim the delivery: the sender's retry may still fire.
    if (earlier.some((run) => run.status === "dispatched")) return { status: "duplicate" };
    const dispatched = await dispatchScheduledTarget(ctx, task, fireKey, args.text);
    await recordOutOfBandRun(ctx, task, { fireKey, trigger: "webhook", status: "dispatched", deliveryId: args.deliveryId, ...dispatched });
    return { status: "dispatched", ...dispatched };
  },
});

/** A delivery whose dispatch threw (its transaction rolled back): one failed run row. */
export const recordHookFailure = internalMutation({
  args: { scheduledTaskId: v.id("scheduledTasks"), deliveryId: v.string(), error: v.string() },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.scheduledTaskId);
    if (!task) return;
    const fireKey = `hook:${task._id}:${args.deliveryId}`;
    await recordOutOfBandRun(ctx, task, { fireKey, trigger: "webhook", status: "failed", deliveryId: args.deliveryId, error: args.error });
  },
});

export const handleScheduledHook = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const id = url.pathname.slice(url.pathname.indexOf(SCHEDULED_HOOK_PREFIX) + SCHEDULED_HOOK_PREFIX.length).replace(/\/+$/, "");
  const target = id && !id.includes("/") ? await ctx.runQuery(internal.scheduledTaskHooks.hookTarget, { id }) : null;
  if (!target) return json(404, { error: "hook_not_found" });
  if (!(await verifyWebhookToken(presentedWebhookToken(request.headers, url), target.tokenHash))) {
    return json(401, { error: "invalid_token" });
  }
  if (!target.enabled) return json(409, { error: "hook_disabled" });
  if (target.held) return json(503, { error: "automation_held" }, { "retry-after": "30" });

  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > WEBHOOK_MAX_BODY_BYTES) return json(413, { error: "body_too_large" });
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > WEBHOOK_MAX_BODY_BYTES) return json(413, { error: "body_too_large" });

  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const rendered = renderWebhookPrompt(
    target.template,
    { method: request.method, path: url.pathname, query, headers, bodyText: new TextDecoder().decode(body) },
    crypto.randomUUID().replace(/-/g, "").slice(0, 12),
  );
  const deliveryId = deliveryIdFrom(request.headers) ?? `auto-${crypto.randomUUID()}`;
  const args = { scheduledTaskId: target.scheduledTaskId, deliveryId };
  let result: HookFire;
  try {
    result = await ctx.runMutation(internal.scheduledTaskHooks.fireFromHook, { ...args, text: rendered.prompt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.runMutation(internal.scheduledTaskHooks.recordHookFailure, { ...args, error: message });
    return json(500, { error: "dispatch_failed", deliveryId });
  }
  switch (result.status) {
    case "dispatched":
      return json(202, { deliveryId, ...(rendered.missing.length ? { missing: rendered.missing } : {}) });
    case "duplicate":
      return json(200, { deliveryId, duplicate: true });
    case "held":
      return json(503, { error: "automation_held" }, { "retry-after": "30" });
    case "disabled":
      return json(409, { error: "hook_disabled" });
    case "not_found":
      return json(404, { error: "hook_not_found" });
  }
});

export const storeWebhookTokenHash = internalMutation({
  args: { scheduledTaskId: v.id("scheduledTasks"), tokenHash: v.string() },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.scheduledTaskId);
    if (!task) throw new Error("Scheduled task not found");
    // Auth carries over from the calling action, so this is the viewer's own check.
    await assertProjectAccess(ctx, task.projectId);
    const now = Date.now();
    await ctx.db.patch(task._id, { webhookTokenHash: args.tokenHash, webhookTokenSetAt: now, updatedAt: now });
    await recordAudit(ctx, { tool: "scheduler", action: "scheduled_task.webhook_token", target: task.name, projectId: task.projectId });
    return scheduledTaskView({ ...task, webhookTokenHash: args.tokenHash, webhookTokenSetAt: now }).webhookUrl;
  },
});

/**
 * Makes (or replaces) the task's webhook token and returns it once. Only
 * its hash is kept; a replaced token stops working at once.
 */
export const createWebhookToken = action({
  args: { scheduledTaskId: v.id("scheduledTasks") },
  handler: async (ctx, args): Promise<{ token: string; webhookUrl: string | null }> => {
    const token = generateWebhookToken();
    const webhookUrl: string | null = await ctx.runMutation(internal.scheduledTaskHooks.storeWebhookTokenHash, {
      scheduledTaskId: args.scheduledTaskId,
      tokenHash: await hashWebhookToken(token),
    });
    return { token, webhookUrl };
  },
});

/** Turns the webhook off: the stored hash is removed, so every token stops working. */
export const removeWebhookToken = mutation({
  args: { scheduledTaskId: v.id("scheduledTasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.scheduledTaskId);
    if (!task) throw new Error("Scheduled task not found");
    await assertProjectAccess(ctx, task.projectId);
    await ctx.db.patch(task._id, { webhookTokenHash: undefined, webhookTokenSetAt: undefined, updatedAt: Date.now() });
    await recordAudit(ctx, { tool: "scheduler", action: "scheduled_task.webhook_token_remove", target: task.name, projectId: task.projectId });
  },
});
