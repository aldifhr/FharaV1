import { loadSelectionMode } from "./llmSelection";
import { effectiveLegacyOpencode } from "./opencodeProvider";
import { loadOpencodeSettings } from "./opencodeSettings";
import type { LlmSelectionMode } from "./lib/llmSelection";
import { internalMutation, internalQuery, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { usageLedgerFields } from "./lib/usageLedger";
import {
  recordDecisionForEvent,
  recordDecisionForEventId,
  scheduleDecisionEvaluation,
} from "./lib/calibration/store";
import { openIncident } from "./lib/incidents";
import { scheduleShadowReview } from "./lib/reviewer/shadowSchedule";
import { subtaskContractFields } from "./lib/contractValidators";
import { recordObservationsForEvent } from "./lib/observationStore";
import { loadProviderPool, type PoolConnectionPayload } from "./lib/llmResolver";
import { effectiveTeamIds } from "./lib/projectTeam";
import type { PromptSkill } from "./lib/skills";
import { libraryField, loadPromptSkills } from "./skillLibrary";
import { resolveInvokedSkills } from "./lib/chat/invokedSkills";
import { resolveRunMcpServers } from "./mcpServers";
import { loadMemorySection, loadRecalledSection } from "./memories";
import { touchBriefQuestion } from "./briefs";
import { contractDefinition, writePlanVersion } from "./lib/planStore";
import { decidePermissionCore, permissionArgs } from "./permissionBroker";
import { clearSubtaskLive } from "./subtaskLive";
import { recordAudit } from "./lib/recordAudit";
import { FINISHED_TASK_STATUSES, worktreeCleanupBlocker } from "./lib/worktreeRetention";
import { onTaskSettled } from "./prFeedback";
import { onIssueTaskChanged } from "./issueIntake";
import {
  autoApprovalDecision,
  normalizePermissionMode,
  type PermissionMode,
} from "./lib/permissionModes";
import {
  assertProjectAccess,
  getVisibleTask,
  visibleProjectIds,
  assertConversationAccess,
} from "./lib/authz";
import { taskStatus, subtaskKind, subtaskStatus, executionStatus } from "./schema";
import { taskBranchPrefixes } from "./lib/taskBranch";
import { consumeTaskSignals, RESUMABLE_APPROVAL_KINDS, supersedePendingCommandApprovals } from "./taskSignals";
import { appendAgentEvent as appendAgentEventRow, appendTaskEvent } from "./lib/taskEvents";
import { classifyTaskHold } from "./lib/providerHold";
import { isAutomationHeld } from "./lib/automationHold";
import { firstClaimableTask } from "./lib/claimQueue";
import { holdTaskForProvider } from "./taskControl";
import { decideResume, replayEncodedBytes, RESUME_MAX_REPLAY_EVENTS } from "./lib/eventResume";
import { isLegacyDirect } from "./lib/legacyDirect";
import { closeLegacyDirect } from "./lib/legacyDirectRecovery";
import { loadRecordedSteps } from "./lib/restartSteps";
import type { RecordedStep } from "./lib/restartContinuation";
import { patchTask } from "./lib/threadIndex";

const DEFAULT_LEASE_MS = 60_000;

/** Upper bound on rows one heartbeat renews per status (a worker runs a handful). */
const HEARTBEAT_SCAN_LIMIT = 100;
/** Upper bound on stale tasks / executions / workers one recovery pass handles. */
const RECOVERY_BATCH = 50;
/** Upper bound on needs_approval tasks one resume poll returns. */
const RESUMABLE_SCAN_LIMIT = 50;

/**
 * Phase 4 recovery bound: a stale task with a valid stored plan is
 * requeued at most this many times; beyond that the failure is treated
 * as durable and the task is failed, so a poisoned plan cannot loop
 * through workers forever.
 */
const MAX_TASK_RECOVERIES = 3;

/**
 * Terminal task statuses are ABSORBING (Phase 4 hardening): once a task
 * is done, failed, rejected or cancelled (tasks.cancel) — no late write (a zombie worker finishing after the
 * fact, a stale completion racing the cancel) may move it back to a
 * live state or overwrite the terminal outcome. The write-layer guards
 * below enforce this in completeTask / setTaskStatus / requestApproval
 * and report a refused write as a VALUE, not an error, so a late worker
 * can stop cleanly instead of crashing on its own completion call.
 */
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "done",
  "failed",
  "rejected",
  "cancelled",
]);

/**
 * Monotonic subtask status (Phase 4 hardening): "completed" is
 * absorbing for late writes. Dynamic-DAG upserts and execution updates
 * can race (two outcomes settling together, a recovery pass overlapping
 * a late update); a completed row must never be rewritten to
 * pending/running/blocked by a write that was issued before the
 * completion landed.
 */
/**
 * "Declined by user: npm run typecheck" when a completed execution only
 * carries a declined command (agentExecutor meta.commandDeclined), else null.
 */
export function commandDeclinedReason(status: string, meta: unknown): string | null {
  if (status !== "completed" || !meta || typeof meta !== "object") return null;
  const m = meta as { commandDeclined?: unknown; declinedCommand?: unknown };
  if (!m.commandDeclined) return null;
  const label = m.commandDeclined === "recorded" ? "Not run again (it ran before the worker was cut off)" : "Declined by user";
  return typeof m.declinedCommand === "string" && m.declinedCommand.trim() ? `${label}: ${m.declinedCommand.trim()}` : label;
}

function monotonicSubtaskStatus(
  current: string,
  next: string
): string {
  if (current === "completed" && next !== "completed") return current;
  return next;
}

/**
 * Lease fencing: only the worker that currently owns the task lease may
 * write to it. A displaced worker (stale recovery requeued the task and
 * another worker claimed it) keeps running locally, so its writes must be
 * refused instead of interleaving with the new owner's.
 *
 * Strict (adopted from convex-durable-agents' lockId fencing): a write
 * with NO `workerId` is refused (every worker path sends one through
 * WorkerApi), and so is a write from a lease that has lapsed, even the
 * owner's own: once `leaseExpiresAt` passes, recovery may hand the task to
 * someone else at any moment, so the old owner must stop until its next
 * heartbeat renews the lease. A displaced writer is always refused.
 *
 * A task with NO owner (`workerId` cleared by recoverStale's requeue, by a
 * user cancel, or by requestApproval) is not a free-for-all: a worker that
 * presents an identity is refused, because the task is no longer its own —
 * the next legitimate writer is whoever claims it again. Only writes that
 * explicitly pass `allowUnowned` (none of the worker hot paths) may proceed.
 */
export async function holdsTaskLease(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  workerId: string | undefined,
  options: { allowUnowned?: boolean } = {}
): Promise<boolean> {
  if (!workerId) return false;
  const task = await ctx.db.get(taskId);
  if (!task) return false;
  if (!task.workerId) return options.allowUnowned === true;
  if (task.workerId !== workerId) return false;
  return (task.leaseExpiresAt ?? 0) >= Date.now();
}

const LEASE_LOST_ERROR = "Lease lost: this task is no longer owned by this worker";

/**
 * Strip legacy per-agent LLM fields — above all the plaintext `llmApiKey` —
 * before agent rows cross the internal boundary to the worker. The worker
 * never reads them (its toAgentDefinition drops them); returning the raw
 * documents only distributes plaintext credentials needlessly (spec §5).
 */
function projectAgentForWorker(agent: Doc<"agents">): Doc<"agents"> {
  const {
    llmApiKey: _llmApiKey,
    llmApiKeyEnv: _llmApiKeyEnv,
    llmBaseUrl: _llmBaseUrl,
    llmModel: _llmModel,
    llmProvider: _llmProvider,
    ...rest
  } = agent;
  return rest;
}

export const getRunContext = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (
    ctx,
    args
  ): Promise<{
    task: Doc<"tasks">;
    project: Doc<"projects"> | null;
    /**
     * Agent rows (credential fields stripped) plus their attached library
     * skills, resolved in order. The worker appends them after the static
     * system prompt (lib/skills.appendSkillsToPrompt).
     */
    agents: Array<Doc<"agents"> & { attachedSkills: PromptSkill[]; invokedSkills?: PromptSkill[]; memorySection?: string; recalledMemorySection?: string }>;
    plan: Doc<"plans"> | null;
    subtasks: Doc<"subtasks">[];
    /**
     * Per-subtask execution rows. The worker rebuilds file attribution
     * from each completed execution's `meta.filePaths` — the fileChanges
     * table holds one row per file path (upserted by the LAST writer),
     * so rebuilding attribution from fileChanges alone collapses and
     * marks earlier writers as having produced nothing.
     */
    executions: Doc<"executions">[];
    /** G4: tool steps + earlier continuations of subtasks a dead worker cut off (lib/restartSteps). */
    recordedSteps: RecordedStep[];
    approvalMode: "ask" | "auto";
    llmProviders: PoolConnectionPayload[];
    /**
     * Plan 032: the global LLM selection mode ("fallback" | "round_robin").
     * The worker resolver maps it onto its primary pick. No secrets.
     */
    llmSelectionMode: LlmSelectionMode;
    /**
     * Plan 035: the app-wide OpenCode runtime and the model the CLI runs.
     * Present only when the setting was written; otherwise the worker keeps
     * its legacy behaviour (the per-agent value, then the env default).
     * No secrets.
     */
    opencodeRuntime?: "api" | "opencode";
    opencodeModel?: string;
    /** Enabled MCP server configs for this project (Plan 009). Config-only. */
    mcpServers: Doc<"mcpServers">[];
    /**
     * Planner fallback: when the run's agent list has no enabled CTO, the
     * global enabled CTO is delivered here so the planner is never
     * degraded to the heuristic plan just because the CTO is missing from
     * the project team. Planner ONLY — it is not part of `agents`, so it
     * is never routed a subtask as an executor.
     */
    plannerAgent: (Doc<"agents"> & { attachedSkills: PromptSkill[] }) | null;
    /** Why `plannerAgent` was needed ("CTO not in project team", ...). */
    plannerFallbackReason: string | null;
  } | null> => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;
    const project = await ctx.db.get(task.projectId);
    const allAgents = await ctx.db.query("agents").collect();
    // No explicit assignees: the project's team as every surface sees it
    // (lib/projectTeam): its roster, or the fixed team when it has none. A
    // project created through the API without agentIds chatted (998db43) but
    // its tasks failed "No agents are assigned to this project".
    const assigned = task.assignedAgentIds?.length
      ? task.assignedAgentIds
      : project
        ? effectiveTeamIds(project.agentIds, allAgents)
        : undefined;
    const agents = assigned?.length
      ? allAgents.filter((agent) => assigned.includes(agent._id) && agent.isEnabled !== false)
      : [];
    const fallback = resolvePlannerFallback(allAgents, agents, assigned ?? []);
    const plans = await ctx.db.query("plans").withIndex("by_task", (q) => q.eq("taskId", args.taskId)).order("desc").take(1);
    const subtasks = await ctx.db.query("subtasks").withIndex("by_task", (q) => q.eq("taskId", args.taskId)).order("asc").collect();
    const executions = await ctx.db
      .query("executions")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();

    // Provider pool (connections + model registry) assembled by the shared
    // backend helper. Only the ENCRYPTED key crosses to the worker — the
    // worker decrypts on its side (spec §5); plaintext is never returned.
    // Plan 038: the run context is the one reader that carries the OpenCode
    // provider row: the worker turns an OpenCode entry of the order into the
    // native runtime for that subtask.
    const llmProviders: PoolConnectionPayload[] = project
      ? await loadProviderPool(ctx, { includeOpencode: true })
      : [];
    // MCP config crosses to the worker: global + this project's servers,
    // enabled only (mcpServers.resolveRunMcpServers). Env values cross only
    // as `envCiphertext`, which the worker decrypts at spawn; plaintext
    // credentials never do. Per-agent role filtering happens in the worker.
    const mcpServers = project ? await resolveRunMcpServers(ctx, project._id) : [];
    // Plan 032: the app-wide selection mode for the worker's resolver.
    const llmSelectionMode = await loadSelectionMode(ctx);
    // Plan 035: the app-wide OpenCode runtime (null = never configured).
    // Plan 038: once the OpenCode provider row exists, the ordered model
    // list decides and the legacy switch is neutralized ("api" baseline).
    const opencode = await effectiveLegacyOpencode(ctx, await loadOpencodeSettings(ctx));
    // Paradev C3: skills invoked on the source message, from the team's own (inlined in every agent's prompt).
    const teamIds = task.invokedSkills?.length && project ? effectiveTeamIds(project.agentIds, allAgents) : [];
    const invoked = (await resolveInvokedSkills(ctx, task.invokedSkills, allAgents.filter((a) => teamIds.includes(a._id)))).skills;

    return {
      task,
      project,
      agents: await Promise.all(
        agents.map(async (agent) => ({
          ...projectAgentForWorker(agent),
          attachedSkills: await loadPromptSkills(ctx, agent),
          ...(await libraryField(ctx, agent)), // shared library: bodiless, per agent
          ...(invoked.length ? { invokedSkills: invoked } : {}),
          // Pinned memories (shared → project → agent), pre-rendered and
          // capped (lib/memory.ts). The worker appends it after the skills.
          ...(await (async () => {
            const section = await loadMemorySection(ctx, { projectId: task.projectId, agentId: agent._id });
            return section ? { memorySection: section } : {};
          })()),
          // Plan L4: unpinned memories recalled for this task's request
          // (Convex full-text search, top-k), appended after the pinned one.
          ...(await (async () => {
            const recalled = await loadRecalledSection(
              ctx,
              { projectId: task.projectId, agentId: agent._id },
              `${task.title}\n${task.command}`
            );
            return recalled ? { recalledMemorySection: recalled } : {};
          })()),
        }))
      ),
      plan: plans[0] ?? null,
      subtasks,
      executions,
      recordedSteps: await loadRecordedSteps(ctx, args.taskId, subtasks, executions),
      approvalMode: project?.approvalMode === "auto" ? "auto" : "ask",
      llmProviders,
      mcpServers,
      llmSelectionMode,
      ...(opencode ? { opencodeRuntime: opencode.runtime, opencodeModel: opencode.model } : {}),
      plannerAgent: fallback.agent
        ? {
            ...projectAgentForWorker(fallback.agent),
            attachedSkills: await loadPromptSkills(ctx, fallback.agent),
            ...(await libraryField(ctx, fallback.agent)),
          }
        : null,
      plannerFallbackReason: fallback.reason,
    };
  },
});

