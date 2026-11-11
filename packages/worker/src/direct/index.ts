/**
 * Direct threads in the worker (threadbear T2): claims `tasks` with
 * `mode: "direct"`, runs one ThreadRunner per live thread, and holds each
 * thread's lease through the worker heartbeat (its id is reported in
 * `activeTaskIds`) for as long as the session is live, a turn is running,
 * or a card is waiting. Never shares orchestration.requestApproval, which
 * drops the lease.
 *
 * Per live thread, every DIRECT_POLL_MS: Stop requests, new messages
 * (steered or started as a turn) and whether the thread was closed. After
 * DIRECT_IDLE_MIN without a turn the session is released (the thread waits
 * for the user; the next message re-queues it and the session resumes).
 *
 * Admission (Nuphos N4, idea #9): at DIRECT_MAX_LIVE a claim is still
 * made when some live session is idle; the oldest idle one is then
 * released (it resumes on its next message) to make room. A session with a
 * turn in flight, or one parked on an approval card (a card only exists
 * inside a turn), is never chosen; with none idle, no claim is made.
 *
 * Agent processes (Nuphos N2): every ACP agent's process group is recorded
 * (agentPids.ts). Before the first claim, groups left by a worker that died
 * are verified and reaped; shutdown stops whatever this worker still has.
 */
import { wenv, wenvRaw } from "@fhara/config/worker";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import type { WorkerApi } from "@/workerApi";
import type { ExecutionPolicy } from "@/orchestrator/policy";
import { BudgetTracker } from "@/orchestrator/budget";
import { buildOpencodeConfig, OPENCODE_KEY_ENV } from "@/execution/nativeProvider";
import { opencodeAllowUnisolated } from "@/execution/opencodeDetect";
import { createGlobalLLMProvider } from "@/llm";
import { runWithLlmGates } from "@/effects/llmCall";
import { buildTaskLlmResolver, resolveWorkspacePath, seedBudgetFromPersisted, toAgentDefinition } from "@/services/runner/setup";
import { createBudgetGate } from "@/services/runner/session";
import type { RunnerDeps } from "@/services/runner/types";
import { findOpencodeBinary, OPENCODE_ACP_ARGS, opencodeEnv } from "@/vendor/threadbear/acp/agents";
import type { AcpLogger } from "@/vendor/threadbear/acp/connection";
import { COMPLETION_CONTRACT } from "@/prompts/completionContract";
import { AcpEngine } from "./acpSession";
import { ApiLoopEngine } from "./apiLoopSession";
import { AgentPidRegistry } from "./agentPids";
import { ThreadRunner, type DirectStore } from "./threadRunner";
import type { DirectEngine } from "./types";

/** Read at module load; the entrypoint loads the root .env before this module is evaluated. */
export const DIRECT_POLL_MS = wenv("DIRECT_POLL_MS"); // ≥ 250

export function directIdleMs(env?: Record<string, string | undefined>): number {
  return wenv("DIRECT_IDLE_MIN", env) * 60_000; // minutes, ≥ 1
}

export function directMaxLive(env?: Record<string, string | undefined>): number {
  return wenv("DIRECT_MAX_LIVE", env); // 1–8
}

/** Longest an approval card waits before it expires and the agent is told no (Nuphos N5), in ms. */
export function directApprovalMaxMs(env?: Record<string, string | undefined>): number {
  return wenv("DIRECT_APPROVAL_MAX_MIN", env) * 60_000; // minutes, 1–1440
}

/** How far the watchdog's approval exemption stays above the card's own bound. */
export const WATCHDOG_APPROVAL_MARGIN_MS = 60_000;

/**
 * The ACP turn watchdog's windows (Nuphos N3), in ms; 0 turns one off.
 *
 * Which fires first on a turn parked on a card (Nuphos N5): the card's own
 * bound, DIRECT_APPROVAL_MAX_MIN (default 30). The card expires, the agent
 * is told no and the turn goes on with fresh windows. The watchdog's
 * exemption, DIRECT_WATCHDOG_APPROVAL_MIN (default 60), is the backstop for
 * a wait that outlives that bound (a store that stopped answering); it is
 * raised to the approval max plus a minute when set lower, so a turn is
 * never timed out while its card still has time left. 0 keeps "no cap".
 */
