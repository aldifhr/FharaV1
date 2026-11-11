/**
 * Direct threads (threadbear T2): one agent loop per thread, no planner.
 *
 * A direct thread is a `tasks` row with `mode: "direct"`, run as one of the
 * nine fixed roles. It starts ONLY on an explicit user action (`create`);
 * chat never starts one. Its transcript is the task's `taskEvents` stream
 * (threadbear protocol event names, store-assigned gapless `sequence`), its
 * streaming text lives in `threadStreams` hot rows (~300 ms flushes from the
 * worker, never patched onto list documents), and tool output over 2 KB is
 * kept in `eventBodies` and read lazily.
 *
 * Two callers:
 *   - the web UI: create / send / interrupt / respond / close, and the
 *     tail / page / streams / body reads (T3 renders them);
 *   - the worker, through token-gated wrappers in worker.ts: claim, poll,
 *     appendEvents, flushStream, requestApproval, approvalState,
 *     cancelApproval, release. Every worker write is lease-fenced.
 *
 * Approvals are in-process: the worker keeps its lease (heartbeat) while a
 * card waits, and this module never calls orchestration.requestApproval,
 * which would drop the lease and re-queue the task.
 */
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { assertProjectAccess, getViewerId } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { appendTaskEvent } from "./lib/taskEvents";
import { holdsTaskLease } from "./orchestration";
import { normalizePermissionMode, projectDefaultPermissionMode, permissionModeValidator } from "./lib/permissionModes";
import { isRoleKey, normalizeRoleKey, ROLE_KEYS } from "./lib/roles";
import {
  cancelDirectCard,
  directApprovalPolicy,
  directCancelReasonOf,
  directCancelReasonValidator,
  directCommandHead,
  EVENT_BODY_MAX,
  EVENT_BODY_PREVIEW,
  EVENT_BODY_THRESHOLD,
  expireDirectCards,
  isDirectCard,
  isDirectEventType,
  STREAM_TEXT_MAX,
  userMessagesAfter,
} from "./lib/directThreads";
import { directMcpSetHash } from "./directThreadSettings";

const TERMINAL = new Set(["done", "failed", "rejected", "cancelled"]);
const LEASE_LOST = "Lease lost: this task is no longer owned by this worker";
const DEFAULT_LEASE_MS = 60_000;
const MAX_TEXT = 20_000;
const TAIL_MAX = 80;
const PAGE_MAX = 200;

const engineValidator = v.union(v.literal("opencode-acp"), v.literal("api-loop"));
const directStatusValidator = v.union(
  v.literal("idle"),
  v.literal("starting"),
  v.literal("running"),
  v.literal("waiting"),
  v.literal("stopped"),
  v.literal("error")
);

async function loadDirectTask(ctx: Pick<MutationCtx, "db">, taskId: Id<"tasks">): Promise<Doc<"tasks">> {
  const task = await ctx.db.get(taskId);
  if (!task) throw new Error("Task not found");
  if (task.mode !== "direct" || !task.direct) throw new Error("Not a direct thread");
  return task;
}

/** The enabled agent that plays `role` for this project (team first). */
async function agentForRole(ctx: MutationCtx, project: Doc<"projects">, role: string): Promise<Doc<"agents">> {
  const team = project.agentIds ?? [];
  const candidates: Doc<"agents">[] = [];
  if (team.length > 0) {
    for (const id of team) {
      const agent = await ctx.db.get(id);
      if (agent) candidates.push(agent);
    }
  } else {
    candidates.push(...(await ctx.db.query("agents").take(200)));
  }
  const match = candidates.find((agent) => agent.isEnabled !== false && normalizeRoleKey(agent.role) === role);
  if (!match) throw new Error(`No enabled ${role} agent in this project's team`);
  return match;
}