const isCtoRole = (role: string | undefined) => /^cto$/i.test((role ?? "").trim());

/**
 * Pick the global CTO as planner when the run's own agents have no
 * enabled CTO. Exported for tests.
 */
export function resolvePlannerFallback(
  allAgents: Doc<"agents">[],
  runAgents: Doc<"agents">[],
  assigned: Id<"agents">[]
): { agent: Doc<"agents"> | null; reason: string | null } {
  if (runAgents.some((agent) => isCtoRole(agent.role))) return { agent: null, reason: null };
  const assignedCto = allAgents.find(
    (agent) => isCtoRole(agent.role) && assigned.includes(agent._id)
  );
  const reason = assignedCto
    ? "CTO is disabled in the project team"
    : "CTO not in project team";
  const globalCto =
    allAgents.find((agent) => isCtoRole(agent.role) && agent.isEnabled !== false) ?? null;
  return {
    agent: globalCto,
    reason: globalCto ? reason : `${reason}; no enabled CTO agent exists`,
  };
}

export const claimNextTask = internalMutation({
  args: {
    workerId: v.string(),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Doc<"tasks"> | null> => {
    const now = Date.now();
    const leaseMs = args.leaseMs ?? DEFAULT_LEASE_MS;
    // G3: while automation is held, automatic tasks stay queued; legacy direct threads are never claimed (bug 10: scans past both).
    const task = await firstClaimableTask(ctx, await isAutomationHeld(ctx));
    if (!task) return null;
    await patchTask(ctx, task._id, {
      status: "running",
      workerId: args.workerId,
      leaseExpiresAt: now + leaseMs,
      startedAt: task.startedAt ?? now,
      updatedAt: now,
      errorMessage: undefined,
    });
    await appendTaskEvent(ctx, {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.claimed",
      payload: { workerId: args.workerId },
      level: "info",
    });
    // A requeue woken by a signal (plan approval) is delivered by this claim.
    await consumeTaskSignals(ctx, task._id, "approval", args.workerId);
    return { ...task, status: "running", workerId: args.workerId, leaseExpiresAt: now + leaseMs };
  },
});

export const heartbeat = internalMutation({
  args: {
    workerId: v.string(),
    hostname: v.optional(v.string()),
    capacity: v.number(),
    activeTasks: v.number(),
    leaseMs: v.optional(v.number()),
    // Optional: the task ids this worker is actually running right now.
    // When given, only those leases are renewed, so a task the worker
    // abandoned without settling cannot be kept alive forever by the
    // heartbeat (core H2). Omitted = legacy behaviour (renew all owned).
    activeTaskIds: v.optional(v.array(v.string())),
    // Features this worker build serves; an older worker sends none.
    capabilities: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const leaseMs = args.leaseMs ?? DEFAULT_LEASE_MS;
    const capabilities = (args.capabilities ?? []).slice(0, 20).map((c) => c.slice(0, 40));
    const existing = await ctx.db
      .query("workers")
      .withIndex("by_worker_id", (q) => q.eq("workerId", args.workerId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        hostname: args.hostname ?? existing.hostname,
        capacity: args.capacity,
        activeTasks: args.activeTasks,
        status: "online",
        lastHeartbeatAt: now,
        capabilities,
      });
    } else {
      await ctx.db.insert("workers", {
        workerId: args.workerId,
        hostname: args.hostname,
        capacity: args.capacity,
        activeTasks: args.activeTasks,
        status: "online",
        lastHeartbeatAt: now,
        capabilities,
      });
    }

    // Only in-flight statuses, through the (workerId, status) index: the
    // by_worker index alone returned every task this worker ever owned.
    // A task being resumed after approval is still owned by this worker
    // even though its status stays "needs_approval" during the resume
    // claim; its lease must be renewed or a second worker could claim
    // the same resume after the first lease window.
    const activeIds = args.activeTaskIds ? new Set(args.activeTaskIds) : null;
    let renewedTasks = 0;
    // "paused" (plan 022): a paused task this worker is still draining
    // (running subtasks finish) keeps its lease until the worker releases it.
    for (const status of ["running", "needs_approval", "paused"] as const) {
      const owned = await ctx.db
        .query("tasks")
        .withIndex("by_worker_and_status", (q) =>
          q.eq("workerId", args.workerId).eq("status", status)
        )
        .take(HEARTBEAT_SCAN_LIMIT);
      for (const task of owned) {
        if (activeIds && !activeIds.has(task._id as string)) continue;
        await ctx.db.patch(task._id, {
          leaseExpiresAt: now + leaseMs,
          updatedAt: now,
        });
        renewedTasks++;
      }
    }

    // Lease loss (convex-orchestrator's claimState.lost, re-implemented):
    // a task the worker says it is running but no longer owns, because
    // recovery requeued it or another worker claimed it. The worker aborts
    // those runs. A task the run parked itself (needs_approval / paused /
    // waiting_input with no owner) or that ended is not "lost".
    const lostTaskIds: string[] = [];
    for (const rawId of args.activeTaskIds ?? []) {
      const id = ctx.db.normalizeId("tasks", rawId);
      const task = id ? await ctx.db.get(id) : null;
      if (!task) {
        lostTaskIds.push(rawId);
        continue;
      }
      if (task.workerId && task.workerId !== args.workerId) lostTaskIds.push(rawId);
      else if (!task.workerId && (task.status === "queued" || task.status === "running")) lostTaskIds.push(rawId);
    }

    for (const status of ["running", "queued"] as const) {
      const executions = await ctx.db
        .query("executions")
        .withIndex("by_worker_and_status", (q) =>
          q.eq("workerId", args.workerId).eq("status", status)
        )
        .take(HEARTBEAT_SCAN_LIMIT);
      for (const execution of executions) {
        if (activeIds && !activeIds.has(execution.taskId as string)) continue;
        await ctx.db.patch(execution._id, { leaseExpiresAt: now + leaseMs });
      }
    }
    return { now, renewedTasks, lostTaskIds };
  },
});

export const markWorkerOffline = internalMutation({
  args: { workerId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("workers")
      .withIndex("by_worker_id", (q) => q.eq("workerId", args.workerId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { status: "offline", activeTasks: 0 });
    }
  },
});