export function directWatchdog(env?: Record<string, string | undefined>): { inactivityMs: number; progressMs: number; approvalCapMs: number } {
  const cap = wenv("DIRECT_WATCHDOG_APPROVAL_MIN", env) * 60_000;
  return {
    inactivityMs: wenv("DIRECT_INACTIVITY_MIN", env) * 60_000,
    progressMs: wenv("DIRECT_PROGRESS_MIN", env) * 60_000,
    approvalCapMs: cap > 0 ? Math.max(cap, directApprovalMaxMs(env) + WATCHDOG_APPROVAL_MARGIN_MS) : 0,
  };
}

/** Which engine a thread gets: ACP when OpenCode is installed and may run there. */
export function chooseDirectEngine(input: {
  binary: string | undefined;
  worktreeIsolation: boolean | undefined;
  env?: Record<string, string | undefined>;
}): { engine: "opencode-acp" | "api-loop"; reason: string } {
  const env = input.env;
  if (wenv("DIRECT_ENGINE", env) === "api-loop") return { engine: "api-loop", reason: "DIRECT_ENGINE=api-loop" };
  if (!input.binary) return { engine: "api-loop", reason: "OpenCode is not installed on this worker" };
  if (!input.worktreeIsolation && !opencodeAllowUnisolated(env)) {
    return {
      engine: "api-loop",
      reason: "worktree isolation is off (ORCHESTRATOR_WORKTREE_ISOLATION), so OpenCode would edit the real checkout",
    };
  }
  return { engine: "opencode-acp", reason: "OpenCode ACP" };
}

/** What a new session is told once: the role and where it works. */
export function directPreamble(input: { role: string; agentName?: string; systemPrompt?: string | null; cwd: string; isolated: boolean }): string {
  return [
    input.systemPrompt?.trim() || `You are the team's ${input.role}${input.agentName ? ` (${input.agentName})` : ""}.`,
    `You are working directly with the user in one conversation (a Fhara direct thread), in ${input.cwd}.`,
    input.isolated
      ? "This folder is a git worktree on its own branch for this thread: commit your work there. Never push; the user pushes from Fhara."
      : "Never push; the user pushes from Fhara.",
    "Every edit and command asks the user first unless their permission mode allows it.",
    COMPLETION_CONTRACT,
  ].join("\n");
}

/** What admission needs to know about one live session. */
export type AdmissionCandidate = { taskId: string; lastActivity: number; busy: boolean; closing: boolean };

/**
 * The session to release so a new claim fits: the oldest idle one. Never a
 * session with a turn in flight or waiting on an approval (both `busy`),
 * never one already closing. Undefined when none qualifies.
 */
export function pickEvictable(live: Iterable<AdmissionCandidate>): AdmissionCandidate | undefined {
  let best: AdmissionCandidate | undefined;
  for (const c of live) {
    if (c.busy || c.closing) continue;
    if (!best || c.lastActivity < best.lastActivity) best = c;
  }
  return best;
}

type Claimed = NonNullable<Awaited<ReturnType<WorkerApi["claimDirectThread"]>>>;

type Live = {
  taskId: string;
  runner: ThreadRunner;
  lastActivity: number;
  handledInterrupt: number;
  deliveredSeq: number;
  timer?: NodeJS.Timeout;
  closing: boolean;
};

export interface DirectThreadsDeps {
  api: WorkerApi;
  workerId: string;
  workspaceRoot: string;
  policy: ExecutionPolicy;
  leaseMs: number;
  log: (...args: unknown[]) => void;
  shutdownSignal: AbortSignal;
  /** Default: `~/.fhara/run/acp-pgids`, this process. */
  agentPids?: AgentPidRegistry;
}

function acpLogger(log: (...args: unknown[]) => void): AcpLogger {
  return {
    debug: () => undefined,
    info: (m, d) => log("[direct]", m, d ?? ""),
    warn: (m, d) => log("[direct] warn:", m, d ?? ""),
    error: (m, d) => log("[direct] error:", m, d ?? ""),
  };
}

export class DirectThreads {
  private live = new Map<string, Live>();
  private claiming = false;
  private swept?: Promise<void>;
  readonly agentPids: AgentPidRegistry;