async function writeUserMessage(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  text: string,
  clientId: string
): Promise<{ eventId: Id<"taskEvents">; sequence: number; deduped: boolean }> {
  const eventKey = `user.message:${clientId}`;
  const existing = await ctx.db
    .query("taskEvents")
    .withIndex("by_task_and_event_key", (q) => q.eq("taskId", task._id).eq("eventKey", eventKey))
    .first();
  if (existing) return { eventId: existing._id, sequence: existing.sequence ?? 0, deduped: true };
  const eventId = await appendTaskEvent(ctx, {
    taskId: task._id,
    projectId: task.projectId,
    type: "user.message",
    eventKey,
    payload: { text, clientId },
    level: "info",
  });
  const row = await ctx.db.get(eventId);
  return { eventId, sequence: row?.sequence ?? 0, deduped: false };
}

function cleanText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Message is empty");
  if (trimmed.length > MAX_TEXT) throw new Error(`Message is too long (max ${MAX_TEXT} characters)`);
  return trimmed;
}

function cleanClientId(clientId: string): string {
  const id = clientId.trim();
  if (!id || id.length > 100) throw new Error("clientId is required (1-100 characters)");
  return id;
}

// ── Web UI: commands ───────────────────────────────────────────────────

/**
 * Start a direct thread. The only way one starts: an explicit user action
 * (the "Direct" toggle, `/direct <text>`, or "New direct thread").
 */
export const create = mutation({
  args: {
    projectId: v.id("projects"),
    role: v.string(),
    text: v.optional(v.string()),
    clientId: v.optional(v.string()),
    title: v.optional(v.string()),
    permissionMode: v.optional(permissionModeValidator),
    conversationId: v.optional(v.id("conversations")),
  },
  handler: async (ctx, args): Promise<{ taskId: Id<"tasks"> }> => {
    const project = await assertProjectAccess(ctx, args.projectId);
    const role = normalizeRoleKey(args.role);
    if (!isRoleKey(role)) throw new Error(`Unknown role "${args.role}" (one of: ${ROLE_KEYS.join(", ")})`);
    if (args.conversationId) {
      const conversation = await ctx.db.get(args.conversationId);
      if (!conversation || conversation.projectId !== args.projectId) throw new Error("Conversation does not belong to this project");
    }
    const text = args.text !== undefined && args.text.trim() ? cleanText(args.text) : undefined;
    const clientId = text ? cleanClientId(args.clientId ?? `create-${Date.now()}`) : undefined;
    // A retried create (same clientId) returns the thread it already made.
    if (clientId) {
      const dup = await ctx.db
        .query("tasks")
        .withIndex("by_idempotency", (q) => q.eq("idempotencyKey", `direct:${args.projectId}:${clientId}`))
        .first();
      if (dup) return { taskId: dup._id };
    }
    const agent = await agentForRole(ctx, project, role);
    const now = Date.now();
    const title = args.title?.trim() || (text ? (text.length > 80 ? `${text.slice(0, 80)}...` : text) : `Direct thread (${role})`);
    const taskId = await ctx.db.insert("tasks", {
      projectId: args.projectId,
      title,
      command: text ?? "",
      status: text ? "queued" : "waiting_input",
      mode: "direct",
      direct: { role, agentId: agent._id, engine: "opencode-acp", status: "idle", lastSeq: 0, deliveredSeq: 0 },
      assignedAgentIds: [agent._id],
      permissionMode: args.permissionMode ?? projectDefaultPermissionMode(project),
      ...(clientId ? { idempotencyKey: `direct:${args.projectId}:${clientId}` } : {}),
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
      updatedAt: now,
    });
    const task = (await ctx.db.get(taskId))!;
    await appendTaskEvent(ctx, {
      taskId,
      projectId: args.projectId,
      type: "thread.created",
      payload: { mode: "direct", role, agentId: agent._id },
      level: "info",
    });
    if (text && clientId) await writeUserMessage(ctx, task, text, clientId);
    return { taskId };
  },
});

/**
 * Send a message. The worker steers it into a live turn, or starts a turn with it; an open approval
 * card is declined with this text first (the agent continues with the user's words instead of
 * blocking). The same clientId twice writes once.
 */