export const recoverStale = internalMutation({
  args: {
    // Optional so the backend watchdog cron (taskWatchdog.ts) can run the
    // same recovery without a worker: a dead worker never leaves limbo.
    now: v.optional(v.number()),
    staleGraceMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const staleGraceMs = args.staleGraceMs ?? 30_000;
    const recovered: string[] = [];

    // The LEASE is authoritative (core H7). A worker's heartbeat row is
    // created only by its first heartbeat (~10 s after boot), so "no
    // heartbeat row" used to reclaim tasks a brand-new worker had just
    // claimed with a perfectly valid lease. A task is stale only once its
    // lease has actually expired (or it has none at all). Read through the
    // (status, leaseExpiresAt) index and bounded per pass.
    const noLease = await ctx.db
      .query("tasks")
      .withIndex("by_status_and_lease", (q) =>
        q.eq("status", "running").eq("leaseExpiresAt", undefined)
      )
      .take(RECOVERY_BATCH);
    const expiredLease = await ctx.db
      .query("tasks")
      .withIndex("by_status_and_lease", (q) =>
        q.eq("status", "running").lt("leaseExpiresAt", now)
      )
      .take(RECOVERY_BATCH);
    const seen = new Set<string>();
    const running = [...noLease, ...expiredLease].filter((task) => {
      if (seen.has(task._id as string)) return false;
      seen.add(task._id as string);
      return true;
    });
    for (const task of running) {
      const leaseExpired = !task.leaseExpiresAt || task.leaseExpiresAt < now;
      if (!leaseExpired) continue;

      if (isLegacyDirect(task)) {
        await closeLegacyDirect(ctx, task._id, now); // legacy: direct threads removed 2026-11-12
        recovered.push(task._id);
        continue;
      }

      // Phase 4 recovery semantics: a stale task is only a loss when
      // there is nothing valid to resume from. When the latest stored
      // plan is structurally valid AND subtask rows exist, the task is
      // REQUEUED (lease cleared, recovery counted) — the next worker to
      // claim it rebuilds state from the DB and skips the subtasks that
      // already completed. It is failed only when no valid plan /
      // checkpoint exists, or the recovery bound has been reached.
      const plans = await ctx.db
        .query("plans")
        .withIndex("by_task", (q) => q.eq("taskId", task._id))
        .order("desc")
        .take(1);
      const latestPlan = plans[0];
      const payload = latestPlan?.payload as
        | { subtasks?: unknown }
        | null
        | undefined;
      const planValid =
        !!latestPlan &&
        Array.isArray(payload?.subtasks) &&
        payload.subtasks.length > 0;
      const subtaskRows = planValid
        ? await ctx.db
            .query("subtasks")
            .withIndex("by_task", (q) => q.eq("taskId", task._id))
            .collect()
        : [];
      const recoveryCount = task.recoveryCount ?? 0;

      // Plan 022 (ROADMAP "planning-interrupted tasks never recover"): a
      // worker that died while PLANNING left no plan and no execution, so
      // there was nothing to resume and the task used to be failed with
      // "no_valid_stored_plan". Planning is a dispatch too: re-dispatch it
      // (`${taskId}/plan/attempt-N`) — requeue, and the next claim plans
      // afresh. Bounded by the same recovery limit.
      if (!latestPlan && recoveryCount < MAX_TASK_RECOVERIES) {
        const started = await ctx.db
          .query("executions")
          .withIndex("by_task", (q) => q.eq("taskId", task._id))
          .take(1);
        if (started.length === 0) {
          await patchTask(ctx, task._id, {
            status: "queued",
            workerId: undefined,
            leaseExpiresAt: undefined,
            errorMessage: undefined,
            completedAt: undefined,
            recoveryCount: recoveryCount + 1,
            updatedAt: now,
          });
          await appendTaskEvent(ctx, {
            taskId: task._id,
            projectId: task.projectId,
            type: "task.recovered",
            payload: {
              action: "requeued",
              reason: "planning_interrupted",
              dispatchKey: dispatchKeyFor(task._id, "plan", recoveryCount + 2),
              workerId: task.workerId ?? null,
              recoveryCount: recoveryCount + 1,
            },
            level: "warn",
          });
          recovered.push(task._id);
          continue;
        }
      }

      if (planValid && subtaskRows.length > 0 && recoveryCount < MAX_TASK_RECOVERIES) {
        await patchTask(ctx, task._id, {
          status: "queued",
          workerId: undefined,
          leaseExpiresAt: undefined,
          errorMessage: undefined,
          completedAt: undefined,
          recoveryCount: recoveryCount + 1,
          updatedAt: now,
        });
        // A run_command the dead worker was waiting on has no waiter now:
        // close its card; the re-run asks again (or reuses an allow the
        // user already gave, through the command signal).
        await supersedePendingCommandApprovals(ctx, task._id, "worker lease expired while waiting; the subtask will re-run");
        // Subtasks left "running" by the dead worker have no executor
        // anymore: return them to pending so the resumed run (and the
        // dashboard) sees them as work still to do. Completed rows are
        // untouched — they are the checkpoint being resumed from.
        for (const subtask of subtaskRows) {
          if (subtask.status === "running") {
            await ctx.db.patch(subtask._id, {
              status: "pending",
              startedAt: undefined,
            });
          }
        }
        await appendTaskEvent(ctx, {
          taskId: task._id,
          projectId: task.projectId,
          type: "task.recovered",
          payload: {
            action: "requeued",
            reason: "stale_lease",
            workerId: task.workerId ?? null,
            recoveryCount: recoveryCount + 1,
          },
          level: "warn",
        });
        recovered.push(task._id);
        continue;
      }

      await supersedePendingCommandApprovals(ctx, task._id, "worker lease expired; task failed");
      await patchTask(ctx, task._id, {
        status: "failed",
        errorMessage: task.workerId
          ? `Worker lease expired (worker: ${task.workerId})`
          : "Worker lease missing",
        workerId: undefined,
        leaseExpiresAt: undefined,
        completedAt: now,
        updatedAt: now,
      });
      await appendTaskEvent(ctx, {
        taskId: task._id,
        projectId: task.projectId,
        type: "task.recovered",
        payload: {
          action: "failed",
          reason: planValid
            ? "recovery_bound_exceeded"
            : "no_valid_stored_plan",
          workerId: task.workerId ?? null,
          recoveryCount,
        },
        level: "warn",
      });
      await openIncident(ctx, { taskId: task._id, trigger: "task_failed", stage: "recovery" });
      recovered.push(task._id);
    }

    const executions = await ctx.db
      .query("executions")
      .withIndex("by_status_and_lease", (q) =>
        q.eq("status", "running").lt("leaseExpiresAt", now)
      )
      .take(RECOVERY_BATCH * 4);
    let recoveredExecutions = 0;
    for (const execution of executions) {
      // Lease expiry + no heartbeat (plan 022): the execution lease is
      // renewed by the same heartbeat as its task's. When the owning
      // worker still holds a live TASK lease it is alive and heartbeating;
      // a lapsed execution lease alone is not proof the run is dead.
      const owner = await ctx.db.get(execution.taskId);
      if (
        owner &&
        owner.workerId === execution.workerId &&
        (owner.leaseExpiresAt ?? 0) >= now &&
        (owner.status === "running" || owner.status === "needs_approval" || owner.status === "paused")
      ) {
        continue;
      }
      await ctx.db.patch(execution._id, {
        status: "failed",
        error: "Worker lease expired during execution",
        completedAt: now,
        // Ended by recovery, not by its worker: the next dispatch of the
        // same attempt reclaims this row instead of adding a duplicate.
        leaseLost: true,
      });
      recoveredExecutions++;
      await refreshAgentStatus(ctx, execution.agentId);
    }

    const staleWorkers = await ctx.db
      .query("workers")
      .withIndex("by_status_and_heartbeat", (q) =>
        q.eq("status", "online").lt("lastHeartbeatAt", now - staleGraceMs)
      )
      .take(RECOVERY_BATCH);
    for (const worker of staleWorkers) {
      await ctx.db.patch(worker._id, { status: "offline", activeTasks: 0 });
    }

    // An approval resume claim whose worker died: the task is still
    // needs_approval, its claim consumed the signal, and recovery above only
    // looks at running. Release the dead claim and re-signal so any worker
    // resumes it (the approvals are still resolved).
    const deadResumes = await ctx.db
      .query("tasks")
      .withIndex("by_status_and_lease", (q) =>
        q.eq("status", "needs_approval").gt("leaseExpiresAt", 0).lt("leaseExpiresAt", now)
      )
      .take(RECOVERY_BATCH);
    for (const task of deadResumes) {
      if (!task.workerId) continue;
      await ctx.db.patch(task._id, { workerId: undefined, leaseExpiresAt: undefined, updatedAt: now });
      const resolved = (
        await ctx.db
          .query("approvals")
          .withIndex("by_task", (q) => q.eq("taskId", task._id))
          .collect()
      ).filter((a) => RESUMABLE_APPROVAL_KINDS.has(a.kind) && (a.status === "approved" || a.status === "rejected"));
      const latest = resolved.sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))[0];
      if (latest) {
        await ctx.db.insert("taskSignals", {
          taskId: task._id,
          projectId: task.projectId,
          name: "approval",
          approvalId: latest._id,
          approvalKind: latest.kind,
          decision: latest.status === "approved" ? "approved" : "rejected",
          createdAt: now,
        });
      }
      await appendTaskEvent(ctx, {
        taskId: task._id,
        projectId: task.projectId,
        type: "task.recovered",
        payload: { action: "resignalled", reason: "resume_claim_lease_expired", workerId: task.workerId },
        level: "warn",
      });
      recovered.push(task._id);
    }

    // Approval signals whose task left needs_approval some other way
    // (cancelled, failed, retried) would otherwise sit at the head of the
    // resumable scan forever. Consume them as stale.
    const openSignals = await ctx.db
      .query("taskSignals")
      .withIndex("by_name_and_consumed", (q) => q.eq("name", "approval").eq("consumedAt", undefined))
      .take(RECOVERY_BATCH);
    for (const signal of openSignals) {
      const task = await ctx.db.get(signal.taskId);
      if (task && (task.status === "needs_approval" || task.status === "queued")) continue;
      await ctx.db.patch(signal._id, { consumedAt: now, consumedBy: "stale" });
    }

    return { recoveredTasks: recovered.length, recoveredExecutions };
  },
});

export const setPlanning = internalMutation({
  args: {
    taskId: v.id("tasks"),
    classification: v.string(),
    strategy: v.string(),
    planVersion: v.number(), responseOwner: v.optional(v.string()), // O2: the role that reports the outcome
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) {
      throw new Error(LEASE_LOST_ERROR);
    }
    await ctx.db.patch(args.taskId, {
      classification: args.classification,
      strategy: args.strategy,
      planVersion: args.planVersion, ...(args.responseOwner ? { responseOwner: args.responseOwner } : {}),
      updatedAt: Date.now(),
    });
  },
});

export const savePlan = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    version: v.number(),
    strategy: v.string(),
    createdBy: v.union(v.literal("orchestrator"), v.literal("fallback")),
    goal: v.string(),
    payload: v.any(),
    subtasks: v.array(
      v.object({
        key: v.string(),
        title: v.string(),
        description: v.string(),
        kind: subtaskKind,
        capability: v.string(),
        dependencies: v.array(v.string()),
        order: v.number(),
        allowedPaths: v.optional(v.array(v.string())),
        // worker.savePlan accepts `origin`; the internal validator must too
        // or a plan carrying it fails validation.
        origin: v.optional(v.string()),
        reviewRound: v.optional(v.number()),
        ...subtaskContractFields,
      })
    ),
    /** Why the plan is a deterministic fallback (shown in the task UI). */
    degradedReason: v.optional(v.string()),
    /** Task Estimator result (lib/estimate.ts), computed before execution. */
    estimate: v.optional(v.any()),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Lease fencing (core M2): a displaced worker must not replace the new
    // owner's plan and subtask rows.
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) {
      throw new Error(LEASE_LOST_ERROR);
    }
    const { workerId: _workerId, ...plan } = args;
    return await writePlanVersion(ctx, plan);
  },
});

/**
 * Persist dynamically spawned subtasks (Phase 4 hardening): the
 * delegation and fix subtasks the orchestrator adds mid-run (Phase 3)
 * previously lived only in the worker's memory, so a worker restart
 * lost them and recovery could only rebuild the initial plan.
 *
 * A write whose `version` is not the stored plan's version is refused as
 * a whole (no rows, no payload merge): nodes spawned under a superseded
 * plan must not pollute the current one (core M4).
 *
 * Two writes, both idempotent and safe against concurrent callers:
 *  1. PLAN CHECKPOINT — the current plan row's payload is extended
 *     with the subtasks it does not already contain, merged BY KEY.
 *     Only applied when the stored plan's version matches the version
 *     the nodes were spawned under (a stale write from a superseded
 *     plan version must not pollute the current plan). Merging by key
 *     means a repeated or racing call converges to the same payload
 *     instead of duplicating nodes.
 *  2. SUBTASK ROWS — insert-only upsert by (taskId, key) via the
 *     by_task_and_key index: a missing key is inserted as "pending"
 *     with its full definition (dependencies, capability, origin); an
 *     existing row is NEVER patched here, so a late persist can never
 *     resurrect or downgrade a row that has already started or
 *     completed (monotonic status, see monotonicSubtaskStatus).
 * Convex mutations execute serially, so the check-then-insert cannot
 * interleave with another mutation; combined with the key-stable
 * upsert this makes the whole operation safe to call twice, or from
 * two outcomes settling at the same moment.
 */
export const upsertDynamicSubtasks = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    version: v.number(),
    payload: v.any(),
    subtasks: v.array(
      v.object({
        key: v.string(),
        title: v.string(),
        description: v.string(),
        kind: subtaskKind,
        capability: v.string(),
        dependencies: v.array(v.string()),
        order: v.number(),
        allowedPaths: v.optional(v.array(v.string())),
        origin: v.optional(v.string()),
        reviewRound: v.optional(v.number()),
        ...subtaskContractFields,
      })
    ),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const inserted: string[] = [];
    const existing: string[] = [];

    // Lease fencing (core M2): refused as a value, the caller treats
    // persistence as best-effort.
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) {
      return { inserted, existing, payloadUpdated: false, refused: "lease_lost" as const };
    }

    // Version check FIRST (core M4): a late write from a superseded plan
    // version must not add rows to the current plan — not just skip the
    // payload merge. With no plan row at all (legacy), rows are accepted.
    const plans = await ctx.db
      .query("plans")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(1);
    const planRow = plans[0];
    if (planRow && planRow.version !== args.version) {
      await appendTaskEvent(ctx, {
        taskId: args.taskId,
        projectId: args.projectId,
        type: "plan.dynamic_subtasks_stale",
        payload: {
          version: args.version,
          currentVersion: planRow.version,
          keys: args.subtasks.map((subtask) => subtask.key),
        },
        level: "warn",
      });
      return { inserted, existing, payloadUpdated: false, stale: true as const };
    }

    for (const subtask of args.subtasks) {
      const row = await ctx.db
        .query("subtasks")
        .withIndex("by_task_and_key", (q) =>
          q.eq("taskId", args.taskId).eq("key", subtask.key)
        )
        .unique();
      if (row) {
        existing.push(subtask.key);
        // A re-run review node keeps its row; only its round advances.
        if (subtask.reviewRound !== undefined && row.reviewRound !== subtask.reviewRound) {
          await ctx.db.patch(row._id, { reviewRound: subtask.reviewRound });
        }
        continue;
      }
      await ctx.db.insert("subtasks", {
        taskId: args.taskId,
        projectId: args.projectId,
        key: subtask.key,
        title: subtask.title,
        description: subtask.description,
        kind: subtask.kind,
        capability: subtask.capability,
        dependencies: subtask.dependencies,
        order: subtask.order,
        allowedPaths: subtask.allowedPaths,
        reviewRound: subtask.reviewRound,
        ...contractDefinition(subtask),
        status: "pending",
        origin: subtask.origin ?? "dynamic",
        attempts: 0,
      });
      inserted.push(subtask.key);
    }

    let payloadUpdated = false;
    if (planRow && planRow.version === args.version) {
      const currentPayload = (planRow.payload ?? {}) as {
        subtasks?: Array<{ key: string }>;
      };
      const currentSubtasks = Array.isArray(currentPayload.subtasks)
        ? currentPayload.subtasks
        : [];
      const knownKeys = new Set(currentSubtasks.map((subtask) => subtask.key));
      const incoming = (
        args.payload as { subtasks?: Array<{ key: string }> } | null
      )?.subtasks;
      const additions = Array.isArray(incoming)
        ? incoming.filter((subtask) => !knownKeys.has(subtask.key))
        : [];
      if (additions.length > 0) {
        await ctx.db.patch(planRow._id, {
          payload: {
            ...currentPayload,
            subtasks: [...currentSubtasks, ...additions],
          },
        });
        payloadUpdated = true;
      }
    }

    await appendTaskEvent(ctx, {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "plan.dynamic_subtasks_persisted",
      payload: {
        version: args.version,
        inserted,
        existing,
        payloadUpdated,
        payloadVersionMatched: Boolean(
          planRow && planRow.version === args.version
        ),
      },
      level: "info",
    });
    return { inserted, existing, payloadUpdated };
  },
});

/** `${taskId}/${subtaskKey}/attempt-N` (plan 022). */
export function dispatchKeyFor(taskId: string, subtaskKey: string, attempt: number): string {
  return `${taskId}/${subtaskKey}/attempt-${attempt}`;
}

/**
 * An execution a worker settled itself. `waiting_approval` is finished
 * work (its output waits for the user); a lease-lost row was ended by
 * recovery, not by its worker, so it does not count.
 */
function settledByWorker(execution: Doc<"executions">): boolean {
  return (
    (execution.status === "completed" ||
      execution.status === "failed" ||
      execution.status === "cancelled" ||
      execution.status === "waiting_approval") &&
    execution.leaseLost !== true
  );
}