  constructor(private readonly deps: DirectThreadsDeps) {
    this.agentPids =
      deps.agentPids ?? new AgentPidRegistry({ log: (m, d) => deps.log("[direct]", m, d ?? "") });
    this.agentPids.installExitHook();
  }

  /** Reaps agent groups a dead worker left (once; every claim waits for it). */
  sweepLeftovers(): Promise<void> {
    this.swept ??= this.agentPids
      .sweep()
      .then((results) => {
        const reaped = results.filter((r) => r.outcome === "reaped").length;
        if (reaped) this.deps.log(`[direct] reaped ${reaped} leftover agent process group(s) from a previous worker`);
      })
      .catch((error) => this.deps.log("[direct] agent sweep failed", error));
    return this.swept;
  }

  /** Ids whose leases the heartbeat must renew. */
  activeTaskIds(): string[] {
    return [...this.live.keys()];
  }

  get size(): number {
    return this.live.size;
  }

  private candidates(): AdmissionCandidate[] {
    return [...this.live.values()].map((l) => ({ taskId: l.taskId, lastActivity: l.lastActivity, busy: l.runner.busy, closing: l.closing }));
  }

  /** At the cap: release the oldest idle session(s) until one more fits. */
  private async makeRoom(max: number): Promise<void> {
    while (this.live.size >= max) {
      const victim = pickEvictable(this.candidates());
      const live = victim && this.live.get(victim.taskId);
      if (!live) {
        // It became busy while the claim was in flight: run one over the cap
        // rather than fail the claim; the next idle release evens it out.
        this.deps.log(`[direct] at the live cap (${max}) with no idle session; starting one over it`);
        return;
      }
      this.deps.log(`[direct] at the live cap (${max}): releasing idle thread ${live.taskId} to admit a new one`);
      await this.stop(live, "released for another thread (live cap)", true);
    }
  }

  /** One claim attempt; returns true when a thread was started. */
  async tick(): Promise<boolean> {
    if (this.claiming || this.deps.shutdownSignal.aborted) return false;
    const max = directMaxLive();
    // At the cap a claim is only worth making when an idle session can go.
    if (this.live.size >= max && !pickEvictable(this.candidates())) return false;
    this.claiming = true;
    try {
      await this.sweepLeftovers();
      const claimed = await this.deps.api.claimDirectThread({ workerId: this.deps.workerId, leaseMs: this.deps.leaseMs });
      if (!claimed) return false;
      await this.makeRoom(max);
      await this.start(claimed).catch(async (error) => {
        this.deps.log("direct thread failed to start", claimed.taskId, error);
        this.live.delete(String(claimed.taskId));
        await this.deps.api
          .releaseDirectThread({ taskId: claimed.taskId, workerId: this.deps.workerId, reason: "start failed", error: error instanceof Error ? error.message : String(error) })
          .catch(() => undefined);
      });
      return true;
    } finally {
      this.claiming = false;
    }
  }