export const send = mutation({
  args: { taskId: v.id("tasks"), text: v.string(), clientId: v.string() },
  handler: async (ctx, args): Promise<{ eventId: Id<"taskEvents">; deduped: boolean; declined: number }> => {
    const task = await loadDirectTask(ctx, args.taskId);
    await assertProjectAccess(ctx, task.projectId);
    if (TERMINAL.has(task.status)) throw new Error(`This thread is ${task.status}`);
    return await sendDirectMessage(ctx, task, cleanText(args.text), cleanClientId(args.clientId));
  },
});

/** Write one user message and wake the thread; `send` and review rounds (diffComments.sendRound) share it. */
export async function sendDirectMessage(ctx: MutationCtx, task: Doc<"tasks">, text: string, clientId: string) {
  const written = await writeUserMessage(ctx, task, text, clientId);
  if (written.deduped) return { eventId: written.eventId, deduped: true, declined: 0 };
  const declined = await declineDirectCards(ctx, task, text);
  if (task.status === "waiting_input" || task.status === "paused") await ctx.db.patch(task._id, { status: "queued", updatedAt: Date.now() });
  return { eventId: written.eventId, deduped: false, declined };
}

async function declineDirectCards(ctx: MutationCtx, task: Doc<"tasks">, text: string): Promise<number> {
  const rows = await ctx.db
    .query("approvals")
    .withIndex("by_task", (q) => q.eq("taskId", task._id))
    .order("desc")
    .take(50);
  const snippet = text.replace(/\s+/g, " ").slice(0, 300);
  let declined = 0;
  for (const row of rows) {
    if (row.status !== "pending" || !isDirectCard(row)) continue;
    await resolveDirectCard(ctx, row, "deny", `user replied instead: ${snippet}`, "chat-reply");
    declined += 1;
  }
  return declined;
}

async function resolveDirectCard(
  ctx: MutationCtx,
  row: Doc<"approvals">,
  decision: "allow" | "deny",
  note: string | undefined,
  actor: string
): Promise<void> {
  if (row.status !== "pending") throw new Error(`Approval already ${row.status}`);
  const now = Date.now();
  const status = decision === "deny" ? "rejected" : "approved";
  await ctx.db.patch(row._id, {
    status,
    resolvedAt: now,
    decidedBy: "user",
    decision,
    ...(note ? { note: note.slice(0, 1000) } : {}),
    history: [...(row.history ?? []), { at: now, status, decision, by: actor }],
  });
  await appendTaskEvent(ctx, {
    taskId: row.taskId,
    projectId: row.projectId,
    type: "approval.resolved",
    payload: { approvalId: row._id, decision, ...(note ? { message: note.slice(0, 1000) } : {}) },
    level: decision === "deny" ? "warn" : "info",
  });
  await recordAudit(ctx, {
    tool: "approval",
    actor,
    action: decision === "deny" ? "approval.reject" : "approval.approve",
    decision: decision === "deny" ? "denied" : "allowed",
    target: row.summary,
    projectId: row.projectId,
    taskId: row.taskId,
    details: { kind: row.kind, decision, direct: true, ...(row.toolName ? { toolName: row.toolName } : {}) },
  });
}

/** Allow or deny one tool call card of a direct thread. */
export const respond = mutation({
  args: { approvalId: v.id("approvals"), decision: v.union(v.literal("allow"), v.literal("deny")), note: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ decision: "allow" | "deny" }> => {
    const row = await ctx.db.get(args.approvalId);
    if (!row || !isDirectCard(row)) throw new Error("Approval not found");
    await assertProjectAccess(ctx, row.projectId);
    const actor = (await getViewerId(ctx)) ?? "user";
    await resolveDirectCard(ctx, row, args.decision, args.note?.trim() || undefined, actor);
    return { decision: args.decision };
  },
});

/**
 * Stop. The worker interrupts the live turn (session/cancel, then a kill
 * after a 10 s grace); open cards expire now. Messages still queued are
 * dropped with the turn ("Stop means stop").
 */