type DispatchResolution =
  | { kind: "new"; dispatchKey: string }
  | {
      kind: "reuse";
      dispatchKey: string;
      execution: Doc<"executions">;
      /** same_worker: a retried claim; lease_expired: the dead owner's attempt is reclaimed. */
      reason: "same_worker" | "lease_expired";
    }
  | { kind: "in_flight_elsewhere"; dispatchKey: string; workerId: string };

/**
 * Plan 022: decide what one dispatch claim does. Never duplicates an
 * attempt: an in-flight row with the same key is reused when it is this
 * worker's or its lease lapsed (no heartbeat renewed it), refused while
 * another live worker holds it. A finished attempt advances N, so a
 * legitimate re-run (QA round, replan) gets a fresh key, and completed
 * subtasks are skipped earlier by the stored checkpoint.
 */
export async function resolveDispatch(
  ctx: MutationCtx,
  args: { taskId: Id<"tasks">; subtaskKey: string; workerId: string; now: number }
): Promise<DispatchResolution> {
  const prior = (
    await ctx.db
      .query("executions")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect()
  ).filter((execution) => execution.subtaskKey === args.subtaskKey);
  const attempt = prior.filter(settledByWorker).length + 1;
  const dispatchKey = dispatchKeyFor(args.taskId, args.subtaskKey, attempt);
  const sameKey = await ctx.db
    .query("executions")
    .withIndex("by_dispatch_key", (q) => q.eq("dispatchKey", dispatchKey))
    .take(5);
  // Legacy rows (no dispatchKey) that are still in flight count as the
  // same attempt: they are what a pre-022 worker left behind.
  const candidates = [
    ...sameKey,
    ...prior.filter((execution) => !execution.dispatchKey && !settledByWorker(execution)),
  ];
  const existing = candidates
    .filter((execution) => !settledByWorker(execution))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!existing) return { kind: "new", dispatchKey };
  const live = existing.status === "running" || existing.status === "queued";
  const leaseExpired = (existing.leaseExpiresAt ?? 0) < args.now;
  if (live && !leaseExpired && existing.workerId !== args.workerId) {
    return { kind: "in_flight_elsewhere", dispatchKey, workerId: existing.workerId };
  }
  if (existing.workerId === args.workerId && live && !leaseExpired) {
    return { kind: "reuse", dispatchKey, execution: existing, reason: "same_worker" };
  }
  return { kind: "reuse", dispatchKey, execution: existing, reason: "lease_expired" };
}

export const startExecution = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    subtaskKey: v.string(),
    agentId: v.optional(v.id("agents")),
    agentName: v.string(),
    capability: v.string(),
    workerId: v.string(),
    attempt: v.number(),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Id<"executions">> => {
    // Lease fencing (core M2/M3): only the current lease owner may start
    // work on the task. A worker whose task was requeued, cancelled or
    // handed to another worker stops here instead of racing the new owner.
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) {
      throw new Error(LEASE_LOST_ERROR);
    }
    const now = Date.now();
    const leaseMs = args.leaseMs ?? DEFAULT_LEASE_MS;
    const subtask = await ctx.db
      .query("subtasks")
      .withIndex("by_task_and_key", (q) =>
        q.eq("taskId", args.taskId).eq("key", args.subtaskKey)
      )
      .unique();

    // Plan 022 dispatch idempotency: the claim is keyed
    // `${taskId}/${subtaskKey}/attempt-N`, N = 1 + the attempts a worker
    // actually settled (a lease-lost row does not count, so the re-dispatch
    // after a lease expiry / worker restart lands on the SAME key).
    const dispatch = await resolveDispatch(ctx, {
      taskId: args.taskId,
      subtaskKey: args.subtaskKey,
      workerId: args.workerId,
      now,
    });
    if (dispatch.kind === "in_flight_elsewhere") {
      throw new Error(
        `Dispatch in flight: ${dispatch.dispatchKey} is still running on worker ${dispatch.workerId}`
      );
    }
    if (dispatch.kind === "reuse") {
      await ctx.db.patch(dispatch.execution._id, {
        status: "running",
        dispatchKey: dispatch.dispatchKey,
        attempt: args.attempt,
        workerId: args.workerId,
        agentId: args.agentId,
        agentName: args.agentName,
        leaseExpiresAt: now + leaseMs,
        startedAt: dispatch.execution.startedAt ?? now,
        completedAt: undefined,
        error: undefined,
        leaseLost: undefined,
      });
      if (subtask) {
        await ctx.db.patch(subtask._id, {
          status: "running",
          assignedAgentId: args.agentId,
          assignedAgentName: args.agentName,
          startedAt: subtask.startedAt ?? now,
        });
      }
      await appendTaskEvent(ctx, {
        taskId: args.taskId,
        projectId: args.projectId,
        type: "subtask.dispatch_reused",
        payload: {
          subtaskKey: args.subtaskKey,
          dispatchKey: dispatch.dispatchKey,
          reason: dispatch.reason,
          previousWorkerId: dispatch.execution.workerId,
        },
        executionId: dispatch.execution._id,
        subtaskKey: args.subtaskKey,
        level: dispatch.reason === "lease_expired" ? "warn" : "info",
      });
      return dispatch.execution._id;
    }

    if (subtask) {
      await ctx.db.patch(subtask._id, {
        status: "running",
        assignedAgentId: args.agentId,
        assignedAgentName: args.agentName,
        attempts: args.attempt,
        startedAt: now,
      });
    } else {
      await ctx.db.insert("subtasks", {
        taskId: args.taskId,
        projectId: args.projectId,
        key: args.subtaskKey,
        title: args.subtaskKey,
        description: "",
        kind: "analysis",
        capability: args.capability,
        dependencies: [],
        order: 0,
        status: "running",
        assignedAgentId: args.agentId,
        assignedAgentName: args.agentName,
        attempts: args.attempt,
        startedAt: now,
      });
    }

    const executionId = await ctx.db.insert("executions", {
      taskId: args.taskId,
      projectId: args.projectId,
      subtaskId: subtask?._id,
      subtaskKey: args.subtaskKey,
      agentId: args.agentId,
      agentName: args.agentName,
      capability: args.capability,
      workerId: args.workerId,
      status: "running",
      attempt: args.attempt,
      leaseExpiresAt: now + leaseMs,
      startedAt: now,
      createdAt: now,
      dispatchKey: dispatch.dispatchKey,
    });

    if (args.agentId) {
      const agent = await ctx.db.get(args.agentId);
      if (agent && agent.status !== "needs_you") {
        await ctx.db.patch(args.agentId, { status: "working" });
      }
    }

    await appendTaskEvent(ctx, {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "subtask.started",
      payload: {
        subtaskKey: args.subtaskKey,
        agent: args.agentName,
        capability: args.capability,
        attempt: args.attempt,
        dispatchKey: dispatch.dispatchKey,
      },
      executionId,
      subtaskKey: args.subtaskKey,
      level: "info",
    });

    return executionId;
  },
});

export const updateExecution = internalMutation({
  args: {
    executionId: v.id("executions"),
    subtaskKey: v.optional(v.string()),
    status: executionStatus,
    output: v.optional(v.string()),
    error: v.optional(v.string()),
    meta: v.optional(v.any()),
    leaseMs: v.optional(v.number()),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const execution = await ctx.db.get(args.executionId);
    if (!execution) throw new Error("Execution not found");
    // Lease fencing (core M2): a displaced worker must not settle the new
    // owner's subtask rows. Refused as a value.
    if (!(await holdsTaskLease(ctx, execution.taskId, args.workerId))) {
      return { applied: false as const, reason: "lease_lost" as const };
    }
    // An execution the user cancelled stays cancelled.
    if (execution.status === "cancelled" && args.status !== "cancelled") {
      return { applied: false as const, reason: "execution_cancelled" as const };
    }
    const subtaskKey = args.subtaskKey ?? execution.subtaskKey;

    await ctx.db.patch(args.executionId, {
      status: args.status,
      output: args.output ?? execution.output,
      error: args.error,
      meta: args.meta ?? execution.meta,
      leaseExpiresAt:
        args.status === "running" || args.status === "queued"
          ? now + (args.leaseMs ?? DEFAULT_LEASE_MS)
          : undefined,
      completedAt:
        args.status === "completed" || args.status === "failed" || args.status === "cancelled"
          ? now
          : undefined,
    });

    if (subtaskKey) {
      const subtask = await ctx.db
        .query("subtasks")
        .withIndex("by_task_and_key", (q) =>
          q.eq("taskId", execution.taskId).eq("key", subtaskKey)
        )
        .unique();
      if (subtask) {
        // A command the user declined (Tolak / Deny) settles the node but
        // is not work done: the subtask is `skipped` with the reason.
        const declined = commandDeclinedReason(args.status, args.meta);
        const mapped =
          declined !== null
            ? "skipped"
            : args.status === "completed"
            ? "completed"
            : args.status === "failed"
              ? "failed"
              : args.status === "waiting_approval"
                ? "waiting_approval"
                : args.status === "cancelled"
                  ? "blocked"
                  : "running";
        // Monotonic (Phase 4 hardening): a late update for an older
        // attempt must not rewrite a row that has since completed.
        const nextStatus = monotonicSubtaskStatus(
          subtask.status,
          mapped
        ) as typeof mapped;
        await ctx.db.patch(subtask._id, {
          status: nextStatus,
          output: args.output ?? subtask.output,
          error: declined ?? args.error,
          completedAt:
            nextStatus === "completed" || nextStatus === "failed" || nextStatus === "skipped"
              ? now
              : undefined,
          // Plan 022: executor "done" is only delivered; the acceptance
          // stage evaluates the gates (a fresh delivery re-opens them).
          ...(args.status === "completed" && nextStatus === "completed"
            ? { acceptanceStatus: "delivered" as const, acceptanceReason: undefined, gateResults: undefined, escalation: undefined }
            : {}),
        });
      }
    }

    await refreshAgentStatus(ctx, execution.agentId);

    await appendTaskEvent(ctx, {
      taskId: execution.taskId,
      projectId: execution.projectId,
      type: `subtask.${args.status}`,
      payload: {
        subtaskKey,
        agent: execution.agentName,
        ...(args.error ? { error: args.error.slice(0, 500) } : {}),
      },
      executionId: args.executionId,
      subtaskKey: subtaskKey ?? undefined,
      level: args.status === "failed" ? "error" : "info",
    });
    // Plan 025: agent_completed / agent_failed / provider_error / no_progress.
    await recordObservationsForEvent(ctx, execution.taskId, execution.projectId, {
      type: `subtask.${args.status}`,
      payload: { subtaskKey, ...(args.error ? { error: args.error } : {}) },
      subtaskKey: subtaskKey ?? undefined,
      executionId: args.executionId,
      agentId: execution.agentId,
      createdAt: now,
    });
    return { applied: true as const };
  },
});

export const requestApproval = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    executionId: v.optional(v.id("executions")),
    subtaskKey: v.optional(v.string()),
    kind: v.union(
      v.literal("apply_changes"),
      v.literal("git_push"),
      v.literal("run_command"),
      v.literal("merge_pr")
    ),
    summary: v.string(),
    payload: v.optional(v.any()),
    requestedByAgentId: v.optional(v.id("agents")),
    planVersion: v.optional(v.number()),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"approvals">> => {
    const now = Date.now();
    const existing = await ctx.db
      .query("approvals")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    // Terminal guard (Phase 4 hardening): this mutation moves the task
    // to needs_approval — a status transition — so a late request from
    // a worker whose task was already cancelled/completed must not
    // resurrect it. An approval that already exists is returned as-is;
    // otherwise the request is refused with a clear error (the caller
    // is already winding down: its task is over).
    const task = await ctx.db.get(args.taskId);
    if (task && TERMINAL_TASK_STATUSES.has(task.status)) {
      const prior = existing.find((approval) => approval.kind === args.kind);
      if (prior) return prior._id;
      throw new Error(
        `Task is already ${task.status}; approvals can no longer be requested`
      );
    }
    // Lease fencing (core M2): a displaced worker must not move the new
    // owner's task to needs_approval and clear its lease.
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) {
      throw new Error(LEASE_LOST_ERROR);
    }
    const pending = existing.find(
      (approval) =>
        approval.status === "pending" &&
        approval.kind === args.kind &&
        (approval.subtaskKey ?? null) === (args.subtaskKey ?? null)
    );
    if (pending) return pending._id;

    const approvalId = await ctx.db.insert("approvals", {
      taskId: args.taskId,
      projectId: args.projectId,
      kind: args.kind,
      summary: args.summary,
      payload: args.payload,
      requestedByAgentId: args.requestedByAgentId,
      executionId: args.executionId,
      subtaskKey: args.subtaskKey,
      planVersion: args.planVersion,
      status: "pending",
    });

    await patchTask(ctx, args.taskId, {
      status: "needs_approval",
      updatedAt: now,
      workerId: undefined,
      leaseExpiresAt: undefined,
    });

    if (args.executionId) {
      await ctx.db.patch(args.executionId, {
        status: "waiting_approval",
        leaseExpiresAt: undefined,
      });
    }
    if (args.subtaskKey) {
      const subtask = await ctx.db
        .query("subtasks")
        .withIndex("by_task_and_key", (q) =>
          q.eq("taskId", args.taskId).eq("key", args.subtaskKey as string)
        )
        .unique();
      if (subtask) {
        // The approval is about applying the subtask's OUTPUT; it must not
        // demote a finished subtask back to waiting_approval. Doing so made
        // a resumed run read the row as unfinished and execute it again.
        const nextStatus = monotonicSubtaskStatus(
          subtask.status,
          "waiting_approval"
        ) as typeof subtask.status;
        await ctx.db.patch(subtask._id, { status: nextStatus });
      }
    }

    await appendTaskEvent(ctx, {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "approval.requested",
      payload: { kind: args.kind, summary: args.summary, subtaskKey: args.subtaskKey },
      executionId: args.executionId,
      subtaskKey: args.subtaskKey,
      level: "warn",
    });
    return approvalId;
  },
});