  /** Lease lost (heartbeat): stop the thread without writing. */
  lost(taskId: string): void {
    const live = this.live.get(taskId);
    if (!live) return;
    this.deps.log("direct thread lease lost", taskId);
    void this.stop(live, "lease lost", false);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.live.values()].map((live) => this.stop(live, "worker shutting down", true)));
    // Anything close() didn't end (a leftover MCP child, a session still booting).
    await this.agentPids.reapOwn().catch((error) => this.deps.log("[direct] agent reap failed", error));
  }

  private async start(claimed: Claimed): Promise<void> {
    const { api, workerId } = this.deps;
    const taskId = String(claimed.taskId);
    const context = await api.getContext({ taskId: claimed.taskId });
    if (!context?.project) throw new Error("Project not found for direct thread");
    const project = context.project;
    const agentRow = (context.agents as Array<{ _id: string }>).find((a) => String(a._id) === String(claimed.direct.agentId)) ?? null;

    // Absolute paths only (live test 4): a relative project path resolves
    // under the worker's absolute WORKSPACE_ROOT.
    const root = path.resolve(this.deps.workspaceRoot);
    let cwd = path.resolve(resolveWorkspacePath(root, project.workspacePath));
    let isolated = false;
    if (this.deps.policy.worktreeIsolation) {
      const created = await api.createBranch({ taskId: claimed.taskId, projectId: claimed.projectId, workspaceRoot: root });
      cwd = path.resolve(resolveWorkspacePath(root, created.worktreePath));
      isolated = true;
    }
    await fs.mkdir(cwd, { recursive: true });

    const binary = findOpencodeBinary({ explicit: wenvRaw("ORCHESTRATOR_NATIVE_PROVIDER_COMMAND") });
    const choice = chooseDirectEngine({ binary, worktreeIsolation: isolated });
    const resolver = await buildTaskLlmResolver(context.llmProviders);
    const agentDef = agentRow ? toAgentDefinition(agentRow as never) : undefined;
    let llm: ReturnType<typeof resolver.configFor> | undefined;
    try {
      llm = resolver.configFor(agentDef);
    } catch {
      llm = undefined;
    }

    const opencodeCtx = context as { opencodeModel?: string };
    let engine: DirectEngine;
    let model: string | undefined;
    if (choice.engine === "opencode-acp") {
      const built = buildOpencodeConfig({ model: opencodeCtx.opencodeModel, llm });
      model = built.model;
      const env = buildChildEnv({ PWD: cwd, ...built.env });
      engine = new AcpEngine({
        binary: binary!,
        args: OPENCODE_ACP_ARGS,
        // Last, so nothing the thread or the worker env says can take them off.
        env: { ...env, ...opencodeEnv({ base: built.config, source: env }) },
        log: acpLogger(this.deps.log),
        workspaceRoot: cwd,
        processHooks: this.agentPids,
      });
      void OPENCODE_KEY_ENV;
    } else {
      if (!llm) throw new Error(`No LLM is configured for the direct thread's role, and ${choice.reason}`);
      const provider = createGlobalLLMProvider(llm);
      model = llm.model;
      engine = new ApiLoopEngine({
        provider,
        model: llm.model,
        gate: (fn, signal) => runWithLlmGates(fn, { signal }),
      });
    }

    // Rule 6: the same budget the task runner keeps, seeded from usage
    // already recorded for this task, checked before every prompt.
    const runnerDeps = { api, workerId, policy: this.deps.policy, workspaceRoot: root, log: this.deps.log, shutdownSignal: this.deps.shutdownSignal } as RunnerDeps;
    const budget = new BudgetTracker(this.deps.policy);
    await seedBudgetFromPersisted({ deps: runnerDeps, taskId: claimed.taskId, projectId: claimed.projectId, budget });
    const budgetGate = createBudgetGate(runnerDeps, budget, taskId, String(claimed.projectId));

    const agentName = claimed.agent?.name ?? claimed.direct.role;
    const store: DirectStore = {
      appendEvents: async (events, state) =>
        (await api.appendDirectEvents({ taskId: claimed.taskId, workerId, events, ...(state ? { state } : {}) })).seqs,
      flushStream: async (seq, items) => {
        await api.flushDirectStream({ taskId: claimed.taskId, workerId, seq, items });
      },
      clearStreams: async () => {
        await api.clearDirectStreams({ taskId: claimed.taskId, workerId });
      },
      requestApproval: async ({ itemId, request, input }) => {
        const r = await api.requestDirectApproval({ taskId: claimed.taskId, workerId, itemId, request, input });
        return { status: r.status, approvalId: String(r.approvalId), reason: r.reason };
      },
      approvalState: async (approvalId) => await api.getDirectApproval({ approvalId }),
      cancelApproval: async (approvalId, reason, message) => {
        await api.cancelDirectApproval({ approvalId, reason: message, code: reason });
      },
      loadEvents: async () => await api.getDirectHistory({ taskId: claimed.taskId }),
      recordUsage: async (usage) => {
        budget.recordLLMCall({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model: usage.model ?? model ?? "opencode", agentName, agentId: claimed.direct.agentId });
        await api.recordTokenUsage({
          projectId: claimed.projectId,
          taskId: claimed.taskId,
          agentId: claimed.direct.agentId,
          agentName,
          model: usage.model ?? model ?? "opencode",
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.costUsd !== undefined ? { estimatedCost: usage.costUsd } : {}),
        });
      },
    };

    const runner = new ThreadRunner({
      taskId,
      cwd,
      engine,
      store,
      preamble: directPreamble({ role: claimed.direct.role, agentName, systemPrompt: claimed.agent?.systemPrompt, cwd, isolated }),
      model,
      // The API loop keeps nothing across processes: a stored id is ACP's.
      sessionId: engine.name === "opencode-acp" && claimed.direct.engine === "opencode-acp" ? claimed.direct.sessionId : undefined,
      budgetGate,
      log: this.deps.log,
      approvalMaxMs: directApprovalMaxMs(),
      // ACP turns only: session/prompt has no timeout of its own.
      ...(engine.name === "opencode-acp" ? { watchdog: directWatchdog() } : {}),
    });
    const live: Live = {
      taskId,
      runner,
      lastActivity: Date.now(),
      handledInterrupt: claimed.direct.interruptRequestedAt ?? 0,
      deliveredSeq: claimed.direct.deliveredSeq ?? 0,
      closing: false,
    };
    this.live.set(taskId, live);
    await store.appendEvents([], { engine: engine.name, status: "idle", error: null });
    if (choice.engine === "api-loop") {
      await store.appendEvents([{ type: "system.note", payload: { text: `This thread runs on the API loop (no workspace tools): ${choice.reason}.` } }]);
    }
    this.deps.log(`direct thread ${taskId} on ${engine.name} in ${cwd}`);
    this.schedule(live);
  }

  private schedule(live: Live): void {
    if (live.closing) return;
    live.timer = setTimeout(() => void this.pollOnce(live), DIRECT_POLL_MS);
    live.timer.unref?.();
  }

  private async pollOnce(live: Live): Promise<void> {
    if (live.closing) return;
    try {
      const state = await this.deps.api.pollDirectThread({ taskId: live.taskId, workerId: this.deps.workerId });
      if (!state || !state.owned) return void (await this.stop(live, "no longer owned", false));
      if (state.status === "cancelled" || state.status === "done" || state.status === "failed" || state.status === "rejected") {
        return void (await this.stop(live, "thread closed", true));
      }
      if (state.interruptRequestedAt && state.interruptRequestedAt > live.handledInterrupt) {
        live.handledInterrupt = state.interruptRequestedAt;
        live.lastActivity = Date.now();
        await live.runner.interrupt();
        // Stop drops what was queued too.
        const last = state.messages.length ? state.messages[state.messages.length - 1].seq : 0;
        if (last > live.deliveredSeq) {
          live.deliveredSeq = last;
          await this.deps.api
            .appendDirectEvents({
              taskId: live.taskId as never,
              workerId: this.deps.workerId,
              events: [{ type: "system.note", payload: { text: `Stopped. ${state.messages.length} queued message(s) were not sent.` } }],
              state: { deliveredSeq: last },
            })
            .catch(() => undefined);
        }
      } else {
        for (const message of state.messages) {
          if (message.seq <= live.deliveredSeq) continue;
          live.deliveredSeq = message.seq;
          live.lastActivity = Date.now();
          await live.runner.deliver({ seq: message.seq, text: message.text });
        }
      }
      if (live.runner.busy) live.lastActivity = Date.now();
      else if (Date.now() - live.lastActivity > directIdleMs()) {
        return void (await this.stop(live, "idle", true));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log("direct poll error", live.taskId, message);
      if (/Lease lost/i.test(message)) return void (await this.stop(live, "lease lost", false));
    } finally {
      this.schedule(live);
    }
  }

  /** End the session; `release` hands the thread back (idle, closed, shutdown). */
  private async stop(live: Live, reason: string, release: boolean): Promise<void> {
    if (live.closing) return;
    live.closing = true;
    if (live.timer) clearTimeout(live.timer);
    try {
      await live.runner.close(reason);
    } catch (error) {
      this.deps.log("direct close error", live.taskId, error);
    }
    if (release) {
      await this.deps.api
        .releaseDirectThread({ taskId: live.taskId as never, workerId: this.deps.workerId, reason })
        .catch((error) => this.deps.log("direct release failed", live.taskId, error));
    }
    this.live.delete(live.taskId);
  }
}