export const interrupt = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<{ requested: boolean }> => {
    const task = await loadDirectTask(ctx, args.taskId);
    await assertProjectAccess(ctx, task.projectId);
    if (TERMINAL.has(task.status)) return { requested: false };
    const now = Date.now();
    await expireDirectCards(ctx, task._id, "interrupt", "Stopped by the user.");
    if (task.status === "queued" && !task.workerId) {
      // Nothing runs yet: the queued messages are dropped here.
      const queued = await userMessagesAfter(ctx, task._id, task.direct!.deliveredSeq ?? 0);
      const last = queued.length ? queued[queued.length - 1].sequence ?? 0 : task.direct!.deliveredSeq ?? 0;
      await ctx.db.patch(task._id, {
        status: "waiting_input",
        updatedAt: now,
        direct: { ...task.direct!, deliveredSeq: last, interruptRequestedAt: now },
      });
      await appendTaskEvent(ctx, {
        taskId: task._id,
        projectId: task.projectId,
        type: "system.note",
        payload: { text: `Stopped before the agent started.${queued.length ? ` ${queued.length} queued message(s) were not sent.` : ""}` },
        level: "info",
      });
      return { requested: true };
    }
    await ctx.db.patch(task._id, { direct: { ...task.direct!, interruptRequestedAt: now } });
    return { requested: true };
  },
});

/** Close the thread for good (archive). The worker ends its session. */
export const close = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args): Promise<{ closed: boolean }> => {
    const task = await loadDirectTask(ctx, args.taskId);
    await assertProjectAccess(ctx, task.projectId);
    if (TERMINAL.has(task.status)) return { closed: false };
    const now = Date.now();
    await expireDirectCards(ctx, task._id, "closed", "The thread was closed.");
    await ctx.db.patch(task._id, {
      status: "cancelled",
      completedAt: now,
      updatedAt: now,
      direct: { ...task.direct!, status: "stopped", interruptRequestedAt: now },
    });
    await appendTaskEvent(ctx, {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.cancelled",
      payload: { by: "user", mode: "direct" },
      level: "info",
    });
    return { closed: true };
  },
});

// ── Web UI: reads (T3 renders these) ───────────────────────────────────

async function visibleDirectTask(ctx: QueryCtx, taskId: Id<"tasks">): Promise<Doc<"tasks"> | null> {
  const task = await ctx.db.get(taskId);
  if (!task || task.mode !== "direct") return null;
  await assertProjectAccess(ctx, task.projectId);
  return task;
}

/** The newest `limit` (≤ 80) events, oldest first: the live tail. */
export const tail = query({
  args: { taskId: v.id("tasks"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const task = await visibleDirectTask(ctx, args.taskId);
    if (!task) return null;
    const limit = Math.max(1, Math.min(TAIL_MAX, Math.floor(args.limit ?? TAIL_MAX)));
    const rows = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_and_sequence", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(limit);
    return { task: { _id: task._id, status: task.status, title: task.title, direct: task.direct, permissionMode: task.permissionMode }, events: rows.reverse() };
  },
});

/** An older page: events before `beforeSeq`, oldest first (read once). */
export const page = query({
  args: { taskId: v.id("tasks"), beforeSeq: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const task = await visibleDirectTask(ctx, args.taskId);
    if (!task) return [];
    const limit = Math.max(1, Math.min(PAGE_MAX, Math.floor(args.limit ?? 100)));
    const rows = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_and_sequence", (q) => q.eq("taskId", args.taskId).lt("sequence", args.beforeSeq))
      .order("desc")
      .take(limit);
    return rows.reverse();
  },
});

/** The hot streaming rows of items not yet persisted. */
export const streams = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await visibleDirectTask(ctx, args.taskId);
    if (!task) return [];
    return await ctx.db
      .query("threadStreams")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .take(20);
  },
});

/** The whole output of one tool result, read when its row is opened. */
export const body = query({
  args: { taskId: v.id("tasks"), seq: v.number() },
  handler: async (ctx, args) => {
    const task = await visibleDirectTask(ctx, args.taskId);
    if (!task) return null;
    const row = await ctx.db
      .query("eventBodies")
      .withIndex("by_task_and_seq", (q) => q.eq("taskId", args.taskId).eq("seq", args.seq))
      .first();
    return row ? { seq: row.seq, body: row.body } : null;
  },
});