/**
 * Plan 020: approve an approval automatically under the task's permission
 * mode. The worker asks; the backend decides again from the task row (a
 * worker cannot raise its own mode). When the mode allows it, the approval
 * row is written already `approved` with `decidedBy: "auto"`, plus an
 * `approval.auto_approved` event and an audit row, and the task is NOT
 * moved to needs_approval: no pause, no resume. When it does not, nothing
 * is written and the caller requests a normal approval.
 */
export const autoApprove = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    subtaskKey: v.optional(v.string()),
    kind: v.union(
      v.literal("apply_changes"),
      v.literal("git_push"),
      v.literal("run_command"),
      v.literal("merge_pr")
    ),
    summary: v.string(),
    payload: v.optional(v.any()),
    requestedByAgentId: v.optional(v.id("agents")),
    planVersion: v.optional(v.number()),
    workerId: v.optional(v.string()),
    risk: v.optional(
      v.object({
        deletes: v.optional(v.number()),
        policyFlagged: v.optional(v.boolean()),
        outsideWorkspace: v.optional(v.boolean()),
      })
    ),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ autoApproved: boolean; reason: string; mode: PermissionMode; approvalId?: Id<"approvals"> }> => {
    const task = await ctx.db.get(args.taskId);
    const mode = normalizePermissionMode(task?.permissionMode);
    if (!task || task.projectId !== args.projectId) {
      return { autoApproved: false, reason: "Task not found", mode };
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      return { autoApproved: false, reason: `Task is already ${task.status}`, mode };
    }
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) {
      throw new Error(LEASE_LOST_ERROR);
    }
    const decision = autoApprovalDecision(mode, args.kind, args.risk ?? {});
    if (!decision.auto) {
      return { autoApproved: false, reason: decision.reason, mode };
    }
    const now = Date.now();
    const historyEntry = { at: now, status: "approved", by: "auto", mode };
    // A pending row for the same action (e.g. asked before the mode
    // allowed it) is resolved instead of leaving a stale card behind.
    const pending = (
      await ctx.db
        .query("approvals")
        .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
        .collect()
    ).find(
      (approval) =>
        approval.status === "pending" &&
        approval.kind === args.kind &&
        (approval.subtaskKey ?? null) === (args.subtaskKey ?? null)
    );
    let approvalId: Id<"approvals">;
    if (pending) {
      approvalId = pending._id;
      await ctx.db.patch(pending._id, {
        status: "approved",
        resolvedAt: now,
        decidedBy: "auto",
        summary: args.summary,
        payload: args.payload,
        planVersion: args.planVersion,
        history: [...(pending.history ?? []), historyEntry],
      });
    } else {
      approvalId = await ctx.db.insert("approvals", {
        taskId: args.taskId,
        projectId: args.projectId,
        kind: args.kind,
        summary: args.summary,
        payload: args.payload,
        requestedByAgentId: args.requestedByAgentId,
        subtaskKey: args.subtaskKey,
        planVersion: args.planVersion,
        status: "approved",
        resolvedAt: now,
        decidedBy: "auto",
        history: [historyEntry],
      });
    }
    await appendTaskEvent(ctx, {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "approval.auto_approved",
      payload: { kind: args.kind, summary: args.summary, subtaskKey: args.subtaskKey, mode },
      subtaskKey: args.subtaskKey,
      level: "info",
    });
    await recordAudit(ctx, {
      actor: "permission-mode",
      tool: "approval",
      action: "approval.auto_approve",
      decision: "allowed",
      target: args.summary,
      projectId: args.projectId,
      taskId: args.taskId,
      details: { kind: args.kind, mode, approvalId },
    });
    return { autoApproved: true, reason: decision.reason, mode, approvalId };
  },
});

/** Plan 015: worker-side permission decision (internal; surfaced to the
 *  worker through its token-gated action). Uses the same core as the
 *  public `permissionBroker.decidePermission` query. */
export const checkPermission = internalQuery({
  args: permissionArgs,
  handler: async (ctx, args) => {
    // Reached only through the service-token action worker.checkPermission:
    // the worker has no viewer identity, so the viewer-based project check
    // would deny every owned project (core H4a). The token is the authz.
    return await decidePermissionCore(ctx, args, { trusted: true });
  },
});

export const claimResumableTask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workerId: v.string(),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.status !== "needs_approval") return null;
    // A user pause on a parked task only records intent; it holds here.
    if (task.pausedBy) return null;
    const now = Date.now();
    if (task.workerId && task.workerId !== args.workerId && (task.leaseExpiresAt ?? 0) >= now) {
      return null;
    }
    // Delivering the wake-up: consume the task's approval signals.
    await consumeTaskSignals(ctx, task._id, "approval", args.workerId);
    const leaseExpiresAt = now + (args.leaseMs ?? DEFAULT_LEASE_MS);
    await ctx.db.patch(task._id, { workerId: args.workerId, leaseExpiresAt, updatedAt: now });
    await appendTaskEvent(ctx, {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.claimed",
      payload: { workerId: args.workerId, reason: "approval_resume" },
      level: "info",
    });
    return { ...task, workerId: args.workerId, leaseExpiresAt };
  },
});

export const getResumableTasks = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Durable signals: only tasks an approve/reject signalled are
    // candidates, read through the unconsumed-signal index (oldest first),
    // instead of scanning every parked task and letting the worker filter.
    const signals = await ctx.db
      .query("taskSignals")
      .withIndex("by_name_and_consumed", (q) => q.eq("name", "approval").eq("consumedAt", undefined))
      .order("asc")
      .take(RESUMABLE_SCAN_LIMIT);
    const seen = new Set<string>();
    const tasks: Doc<"tasks">[] = [];
    for (const signal of signals) {
      if (seen.has(signal.taskId)) continue;
      seen.add(signal.taskId);
      const task = await ctx.db.get(signal.taskId);
      if (!task || task.status !== "needs_approval" || task.pausedBy) continue;
      tasks.push(task);
    }
    const results = [];
    for (const task of tasks) {
      const approvals = await ctx.db
        .query("approvals")
        .withIndex("by_task", (q) => q.eq("taskId", task._id))
        .collect();
      const pending = approvals.filter((approval) => approval.status === "pending");
      const resolved = approvals.filter((approval) => approval.status !== "pending");
      results.push({ task, pendingCount: pending.length, approvals: resolved });
    }
    return results;
  },
});

export const getTaskApprovals = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("approvals")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
  },
});

export const getTaskFileChanges = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("fileChanges")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
  },
});

export const saveFileChange = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    filePath: v.string(),
    changeType: v.union(
      v.literal("new"),
      v.literal("modified"),
      v.literal("deleted")
    ),
    oldContent: v.optional(v.string()),
    newContent: v.optional(v.string()),
    oldContentHash: v.optional(v.string()),
    newContentHash: v.optional(v.string()),
    diff: v.string(),
    subtaskKey: v.optional(v.string()),
    executionId: v.optional(v.id("executions")),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Lease fencing (plan 011): a displaced worker must not stage files
    // into a task another worker now owns.
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) return null;
    const { workerId: _workerId, ...fields } = args;
    const existing = await ctx.db
      .query("fileChanges")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    const match = existing.find((change) => change.filePath === args.filePath);
    if (match) {
      await ctx.db.patch(match._id, { ...fields });
      return match._id;
    }
    return await ctx.db.insert("fileChanges", fields);
  },
});

/**
 * Drop a staged (not yet applied) file change: a later subtask of the same
 * task reverted the file to its pre-task content (e.g. a review fix that
 * deletes a block an earlier node added). Applied rows are never removed.
 */
export const discardFileChange = internalMutation({
  args: {
    taskId: v.id("tasks"),
    filePath: v.string(),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) return false;
    const existing = await ctx.db
      .query("fileChanges")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    const match = existing.find((change) => change.filePath === args.filePath);
    if (!match || match.appliedAt) return false;
    await ctx.db.delete(match._id);
    return true;
  },
});

export const markFileChangesApplied = internalMutation({
  args: {
    taskId: v.id("tasks"),
    filePaths: v.array(v.string()),
    workerId: v.string(),
  },
  handler: async (ctx, args) => {
    // Lease fencing: a displaced worker must not stamp the new owner's
    // file rows as applied.
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) return;
    const now = Date.now();
    const changes = await ctx.db
      .query("fileChanges")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    for (const change of changes) {
      if (!args.filePaths.includes(change.filePath)) continue;
      await ctx.db.patch(change._id, {
        appliedAt: now,
        appliedByWorkerId: args.workerId,
      });
    }
  },
});

/** Subtask statuses that still claim future work. */
const OPEN_SUBTASK_STATUSES = ["pending", "ready", "blocked", "waiting_approval", "running"] as const;
const OPEN_SUBTASK_LIMIT = 200;

/**
 * A terminal task leaves no subtask open (e2e ULTRA: QA and follow-up nodes
 * stayed `pending` on a failed task forever). Not-started rows become
 * `skipped`; a row still marked `running` becomes `failed` — its worker run
 * is over. Each closed row carries the reason.
 */
export async function closeOpenSubtasks(ctx: MutationCtx, taskId: Id<"tasks">, taskStatus: string): Promise<number> {
  const now = Date.now();
  let closed = 0;
  for (const status of OPEN_SUBTASK_STATUSES) {
    const rows = await ctx.db
      .query("subtasks")
      .withIndex("by_task_and_status", (q) => q.eq("taskId", taskId).eq("status", status))
      .take(OPEN_SUBTASK_LIMIT);
    for (const row of rows) {
      const wasRunning = status === "running";
      await ctx.db.patch(row._id, {
        status: wasRunning ? "failed" : "skipped",
        error: row.error ?? (wasRunning ? `Task ${taskStatus} while this subtask was running` : `Not run: task ${taskStatus}`),
        completedAt: row.completedAt ?? now,
      });
      closed += 1;
    }
  }
  return closed;
}

