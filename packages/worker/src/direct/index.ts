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
 */
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
import { AcpEngine } from "./acpSession";
import { ApiLoopEngine } from "./apiLoopSession";
import { ThreadRunner, type DirectStore } from "./threadRunner";
import type { DirectEngine } from "./types";

export const DIRECT_POLL_MS = Math.max(250, Number(process.env.DIRECT_POLL_MS ?? 750));

export function directIdleMs(env: Record<string, string | undefined> = process.env): number {
  const minutes = Number(env.DIRECT_IDLE_MIN ?? 10);
  return Math.max(1, Number.isFinite(minutes) ? minutes : 10) * 60_000;
}

export function directMaxLive(env: Record<string, string | undefined> = process.env): number {
  const n = Math.floor(Number(env.DIRECT_MAX_LIVE ?? 4));
  return Math.min(8, Math.max(1, Number.isFinite(n) ? n : 4));
}

/** Which engine a thread gets: ACP when OpenCode is installed and may run there. */
export function chooseDirectEngine(input: {
  binary: string | undefined;
  worktreeIsolation: boolean | undefined;
  env?: Record<string, string | undefined>;
}): { engine: "opencode-acp" | "api-loop"; reason: string } {
  const env = input.env ?? process.env;
  if ((env.DIRECT_ENGINE ?? "").trim() === "api-loop") return { engine: "api-loop", reason: "DIRECT_ENGINE=api-loop" };
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
  ].join("\n");
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

  constructor(private readonly deps: DirectThreadsDeps) {}

  /** Ids whose leases the heartbeat must renew. */
  activeTaskIds(): string[] {
    return [...this.live.keys()];
  }

  get size(): number {
    return this.live.size;
  }

  /** One claim attempt; returns true when a thread was started. */
  async tick(): Promise<boolean> {
    if (this.claiming || this.deps.shutdownSignal.aborted || this.live.size >= directMaxLive()) return false;
    this.claiming = true;
    try {
      const claimed = await this.deps.api.claimDirectThread({ workerId: this.deps.workerId, leaseMs: this.deps.leaseMs });
      if (!claimed) return false;
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

    const binary = findOpencodeBinary({ explicit: process.env.ORCHESTRATOR_NATIVE_PROVIDER_COMMAND });
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
      cancelApproval: async (approvalId, reason) => {
        await api.cancelDirectApproval({ approvalId, reason });
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