// ── Worker (token-gated wrappers in worker.ts) ─────────────────────────

/** Claim the oldest queued direct thread. */
export const claim = internalMutation({
  args: { workerId: v.string(), leaseMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const leaseMs = args.leaseMs ?? DEFAULT_LEASE_MS;
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_mode_and_status", (q) => q.eq("mode", "direct").eq("status", "queued"))
      .order("asc")
      .first();
    if (!task || !task.direct) return null;
    await ctx.db.patch(task._id, {
      status: "running",
      workerId: args.workerId,
      leaseExpiresAt: now + leaseMs,
      startedAt: task.startedAt ?? now,
      updatedAt: now,
      errorMessage: undefined,
      direct: { ...task.direct, status: "starting", error: undefined },
    });
    await appendTaskEvent(ctx, {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.claimed",
      payload: { workerId: args.workerId, mode: "direct" },
      level: "info",
    });
    const project = await ctx.db.get(task.projectId);
    const agent = await ctx.db.get(task.direct.agentId);
    return {
      taskId: task._id,
      projectId: task.projectId,
      title: task.title,
      direct: task.direct,
      permissionMode: normalizePermissionMode(task.permissionMode),
      workspacePath: project?.workspacePath ?? null,
      agent: agent
        ? { _id: agent._id, name: agent.name, role: agent.role, systemPrompt: agent.systemPrompt ?? null }
        : null,
    };
  },
});

/**
 * What the worker needs each tick while it holds a thread: the task
 * status, the permission mode now, Stop, and messages not yet delivered.
 */
export const poll = internalQuery({
  args: { taskId: v.id("tasks"), workerId: v.string() },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.mode !== "direct" || !task.direct) return null;
    const owned = task.workerId === args.workerId;
    const messages = await userMessagesAfter(ctx, task._id, task.direct.deliveredSeq ?? 0, 20);
    return {
      status: task.status,
      owned,
      permissionMode: normalizePermissionMode(task.permissionMode),
      interruptRequestedAt: task.direct.interruptRequestedAt ?? null,
      deliveredSeq: task.direct.deliveredSeq ?? 0,
      lastSeq: task.direct.lastSeq,
      sessionId: task.direct.sessionId ?? null,
      allowRules: task.direct.allowRules ?? [],
      mcpSetHash: await directMcpSetHash(ctx, task.projectId, task.direct.role),
      effort: task.direct.effort ?? null,
      messages: messages.map((row) => ({
        seq: row.sequence ?? 0,
        text: String((row.payload as { text?: unknown } | undefined)?.text ?? ""),
        clientId: String((row.payload as { clientId?: unknown } | undefined)?.clientId ?? ""),
      })),
    };
  },
});

const directPatchValidator = v.object({
  status: v.optional(directStatusValidator),
  sessionId: v.optional(v.union(v.string(), v.null())),
  turnId: v.optional(v.union(v.string(), v.null())),
  engine: v.optional(engineValidator),
  deliveredSeq: v.optional(v.number()),
  idleSince: v.optional(v.union(v.number(), v.null())),
  error: v.optional(v.union(v.string(), v.null())),
  stoppedMidTurn: v.optional(v.boolean()),
  allowRules: v.optional(v.array(v.string())),
  mcpSetHash: v.optional(v.string()),
});

type DirectPatch = Infer<typeof directPatchValidator>;

function applyDirectPatch(direct: NonNullable<Doc<"tasks">["direct"]>, patch: DirectPatch, lastSeq: number) {
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
  return next;
}

/**
 * Persist engine events in order (each gets the next gapless sequence),
 * idempotent per eventKey. A tool.result over 2 KB keeps a 300-character
 * preview and its body goes to eventBodies. A persisted item's hot stream
 * row is deleted. An optional `state` patch updates `tasks.direct` once,
 * at turn boundaries only.
 */