export const completeTask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    status: taskStatus,
    errorMessage: v.optional(v.string()),
    /** A Done that comes with a caveat, e.g. "QA blocked: …". Only stored on done. */
    completionWarning: v.optional(v.string()),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    // Terminal guard (Phase 4 hardening): a task that already reached
    // a terminal status keeps it. A worker that finishes late — after
    // a user cancellation, a recovery failure, or another worker's
    // completion — gets a clear refusal VALUE ({ applied: false }),
    // not an error, so it can stop cleanly; the stored outcome, its
    // error message and its completion timestamp are left untouched.
    // Checked before the lease so a cancelled task (whose owner was
    // cleared) still reports "task_already_terminal".
    const before = await ctx.db.get(args.taskId);
    if (before && TERMINAL_TASK_STATUSES.has(before.status)) {
      return {
        applied: false,
        reason: "task_already_terminal" as const,
        status: before.status,
      };
    }
    // Lease fencing (plan 011): a displaced worker must not settle a task
    // another worker now owns. Refused as a VALUE so the old worker stops.
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) {
      return { applied: false, reason: "lease_lost" as const };
    }
    // O3 + L7: a run that failed because the LLM provider is offline,
    // rate-limited (429), out of quota or refusing its credentials is put
    // on hold (paused, pausedBy "held") and resumes with backoff instead
    // of failing. No incident, no FAILED transition.
    if (args.status === "failed" && before) {
      const hold = classifyTaskHold(args.errorMessage);
      if (hold) {
        const held = await holdTaskForProvider(ctx, before, hold, args.errorMessage);
        return { applied: true, status: "paused" as const, held: true, resumeAt: held.resumeAt };
      }
    }
    await patchTask(ctx, args.taskId, {
      status: args.status,
      errorMessage: args.errorMessage,
      completionWarning:
        args.status === "done" && args.completionWarning?.trim() ? args.completionWarning.trim().slice(0, 500) : undefined,
      completedAt: now,
      updatedAt: now,
      workerId: undefined,
      leaseExpiresAt: undefined,
    });
    const task = await ctx.db.get(args.taskId);
    if (task && TERMINAL_TASK_STATUSES.has(args.status)) {
      await closeOpenSubtasks(ctx, task._id, args.status);
    }
    if (task) {
      await appendTaskEvent(ctx, {
        taskId: task._id,
        projectId: task.projectId,
        type: `task.${args.status}`,
        payload: args.errorMessage
          ? { error: args.errorMessage.slice(0, 500) }
          : args.status === "done" && args.completionWarning?.trim()
            ? { warning: args.completionWarning.trim().slice(0, 500) }
            : {},
        level: args.status === "failed" ? "error" : "info",
      });
      const executions = await ctx.db
        .query("executions")
        .withIndex("by_task", (q) => q.eq("taskId", task._id))
        .collect();
      const agentIds = new Set(
        executions
          .map((execution) => execution.agentId)
          .filter((agentId): agentId is Id<"agents"> => Boolean(agentId))
      );
      for (const agentId of agentIds) await refreshAgentStatus(ctx, agentId);
      // Incident Room: a failed run opens an incident (read-only on the task).
      if (args.status === "failed") {
        await openIncident(ctx, { taskId: task._id, trigger: "task_failed", error: args.errorMessage });
      }
      // Decision Outcome Calibration: label this run's decisions (scheduled).
      if (TERMINAL_TASK_STATUSES.has(args.status)) await scheduleDecisionEvaluation(ctx, task._id);
      // Post-push feedback loop: a settled PR fix re-arms deferred
      // reactions and refreshes the owner's notifications.
      if (TERMINAL_TASK_STATUSES.has(args.status) && (task.prFix || task.reviewFix)) await onTaskSettled(ctx, { ...task, status: args.status });
      // O4: a task started from an issue moves the issue's status label.
      if (TERMINAL_TASK_STATUSES.has(args.status)) await onIssueTaskChanged(ctx, { ...task, status: args.status });
    }
    return { applied: true, status: args.status };
  },
});

export const setTaskStatus = internalMutation({
  args: { taskId: v.id("tasks"), status: taskStatus, workerId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // Terminal guard (Phase 4 hardening): same absorbing rule as
    // completeTask — a raw status write may not resurrect a terminal
    // task. Rewriting the SAME terminal status stays an idempotent yes
    // (nothing to write), anything else is refused with a false return.
    const task = await ctx.db.get(args.taskId);
    if (!task) return false;
    if (TERMINAL_TASK_STATUSES.has(task.status)) return task.status === args.status;
    // Lease fencing (B4, plan 049): only the lease owner moves the status.
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) return false;
    // A pause the user recorded while the task was parked on an approval
    // (taskControl.pause) takes effect when the resumed run leaves the
    // park: it drains as a paused task instead of running on.
    if (args.status === "running" && task.status === "needs_approval" && task.pausedBy) {
      await patchTask(ctx, args.taskId, { status: "paused", updatedAt: Date.now() });
      return true;
    }
    await patchTask(ctx, args.taskId, { status: args.status, updatedAt: Date.now() });
    return true;
  },
});

export const pauseForInput = internalMutation({
  args: {
    taskId: v.id("tasks"),
    question: v.string(),
    options: v.optional(v.array(v.string())),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Terminal guard: same absorbing rule as completeTask — a task that
    // already settled stays settled; the pause is refused with a clear
    // value so the caller can stop cleanly instead of asking a question
    // nobody can answer.
    const task = await ctx.db.get(args.taskId);
    if (!task) {
      return { applied: false, reason: "task_not_found" as const };
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      return {
        applied: false,
        reason: "task_already_terminal" as const,
        status: task.status,
      };
    }
    // Lease fencing (plan 011): a displaced worker must not pause a task
    // another worker now owns. Refused as a VALUE like completeTask.
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) {
      return { applied: false, reason: "lease_lost" as const };
    }
    const now = Date.now();
    // Options are optional A/B/C-style choices: deduped, trimmed, bounded
    // (2..6), and only kept when the question is a real question. Absent or
    // too few = the UI falls back to the free-text answer box.
    const options = (args.options ?? [])
      .map((option) => option.trim())
      .filter((option) => option.length > 0);
    const uniqueOptions = [...new Set(options)].slice(0, 6);
    await patchTask(ctx, args.taskId, {
      status: "waiting_input",
      pendingQuestion: args.question.slice(0, 2000),
      pendingOptions: uniqueOptions.length >= 2 ? uniqueOptions : undefined,
      updatedAt: now,
    });
    // Plan L3: the question is an open question on the task brief until answered.
    await touchBriefQuestion(ctx, task, { add: args.question });
    await appendTaskEvent(ctx, {
      taskId: task._id,
      projectId: task.projectId,
      type: "task.input_asked",
      payload: { question: args.question.slice(0, 500) },
      level: "info",
    });
    return { applied: true, status: "waiting_input" as const };
  },
});

/** Live activity line for a running subtask; ignored once it settled. */
export const setSubtaskActivity = internalMutation({
  args: {
    taskId: v.id("tasks"),
    key: v.string(),
    activity: v.string(),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) return false;
    const subtask = await ctx.db
      .query("subtasks")
      .withIndex("by_task_and_key", (q) => q.eq("taskId", args.taskId).eq("key", args.key))
      .unique();
    if (!subtask || subtask.status !== "running") return false;
    await ctx.db.patch(subtask._id, { activity: args.activity.slice(0, 160), activityAt: Date.now() });
    return true;
  },
});

export const updateSubtask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    key: v.string(),
    status: subtaskStatus,
    output: v.optional(v.string()),
    error: v.optional(v.string()),
    agentId: v.optional(v.id("agents")),
    agentName: v.optional(v.string()),
    workerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await holdsTaskLease(ctx, args.taskId, args.workerId))) return false;
    const subtask = await ctx.db
      .query("subtasks")
      .withIndex("by_task_and_key", (q) =>
        q.eq("taskId", args.taskId).eq("key", args.key)
      )
      .unique();
    if (!subtask) return false;
    // Monotonic (Phase 4 hardening): see monotonicSubtaskStatus — a
    // blocked/pending write that was issued before a completion landed
    // must not downgrade the completed row.
    const nextStatus = monotonicSubtaskStatus(
      subtask.status,
      args.status
    ) as typeof args.status;
    await ctx.db.patch(subtask._id, {
      status: nextStatus,
      output: args.output ?? subtask.output,
      error: args.error,
      assignedAgentId: args.agentId ?? subtask.assignedAgentId,
      assignedAgentName: args.agentName ?? subtask.assignedAgentName,
      completedAt:
        nextStatus === "completed" || nextStatus === "failed"
          ? Date.now()
          : undefined,
    });
    // Live output tail only exists while running (subtaskLive.ts).
    if (nextStatus !== "running") await clearSubtaskLive(ctx, args.taskId, args.key);
    // Shadow Agent: the Reviewer observes each newly completed subtask.
    // Scheduled, never awaited: it cannot block or change the run.
    if (nextStatus === "completed" && subtask.status !== "completed") {
      await scheduleShadowReview(ctx, args.taskId, args.key);
    }
    // Decision Outcome Calibration: provisional labels once a node ends.
    if ((nextStatus === "completed" || nextStatus === "failed") && nextStatus !== subtask.status) {
      await scheduleDecisionEvaluation(ctx, args.taskId);
    }
    return true;
  },
});

export const recordEvaluation = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    planVersion: v.number(),
    verdict: v.union(
      v.literal("passed"),
      v.literal("failed"),
      v.literal("inconclusive")
    ),
    checks: v.any(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("evaluations", { ...args, createdAt: Date.now() });
    await appendTaskEvent(ctx, {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "evaluation.completed",
      payload: { verdict: args.verdict, notes: args.notes ?? null },
      level: args.verdict === "failed" ? "error" : "info",
    });
  },
});

/**
 * Canonical event vocabulary (plan 016 P0). The UI subscribes to these and
 * never sees provider/worker-specific event names. The map mirrors the raw
 * `taskEvents` vocabulary the worker actually emits; `canonicalEvent()` in
 * `chatContext` is the single source of truth.
 */
const CANONICAL_MAP: Record<string, string> = {
  "task.stage": "task.updated",
  "task.classified": "task.updated",
  "task.claimed": "agent.started",
  "subtask.started": "agent.started",
  "subtask.routed": "agent.started",
  "subtask.blocked": "agent.waiting_approval",
  "agent.started": "agent.started",
  "orchestrator.decision": "agent.thinking",
  "orchestrator.plan": "agent.thinking",
  "orchestrator.delegation": "agent.thinking",
  "orchestrator.decision_fallback": "agent.thinking",
  "orchestrator.objective_unmet": "agent.thinking",
  "orchestrator.budget_blocked": "agent.failed",
  "orchestrator.step_limit": "agent.failed",
  "orchestrator.evaluation_failed": "agent.failed",
  "approval.requested": "agent.waiting_approval",
  "approval.approved": "agent.approved",
  "approval.auto_approved": "agent.approved",
  "approval.rejected": "agent.rejected",
  "approval.held": "agent.waiting_approval",
  "task.waiting_approval": "agent.waiting_approval",
  "qa.passed": "agent.completed",
  "qa.warning": "task.updated",
  "qa.failed": "agent.failed",
  "qa.fix_started": "agent.thinking",
  "review.approved": "agent.completed",
  "review.requested_changes": "agent.failed",
  "review.fix_started": "agent.thinking",
  "orchestrator.completed": "task.completed",
  "task.completed": "task.completed",
  "task.done": "task.completed",
  "task.failed": "task.failed",
  "task.error": "task.failed",
  "task.cancelled": "task.failed",
  "task.recovered": "task.failed",
  "task.no_change": "task.updated",
  "task.retried": "task.updated",
  "task.input_asked": "agent.waiting_approval",
  "task.input_answered": "message.created",
  "task.steered": "message.created",
  "task.policy_dry_run": "task.updated",
  "verification.fix_started": "tool.started",
  "task.check": "tool.completed",
  "budget.exhausted": "task.failed",
  "budget.warning": "task.updated",
  "budget.seed_failed": "agent.failed",
  "plan.created": "task.updated",
  "plan.degraded": "task.updated",
  "plan.planner_fallback": "task.updated",
  "plan.replanned": "task.updated",
  "plan.hint_dropped": "task.updated",
  "plan.routing_adjusted": "task.updated",
  "plan.dynamic_persist_failed": "agent.failed",
  "plan.dynamic_subtasks_persisted": "task.updated",
  "fileChanges.applied": "tool.completed",
  "fileChanges.apply_failed": "tool.failed",
  "fileChanges.updated": "tool.completed",
  "permission.denied": "agent.failed",
  "branch.created": "tool.completed",
  "branch.discarded": "tool.completed",
  "branch.merged": "tool.completed",
  "branch.merge_conflict": "tool.failed",
  "execution.started": "agent.started",
  "execution.completed": "agent.completed",
  "execution.failed": "agent.failed",
  "tool.started": "tool.started",
  "tool.completed": "tool.completed",
  "tool.failed": "tool.failed",
};

export function canonicalEvent(type: string): string | null {
  return CANONICAL_MAP[type] ?? null;
}

/** Append one canonical event with a monotonic sequence. */
export const appendAgentEvent = internalMutation({
  args: {
    projectId: v.id("projects"),
    conversationId: v.optional(v.id("conversations")),
    taskId: v.optional(v.id("tasks")),
    executionId: v.optional(v.id("executions")),
    agentId: v.optional(v.id("agents")),
    type: v.string(),
    payload: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await appendAgentEventRow(ctx, args);
  },
});

export const listAgentEvents = query({
  args: {
    conversationId: v.optional(v.id("conversations")),
    taskId: v.optional(v.id("tasks")),
    projectId: v.optional(v.id("projects")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Authorization (core H5): resolve the owning project of whichever
    // scope was asked for and apply the same conditional ownership rule.
    if (args.conversationId) {
      const conversation = await ctx.db.get(args.conversationId);
      if (!conversation) return [];
      await assertConversationAccess(ctx, conversation);
    } else if (args.taskId) {
      const task = await getVisibleTask(ctx, args.taskId);
      if (!task) return [];
    } else if (args.projectId) {
      await assertProjectAccess(ctx, args.projectId);
    }
    // Newest window, returned oldest-first (t3code idea #3). Reading the
    // oldest N used to freeze the panel once a task passed N events.
    const limit = Math.min(Math.max(args.limit ?? 200, 1), 1000);
    if (args.conversationId) {
      const rows = await ctx.db
        .query("agentEvents")
        .withIndex("by_conversation_and_sequence", (q) =>
          q.eq("conversationId", args.conversationId!)
        )
        .order("desc")
        .take(limit);
      return rows.reverse();
    }
    if (args.taskId) {
      const rows = await ctx.db
        .query("agentEvents")
        .withIndex("by_task_and_sequence", (q) => q.eq("taskId", args.taskId!))
        .order("desc")
        .take(limit);
      return rows.reverse();
    }
    if (args.projectId) {
      const rows = await ctx.db
        .query("agentEvents")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId!))
        .order("desc")
        .take(limit);
      return rows.reverse();
    }
    return [];
  },
});