export const appendEvents = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workerId: v.string(),
    events: v.array(v.object({ type: v.string(), eventKey: v.optional(v.string()), payload: v.any() })),
    state: v.optional(directPatchValidator),
  },
  handler: async (ctx, args): Promise<{ seqs: number[] }> => {
    const task = await loadDirectTask(ctx, args.taskId);
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) throw new Error(LEASE_LOST);
    if (args.events.length > 100) throw new Error("Too many events in one append (max 100)");
    const seqs: number[] = [];
    let lastSeq = 0;
    for (const event of args.events) {
      if (!isDirectEventType(event.type) || event.type === "user.message") {
        throw new Error(`Not a direct thread event: ${event.type}`);
      }
      const payload = { ...((event.payload ?? {}) as Record<string, unknown>) };
      let body: string | null = null;
      if (event.type === "tool.result" && typeof payload.text === "string") {
        const bytes = new TextEncoder().encode(payload.text).length;
        if (bytes > EVENT_BODY_THRESHOLD) {
          body = payload.text.length > EVENT_BODY_MAX ? payload.text.slice(0, EVENT_BODY_MAX) : payload.text;
          payload.text = payload.text.slice(0, EVENT_BODY_PREVIEW);
          payload.bytes = bytes;
          payload.hasBody = true;
          if (body.length < (event.payload as { text: string }).text.length) payload.truncated = true;
        }
      }
      const eventId = await appendTaskEvent(ctx, {
        taskId: task._id,
        projectId: task.projectId,
        type: event.type,
        ...(event.eventKey ? { eventKey: event.eventKey.slice(0, 200) } : {}),
        payload,
        level: event.type === "turn.completed" && (payload.outcome === "failed" || payload.outcome === "timed_out") ? "warn" : "info",
      });
      const row = await ctx.db.get(eventId);
      const seq = row?.sequence ?? 0;
      seqs.push(seq);
      lastSeq = Math.max(lastSeq, seq);
      if (body !== null && row && !(row.payload as { bodyId?: unknown } | undefined)?.bodyId) {
        const bodyId = await ctx.db.insert("eventBodies", { taskId: task._id, projectId: task.projectId, seq, body });
        await ctx.db.patch(eventId, { payload: { ...payload, bodyId } });
      }
      const itemId = typeof payload.itemId === "string" ? payload.itemId : null;
      if (itemId && (event.type === "assistant.text" || event.type === "reasoning" || event.type === "tool.result")) {
        const hot = await ctx.db
          .query("threadStreams")
          .withIndex("by_task_and_item", (q) => q.eq("taskId", task._id).eq("itemId", itemId))
          .first();
        if (hot) await ctx.db.delete(hot._id);
      }
    }
    if (args.state) {
      const fresh = (await ctx.db.get(task._id))!;
      const direct = applyDirectPatch(fresh.direct!, args.state as DirectPatch, lastSeq);
      // A new turn clears the interrupted-by-crash marker and Stop.
      await ctx.db.patch(task._id, { direct, updatedAt: Date.now() });
    }
    return { seqs };
  },
});

/**
 * Hot rows for streaming items: upsert the text so far. Written by the
 * worker at most every ~300 ms per item; never touches tasks or other
 * list documents.
 */
export const flushStream = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workerId: v.string(),
    seq: v.number(),
    items: v.array(
      v.object({
        itemId: v.string(),
        kind: v.union(v.literal("text"), v.literal("reasoning"), v.literal("output")),
        text: v.string(),
      })
    ),
  },
  handler: async (ctx, args): Promise<{ written: number }> => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.mode !== "direct") throw new Error("Not a direct thread");
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) throw new Error(LEASE_LOST);
    const now = Date.now();
    let written = 0;
    for (const item of args.items.slice(0, 20)) {
      const text = item.text.length > STREAM_TEXT_MAX ? item.text.slice(-STREAM_TEXT_MAX) : item.text;
      const existing = await ctx.db
        .query("threadStreams")
        .withIndex("by_task_and_item", (q) => q.eq("taskId", args.taskId).eq("itemId", item.itemId))
        .first();
      if (existing) {
        if (existing.text === text) continue;
        await ctx.db.patch(existing._id, { text, seq: args.seq, updatedAt: now });
      } else {
        await ctx.db.insert("threadStreams", {
          taskId: args.taskId,
          projectId: task.projectId,
          itemId: item.itemId,
          kind: item.kind,
          text,
          seq: args.seq,
          updatedAt: now,
        });
      }
      written += 1;
    }
    return { written };
  },
});