/**
 * Reconnect for the task thread: canonical task events after `afterSequence`,
 * or the newest window when the gap is too large to replay (decideResume,
 * adapted from t3code's decideThreadResume; see lib/eventResume.ts).
 */
export const agentEventsSince = query({
  args: { taskId: v.id("tasks"), afterSequence: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const task = await getVisibleTask(ctx, args.taskId);
    if (!task) return { mode: "snapshot" as const, events: [], highWater: 0 };
    const newest = await ctx.db
      .query("agentEvents")
      .withIndex("by_task_and_sequence", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .first();
    const high = newest?.sequence ?? 0;
    const replay = await ctx.db
      .query("agentEvents")
      .withIndex("by_task_and_sequence", (q) => q.eq("taskId", args.taskId).gt("sequence", args.afterSequence))
      .order("asc")
      .take(RESUME_MAX_REPLAY_EVENTS + 1);
    const plan = decideResume({
      afterSequence: args.afterSequence,
      highWater: high,
      replayEventCount: replay.length,
      replayEncodedBytes: replayEncodedBytes(replay),
    });
    if (plan.mode === "replay") return { mode: "replay" as const, events: replay, highWater: high };
    const rows = await ctx.db
      .query("agentEvents")
      .withIndex("by_task_and_sequence", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 200, 1), 1000));
    return { mode: "snapshot" as const, events: rows.reverse(), highWater: high };
  },
});

export const logEvent = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    type: v.string(),
    payload: v.optional(v.any()),
    executionId: v.optional(v.id("executions")),
    subtaskKey: v.optional(v.string()),
    level: v.optional(v.union(v.literal("info"), v.literal("warn"), v.literal("error"))),
    agentId: v.optional(v.id("agents")),
    message: v.optional(v.string()),
    metadata: v.optional(v.any()),
    /** Optional idempotency key: a re-emit with the same key is a no-op. */
    eventKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    if (args.eventKey) {
      const seen = await ctx.db
        .query("taskEvents")
        .withIndex("by_task_and_event_key", (q) => q.eq("taskId", args.taskId).eq("eventKey", args.eventKey))
        .first();
      // Already recorded: skip the event and its derived rows (decision,
      // observations, canonical event) so a replay cannot double-count.
      if (seen) return;
    }
    const eventId = await appendTaskEvent(ctx, {
      ...args,
      createdAt: now,
    });
    // Decision Outcome Calibration: the decision this event records, if any.
    await recordDecisionForEvent(ctx, { _id: eventId, ...args, createdAt: now });
    // Plan 025: the typed execution observations this event carries.
    await recordObservationsForEvent(ctx, args.taskId, args.projectId, {
      type: args.type,
      payload: args.payload,
      subtaskKey: args.subtaskKey,
      executionId: args.executionId,
      agentId: args.agentId,
      createdAt: now,
    });
    // Emit the canonical event the UI subscribes to.
    const type = canonicalEvent(args.type);
    if (type) {
      await appendAgentEventRow(ctx, {
        projectId: args.projectId,
        taskId: args.taskId,
        executionId: args.executionId,
        agentId: args.agentId,
        type,
        payload: args.payload,
        createdAt: now,
      });
    }
  },
});

/** Emit a canonical event directly (used by steer/answer paths). */
export const emitCanonical = internalMutation({
  args: {
    projectId: v.id("projects"),
    taskId: v.id("tasks"),
    executionId: v.optional(v.id("executions")),
    agentId: v.optional(v.id("agents")),
    type: v.string(),
    payload: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await appendAgentEventRow(ctx, args);
  },
});

export const appendAgentMessage = internalMutation({
  args: {
    projectId: v.id("projects"),
    taskId: v.id("tasks"),
    agentId: v.optional(v.id("agents")),
    content: v.string(),
    subtaskKey: v.optional(v.string()),
    executionId: v.optional(v.id("executions")),
  },
  handler: async (ctx, args) => {
    if (!args.content.trim()) return null;
    return await ctx.db.insert("messages", {
      projectId: args.projectId,
      taskId: args.taskId,
      agentId: args.agentId,
      authorType: "agent",
      content: args.content,
      subtaskKey: args.subtaskKey,
      executionId: args.executionId,
    });
  },
});

export async function refreshAgentStatus(
  ctx: Pick<MutationCtx, "db">,
  agentId: Id<"agents"> | undefined
): Promise<void> {
  if (!agentId) return;
  const agent = await ctx.db.get(agentId);
  if (!agent || agent.status === "needs_you") return;
  // Point lookups on (agentId, status) instead of collecting every
  // execution the agent ever ran (core H6: the fixed team accumulates
  // executions forever and this runs on every execution update).
  let busy = false;
  for (const status of ["running", "queued", "waiting_approval"] as const) {
    const active = await ctx.db
      .query("executions")
      .withIndex("by_agent_and_status", (q) =>
        q.eq("agentId", agentId).eq("status", status)
      )
      .first();
    if (active) {
      busy = true;
      break;
    }
  }
  const nextStatus = busy ? "working" : "idle";
  if (agent.status !== nextStatus) {
    await ctx.db.patch(agentId, { status: nextStatus });
  }
}

export const recordTokenUsage = internalMutation({
  args: {
    projectId: v.id("projects"),
    taskId: v.optional(v.id("tasks")),
    agentId: v.optional(v.id("agents")),
    agentName: v.string(),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    // Phase 5: which connection + registry model actually served the
    // call, and the estimated cost from that model's pricing. Absent
    // when the serving handle had no registry identity / no pricing —
    // never guessed (see worker effects/llmCall usageMetaFor).
    providerId: v.optional(v.id("llmProviders")),
    modelId: v.optional(v.id("llmModels")),
    estimatedCost: v.optional(v.number()),
    // Runs trace: which execution attempt / subtask made the call.
    executionId: v.optional(v.id("executions")),
    subtaskKey: v.optional(v.string()),
    /** Counts are a chars/4 estimate (provider omitted usage). */
    estimated: v.optional(v.boolean()),
    // Plan 040 P3 ledger fields (all optional).
    ...usageLedgerFields,
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("tokenUsage", {
      ...ledgerFieldsOf(args),
      projectId: args.projectId,
      taskId: args.taskId,
      agentId: args.agentId,
      agentName: args.agentName,
      model: args.model,
      providerId: args.providerId,
      modelId: args.modelId,
      estimatedCost: args.estimatedCost,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      executionId: args.executionId,
      subtaskKey: args.subtaskKey,
      ...(args.estimated ? { estimated: true } : {}),
      createdAt: Date.now(),
    });
  },
});

/** The plan 040 P3 ledger fields present on `args` (undefined keys dropped). */
function ledgerFieldsOf(args: {
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  durationMs?: number;
  providerKind?: string;
  callRole?: string;
  source?: string;
}) {
  const out: Record<string, number | string> = {};
  for (const key of Object.keys(usageLedgerFields) as (keyof typeof usageLedgerFields)[]) {
    const value = args[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<Pick<Doc<"tokenUsage">, keyof typeof usageLedgerFields>>;
}

/**
 * Usage of one backend chat LLM call (plan 040 P3): the chat client
 * recorded none before. The agent's name is looked up here so chat call
 * sites only pass what they hold; a missing agent records nothing.
 */
export const recordChatTokenUsage = internalMutation({
  args: {
    projectId: v.id("projects"),
    agentId: v.id("agents"),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    providerId: v.optional(v.id("llmProviders")),
    modelId: v.optional(v.id("llmModels")),
    estimatedCost: v.optional(v.number()),
    estimated: v.optional(v.boolean()),
    ...usageLedgerFields,
  },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent) return;
    await ctx.db.insert("tokenUsage", {
      projectId: args.projectId,
      agentId: args.agentId,
      agentName: agent.name,
      model: args.model,
      providerId: args.providerId,
      modelId: args.modelId,
      estimatedCost: args.estimatedCost,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      ...(args.estimated ? { estimated: true } : {}),
      ...ledgerFieldsOf(args),
      source: "chat",
      createdAt: Date.now(),
    });
  },
});

/** Most recent token-usage rows aggregated by tokenUsageStats (core M7). */
const TOKEN_USAGE_STATS_LIMIT = 5000;
const DELEGATION_STATS_LIMIT = 2000;

export const tokenUsageStats = query({
  args: {},
  handler: async (ctx) => {
    // Bounded (core M7: one row per LLM call grows forever) and scoped to
    // the projects the caller may see (core H5). Aggregates cover the most
    // recent TOKEN_USAGE_STATS_LIMIT calls; `truncated` says when older
    // calls were left out.
    const visible = await visibleProjectIds(ctx);
    const recent = await ctx.db
      .query("tokenUsage")
      .withIndex("by_created_at")
      .order("desc")
      .take(TOKEN_USAGE_STATS_LIMIT);
    const truncated = recent.length >= TOKEN_USAGE_STATS_LIMIT;
    const records = recent
      .filter((record) => visible.has(record.projectId as string))
      .reverse();
    const byAgent: Record<string, { inputTokens: number; outputTokens: number; calls: number }> = {};
    // Phase 5: usage per serving provider connection / registry model.
    // Attribution columns exist only on calls recorded after Phase 5;
    // older rows aggregate under the "(unattributed)" bucket instead of
    // being guessed into a provider.
    const byProvider: Record<
      string,
      { inputTokens: number; outputTokens: number; calls: number; estimatedCost: number }
    > = {};
    const byModel: Record<
      string,
      { inputTokens: number; outputTokens: number; calls: number; estimatedCost: number }
    > = {};
    let totalInput = 0;
    let totalOutput = 0;
    let totalEstimatedCost = 0;
    // Bucket by hour: { hourStartUnixSec: tokens }
    const byHour: Record<number, number> = {};
    // Resolve display names for the attribution ids in one pass.
    const providerNames = new Map<string, string>();
    for (const provider of await ctx.db.query("llmProviders").collect()) {
      providerNames.set(provider._id, provider.name);
    }
    const modelNames = new Map<string, string>();
    for (const model of await ctx.db.query("llmModels").collect()) {
      modelNames.set(model._id, model.modelId);
    }
    for (const r of records) {
      if (!byAgent[r.agentName]) {
        byAgent[r.agentName] = { inputTokens: 0, outputTokens: 0, calls: 0 };
      }
      byAgent[r.agentName].inputTokens += r.inputTokens;
      byAgent[r.agentName].outputTokens += r.outputTokens;
      byAgent[r.agentName].calls += 1;
      totalInput += r.inputTokens;
      totalOutput += r.outputTokens;
      const providerKey = r.providerId
        ? (providerNames.get(r.providerId) ?? r.providerId)
        : "(unattributed)";
      if (!byProvider[providerKey]) {
        byProvider[providerKey] = {
          inputTokens: 0,
          outputTokens: 0,
          calls: 0,
          estimatedCost: 0,
        };
      }
      byProvider[providerKey].inputTokens += r.inputTokens;
      byProvider[providerKey].outputTokens += r.outputTokens;
      byProvider[providerKey].calls += 1;
      const modelKey = r.modelId
        ? (modelNames.get(r.modelId) ?? r.model)
        : "(unattributed)";
      if (!byModel[modelKey]) {
        byModel[modelKey] = {
          inputTokens: 0,
          outputTokens: 0,
          calls: 0,
          estimatedCost: 0,
        };
      }
      byModel[modelKey].inputTokens += r.inputTokens;
      byModel[modelKey].outputTokens += r.outputTokens;
      byModel[modelKey].calls += 1;
      if (r.estimatedCost !== undefined) {
        byProvider[providerKey].estimatedCost += r.estimatedCost;
        byModel[modelKey].estimatedCost += r.estimatedCost;
        totalEstimatedCost += r.estimatedCost;
      }
      const hourStart = Math.floor(r.createdAt / 1000 / 3600) * 3600; // unix seconds, start of hour UTC
      byHour[hourStart] = (byHour[hourStart] ?? 0) + r.inputTokens + r.outputTokens;
    }
    // Cumulative timeline for the chart
    const sortedHours = Object.keys(byHour)
      .map(Number)
      .sort((a, b) => a - b);
    const nowSec = Math.floor(Date.now() / 1000);
    // Liveline needs >=2 points to draw; seed with a zero baseline 24h back
    const seedStart = nowSec - 24 * 3600;
    let cumulative = 0;
    const timeline: { time: number; value: number }[] = [{ time: seedStart, value: 0 }];
    for (const hour of sortedHours) {
      cumulative += byHour[hour];
      timeline.push({ time: hour, value: cumulative });
    }
    if (timeline[timeline.length - 1].time < nowSec) {
      timeline.push({ time: nowSec, value: totalInput + totalOutput });
    }
    // Delegation metrics from the delegations table — real subtask-
    // producing decisions since Phase 3 (count per decision outcome).
    const delegationRows = (
      await ctx.db.query("delegations").order("desc").take(DELEGATION_STATS_LIMIT)
    ).filter((row) => visible.has(row.projectId as string));
    const byDecision: Record<string, number> = {};
    for (const row of delegationRows) {
      byDecision[row.decision] = (byDecision[row.decision] ?? 0) + 1;
    }
    const delegations = {
      total: delegationRows.length,
      byDecision,
      approvedRate:
        delegationRows.length > 0
          ? (byDecision.APPROVE ?? 0) / delegationRows.length
          : 0,
    };
    return {
      byAgent,
      byProvider,
      byModel,
      totalInput,
      totalOutput,
      totalCalls: records.length,
      totalEstimatedCost,
      delegations,
      timeline,
      truncated,
    };
  },
});

/**
 * Provider health snapshots for the Settings UI (Phase 5 observability):
 * the worker-mirrored circuit state per connection, keyed by provider
 * name. Public read — the values are operational counters only (no
 * credentials, no request data). Rows exist only after a provisioned
 * worker reported; the UI renders the absence honestly.
 */
export const providerHealthStats = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("providerHealth").collect();
    const snapshots: Record<
      string,
      {
        providerId: string;
        consecutiveTransientFailures: number;
        totalSuccesses: number;
        totalTransientFailures: number;
        circuitOpenUntil: number | null;
        lastSuccessAt?: number;
        lastFailureAt?: number;
        reportedAt: number;
      }
    > = {};
    for (const row of rows) {
      const name =
        (await ctx.db.get(row.providerId))?.name ?? row.providerName;
      snapshots[name] = {
        providerId: row.providerId,
        consecutiveTransientFailures: row.consecutiveTransientFailures,
        totalSuccesses: row.totalSuccesses,
        totalTransientFailures: row.totalTransientFailures,
        circuitOpenUntil: row.circuitOpenUntil ?? null,
        lastSuccessAt: row.lastSuccessAt,
        lastFailureAt: row.lastFailureAt,
        reportedAt: row.reportedAt,
      };
    }
    return { snapshots, updatedAt: Date.now() };
  },
});

/**
 * Mirror one provider-health snapshot from a worker (Phase 5). INTERNAL
 * and deliberately not exposed through the token-gated worker action
 * surface: the worker's service token must not reach a client, and a
 * client-callable mirror would let anyone forge circuit state. The
 * worker reaches this only through its deployment-provisioned internal
 * channel — same provisioning model as the encryption key (operator
 * sets it up once); unprovisioned deployments simply never write here.
 */
export const reportProviderHealth = internalMutation({
  args: {
    providerId: v.id("llmProviders"),
    providerName: v.string(),
    consecutiveTransientFailures: v.number(),
    totalSuccesses: v.number(),
    totalTransientFailures: v.number(),
    circuitOpenUntil: v.optional(v.number()),
    lastSuccessAt: v.optional(v.number()),
    lastFailureAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("providerHealth")
      .withIndex("by_provider", (q) => q.eq("providerId", args.providerId))
      .first();
    const doc = { ...args, reportedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return existing._id;
    }
    return await ctx.db.insert("providerHealth", doc);
  },
});

export const getBranchContext = internalQuery({
  args: { taskId: v.id("tasks"), projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    const project = await ctx.db.get(args.projectId);
    if (!task || !project) throw new Error("Task or project not found");
    return {
      taskTitle: task.title,
      workspacePath: project.workspacePath,
      worktreesPath: project.worktreesPath,
      mainBranch: project.mainBranch,
      projectName: project.name,
      existingBranchName: task.branchName,
      existingWorktreePath: task.worktreePath,
    };
  },
});

export const completeBranchCreation = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    branchName: v.string(),
    worktreePath: v.string(),
  },
  handler: async (ctx, args) => {
    await patchTask(ctx, args.taskId, {
      branchName: args.branchName,
      worktreePath: args.worktreePath,
      updatedAt: Date.now(),
    });
    await appendTaskEvent(ctx, {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "branch.created",
      payload: { branchName: args.branchName, worktreePath: args.worktreePath },
      level: "info",
    });
  },
});

export const getDiffContext = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");
    if (!task.worktreePath) throw new Error("No worktreePath for task");
    const project = await ctx.db.get(task.projectId);
    return {
      worktreePath: task.worktreePath,
      branchName: task.branchName ?? "",
      // Undefined = auto-detect in worktreeNode (resolveMainBranch).
      mainBranch: project?.mainBranch,
    };
  },
});

export const getMergeContext = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");
    if (!task.branchName || !task.worktreePath) {
      throw new Error("No branch/worktree for this task");
    }
    const project = await ctx.db.get(task.projectId);
    return {
      branchName: task.branchName,
      worktreePath: task.worktreePath,
      workspacePath: project?.workspacePath ?? "",
      // Undefined = auto-detect in worktreeNode (resolveMainBranch).
      mainBranch: project?.mainBranch,
      projectId: task.projectId,
      // Post-push feedback loop: the branch and worktree outlive the local
      // merge so a fix task can land on the same PR. Released when the PR
      // closes (prFeedback.onPrClosed).
      keepWorktree: Boolean(project?.prFeedbackReactions) || Boolean(task.parentTaskId && (task.prFix || task.reviewFix)),
    };
  },
});

export const mergeBranchCompleted = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    branchName: v.string(),
    conflict: v.optional(v.string()),
    kept: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (args.conflict) {
      await appendTaskEvent(ctx, {
        taskId: args.taskId,
        projectId: args.projectId,
        type: "branch.merge_conflict",
        payload: { branchName: args.branchName, error: args.conflict },
        level: "error",
      });
      throw new Error(`Merge failed: ${args.conflict}`);
    }
    if (!args.kept) {
      await patchTask(ctx, args.taskId, {
        branchName: undefined,
        worktreePath: undefined,
      });
    }
    await appendTaskEvent(ctx, {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "branch.merged",
      payload: { branchName: args.branchName, ...(args.kept ? { worktreeKept: true } : {}) },
      level: "info",
    });
    return { success: true };
  },
});

export const getDiscardContext = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;
    const project = await ctx.db.get(task.projectId);
    return {
      workspacePath: project?.workspacePath ?? "",
      worktreePath: task.worktreePath,
      branchName: task.branchName,
      projectId: task.projectId,
    };
  },
});

export const discardBranchDone = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    branchName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await patchTask(ctx, args.taskId, {
      branchName: undefined,
      worktreePath: undefined,
    });
    await appendTaskEvent(ctx, {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "branch.discarded",
      payload: { branchName: args.branchName },
      level: "warn",
    });
  },
});

export const cleanupWorktreeContext = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;
    const project = await ctx.db.get(task.projectId);
    if (!project) return null;
    return {
      workspacePath: project.workspacePath,
      worktreesPath: project.worktreesPath,
      // Current fhara/<id>/ plus legacy moagent/<id>/ (pre-rename branches).
      branchPrefixes: taskBranchPrefixes(args.taskId),
    };
  },
});

/** Bounded batch of finished tasks whose worktree may be removed now. */
const WORKTREE_SWEEP_BATCH = 20;

export const listStaleWorktreeTasks = internalQuery({
  args: { now: v.number(), retentionMs: v.number() },
  handler: async (ctx, args) => {
    const cutoff = args.now - args.retentionMs;
    const out: Array<{ taskId: Id<"tasks"> }> = [];
    for (const status of FINISHED_TASK_STATUSES) {
      const rows = await ctx.db
        .query("tasks")
        .withIndex("by_status_and_updated", (q) => q.eq("status", status).lt("updatedAt", cutoff))
        .order("asc")
        .take(200);
      for (const task of rows) {
        if (out.length >= WORKTREE_SWEEP_BATCH) break;
        if (!task.worktreePath) continue;
        const pushes = await ctx.db
          .query("taskPushes")
          .withIndex("by_task", (q) => q.eq("taskId", task._id))
          .take(50);
        // Post-push feedback loop: an owner and its PR fixes share one
        // worktree, so the PR's rows (the owner's and its fixes') decide.
        const ownerId = task.parentTaskId && (task.prFix || task.reviewFix) ? task.parentTaskId : task._id;
        pushes.push(
          ...(await ctx.db.query("taskPushes").withIndex("by_owner_task", (q) => q.eq("ownerTaskId", ownerId)).take(50)),
          ...(ownerId !== task._id
            ? await ctx.db.query("taskPushes").withIndex("by_task", (q) => q.eq("taskId", ownerId)).take(50)
            : [])
        );
        const blocker = worktreeCleanupBlocker(
          {
            status: task.status,
            worktreePath: task.worktreePath,
            finishedAt: task.completedAt ?? task.updatedAt,
            pushes: pushes.map((push) => ({ status: push.status, prState: push.prState })),
          },
          args.now,
          args.retentionMs
        );
        if (blocker === null) out.push({ taskId: task._id });
      }
      if (out.length >= WORKTREE_SWEEP_BATCH) break;
    }
    return out;
  },
});

/** The sweep removed this task's worktree; the branch is kept. */
export const worktreeCleaned = internalMutation({
  args: { taskId: v.id("tasks"), removed: v.array(v.string()) },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return;
    await patchTask(ctx, args.taskId, { worktreePath: undefined });
    await appendTaskEvent(ctx, {
      taskId: args.taskId,
      projectId: task.projectId,
      type: "branch.worktree_cleaned",
      payload: { branchName: task.branchName, removed: args.removed },
      level: "info",
    });
  },
});

// Intelligent orchestrator — shared task context

export const getTaskContext = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const contexts = await ctx.db
      .query("taskContexts")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(1);
    return contexts[0] ?? null;
  },
});

export const listPendingTaskInputs = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("taskInputs")
      .withIndex("by_task_and_delivered", (q) => q.eq("taskId", args.taskId).eq("delivered", false))
      .take(50);
    return rows
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((row) => ({ _id: row._id as string, kind: row.kind, text: row.text, createdAt: row.createdAt }));
  },
});

/** Idempotent: an already-delivered row keeps its first deliveredAt. */
export const markTaskInputsDelivered = internalMutation({
  args: { inputIds: v.array(v.id("taskInputs")) },
  handler: async (ctx, args) => {
    const now = Date.now();
    let marked = 0;
    for (const id of args.inputIds) {
      const row = await ctx.db.get(id);
      if (!row || row.delivered) continue;
      await ctx.db.patch(id, { delivered: true, deliveredAt: now });
      marked += 1;
    }
    return { marked };
  },
});

export const upsertTaskContext = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    originalRequest: v.string(),
    objective: v.string(),
    status: taskStatus,
    decisions: v.array(v.any()),
    artifacts: v.array(v.any()),
    outstandingIssues: v.array(v.any()),
    // Phase 5 (additive): persisted budget snapshot. Callers that do
    // not supply one leave the stored snapshot untouched (see handler).
    budgetSnapshot: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("taskContexts")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .first();
    const now = Date.now();
    // An omitted budgetSnapshot means "no new snapshot this write" —
    // keep the stored one instead of patching it away.
    const { budgetSnapshot, ...rest } = args;
    const patch =
      budgetSnapshot === undefined
        ? { ...rest, updatedAt: now }
        : { ...rest, budgetSnapshot, updatedAt: now };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("taskContexts", patch);
  },
});

export const recordDelegation = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    fromAgentId: v.optional(v.id("agents")),
    toAgentId: v.optional(v.id("agents")),
    decision: v.union(
      v.literal("APPROVE"),
      v.literal("REJECT"),
      v.literal("REVISE"),
      v.literal("COMPLETE"),
      v.literal("BLOCKED")
    ),
    reason: v.optional(v.string()),
    capability: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("delegations", { ...args, createdAt: Date.now() });
    const eventId = await appendTaskEvent(ctx, {
      taskId: args.taskId,
      projectId: args.projectId,
      type: "orchestrator.delegation",
      payload: { decision: args.decision, reason: args.reason ?? null, capability: args.capability ?? null },
      level: args.decision === "BLOCKED" ? "warn" : "info",
    });
    await recordDecisionForEventId(ctx, eventId);
    return id;
  },
});

export const recordLifecycle = internalMutation({
  args: {
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    state: v.string(),
    prevState: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("lifecycleHistory", { ...args, createdAt: Date.now() });
  },
});

export const getTaskTokenUsage = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const usage = await ctx.db
      .query("tokenUsage")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    return {
      calls: usage.length,
      inputTokens: usage.reduce((s, u) => s + u.inputTokens, 0),
      outputTokens: usage.reduce((s, u) => s + u.outputTokens, 0),
    };
  },
});