/** Remove every hot row of a thread (turn end, session exit). */
export const clearStreams = internalMutation({
  args: { taskId: v.id("tasks"), workerId: v.string() },
  handler: async (ctx, args): Promise<{ removed: number }> => {
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) throw new Error(LEASE_LOST);
    const rows = await ctx.db
      .query("threadStreams")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .take(100);
    for (const row of rows) await ctx.db.delete(row._id);
    return { removed: rows.length };
  },
});

const toolRequestValidator = v.object({
  acpKind: v.string(),
  title: v.string(),
  argv: v.optional(v.union(v.array(v.string()), v.null())),
  command: v.optional(v.string()),
  paths: v.optional(v.array(v.string())),
  codeWrite: v.optional(v.union(v.boolean(), v.literal("unsure"))),
  ruleKey: v.optional(v.string()),
  cwd: v.optional(v.string()),
  workspaceRoot: v.optional(v.string()),
});

/**
 * One ACP permission request. The policy is decided here, from the task's
 * permission mode NOW (lib/directThreads.directApprovalPolicy): `auto`
 * writes an approved row with decidedBy "auto" (rule 5) and returns it;
 * `pending` writes a card the worker waits on in-process.
 */
export const requestApproval = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workerId: v.string(),
    itemId: v.string(),
    request: toolRequestValidator,
    // The whole input, shown on the card (all of it or nothing).
    input: v.string(),
  },
  handler: async (ctx, args): Promise<{ status: "auto" | "pending"; approvalId: Id<"approvals">; reason: string }> => {
    const task = await loadDirectTask(ctx, args.taskId);
    if (TERMINAL.has(task.status)) throw new Error(`Task is already ${task.status}`);
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) throw new Error(LEASE_LOST);
    if (args.input.length > 8_000) throw new Error("Tool input too long for a card");
    const mode = normalizePermissionMode(task.permissionMode);
    const policy = directApprovalPolicy({ mode, request: args.request, allowRules: task.direct!.allowRules });
    const now = Date.now();
    const head = directCommandHead(args.request.argv);
    const summary = (args.request.acpKind === "execute" ? `Run ${args.request.command ?? args.request.title}` : args.request.title).slice(0, 300);
    const base = {
      taskId: task._id,
      projectId: task.projectId,
      kind: policy.kind,
      summary,
      payload: {
        direct: true,
        inline: true,
        itemId: args.itemId,
        acpKind: args.request.acpKind,
        title: args.request.title.slice(0, 300),
        input: args.input,
        ...(args.request.command ? { command: args.request.command } : {}),
        ...(head ? { head } : {}),
        ...(args.request.codeWrite ? { codeWrite: args.request.codeWrite } : {}),
        reason: policy.reason,
      },
      toolName: args.request.acpKind === "execute" ? "run_command" : `acp:${args.request.acpKind}`,
      arguments: { argv: args.request.argv ?? null, paths: args.request.paths ?? [] },
      ...(args.request.cwd ? { workspacePath: args.request.cwd } : {}),
      requestedByAgentId: task.direct!.agentId,
      offerAlways: policy.offerAlways,
    };
    if (policy.action === "auto") {
      const approvalId = await ctx.db.insert("approvals", {
        ...base,
        status: "approved",
        resolvedAt: now,
        decidedBy: "auto",
        decision: "allow",
        history: [{ at: now, status: "approved", by: "auto", mode, reason: policy.reason }],
      });
      await recordAudit(ctx, {
        actor: "permission-mode",
        tool: base.toolName,
        action: "approval.auto_approve",
        decision: "allowed",
        target: summary,
        projectId: task.projectId,
        taskId: task._id,
        details: { mode, reason: policy.reason, approvalId, direct: true },
      });
      return { status: "auto", approvalId, reason: policy.reason };
    }
    const approvalId = await ctx.db.insert("approvals", {
      ...base,
      status: "pending",
      history: [{ at: now, status: "pending", mode, reason: policy.reason }],
    });
    await appendTaskEvent(ctx, {
      taskId: task._id,
      projectId: task.projectId,
      type: "approval.requested",
      payload: {
        approvalId,
        itemId: args.itemId,
        title: args.request.title.slice(0, 300),
        input: args.input,
        options: ["allow", "deny"],
        kind: policy.kind,
        reason: policy.reason,
      },
      level: "warn",
    });
    return { status: "pending", approvalId, reason: policy.reason };
  },
});

/** Worker poll of one card, plus the task status (Stop / close). */
export const approvalState = internalQuery({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.approvalId);
    if (!row) return null;
    const task = await ctx.db.get(row.taskId);
    return {
      status: row.status,
      decision: row.decision ?? null,
      note: row.note ?? null,
      taskStatus: task?.status ?? null,
      reason: row.status === "cancelled" ? directCancelReasonOf(row) : null,
    };
  },
});

/**
 * Worker: close a card it stopped waiting on (interrupt, expiry, exit) with
 * a reason (Nuphos N5). Idempotent. `reason` is the text shown; `code` the
 * named reason (older workers send none: `interrupt`).
 */
export const cancelApproval = internalMutation({
  args: { approvalId: v.id("approvals"), reason: v.string(), code: v.optional(directCancelReasonValidator) },
  handler: async (ctx, args): Promise<{ applied: boolean }> => {
    const row = await ctx.db.get(args.approvalId);
    if (!row) return { applied: false };
    return { applied: await cancelDirectCard(ctx, row, args.code ?? "interrupt", args.reason) };
  },
});

/**
 * The worker lets go of a thread (idle release, shutdown, engine error).
 * A message that arrived since the last delivery re-queues it; otherwise
 * it waits for the user. Hot rows are cleared.
 */
export const release = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workerId: v.string(),
    reason: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ status: string }> => {
    const task = await loadDirectTask(ctx, args.taskId);
    if (task.workerId !== args.workerId) return { status: task.status };
    const now = Date.now();
    const rows = await ctx.db
      .query("threadStreams")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .take(100);
    for (const row of rows) await ctx.db.delete(row._id);
    await expireDirectCards(ctx, task._id, "session_ended", "The agent session ended.");
    if (TERMINAL.has(task.status)) {
      await ctx.db.patch(task._id, { workerId: undefined, leaseExpiresAt: undefined, updatedAt: now });
      return { status: task.status };
    }
    const pending = await userMessagesAfter(ctx, task._id, task.direct!.deliveredSeq ?? 0, 1);
    const status = pending.length > 0 ? "queued" : "waiting_input";
    await ctx.db.patch(task._id, {
      status,
      workerId: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
      direct: {
        ...task.direct!,
        status: args.error ? "error" : "idle",
        turnId: undefined,
        idleSince: now,
        ...(args.error ? { error: args.error.slice(0, 1000) } : {}),
      },
    });
    await appendTaskEvent(ctx, {
      taskId: task._id,
      projectId: task.projectId,
      type: "thread.released",
      payload: { reason: args.reason.slice(0, 200), ...(args.error ? { error: args.error.slice(0, 500) } : {}) },
      level: args.error ? "warn" : "info",
    });
    return { status };
  },
});

/** The newest events of a thread, oldest first, for a handoff note. */
export const history = internalQuery({
  args: { taskId: v.id("tasks"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(1000, Math.floor(args.limit ?? 400)));
    const rows = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_and_sequence", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(limit);
    return rows.reverse().map((row) => ({ type: row.type, sequence: row.sequence, payload: row.payload }));
  },
});
