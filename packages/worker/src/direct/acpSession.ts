// Adapted from threadbear (https://github.com/mikecann/threadbear), runner/src/adapters/acp/adapter.ts @ 43fa197.
// MIT License, Copyright (c) 2026 Mike Cann. See THIRD_PARTY_NOTICES.md.
//
// Changes for Fhara (copy and trim): OpenCode only; the experiments flag,
// the MCP-over-HTTP server, threadbear's own tools, pictures, slash
// commands, plan mode and model/effort switching mid-session are dropped.
// Kept: the boot and session/new|resume|load order (load replays are
// dropped), permission() (now shaped by direct/toolGate.ts and decided by
// the backend so every answer is an approval row), turn() with
// session/prompt and no timeout, interrupt() via session/cancel with every
// open request answered "cancelled", resultFor's stop-reason mapping, and
// the end/kill/exited order. Usage comes from the session/prompt answer.

// Threads on OpenCode over ACP: one process per live thread, and everything
// it wants to do comes through here first. The agent is set to ask before
// every tool (vendor/threadbear/acp/agents.ts), and each request is answered
// from the thread's permission mode at that moment, so leaving Full access
// takes effect at once, with no new process.
import {
  AcpExitedError,
  AcpProcess,
  AcpRpcError,
  AUTH_REQUIRED,
  type AcpLogger,
  type AcpTimings,
  type InitializeResult,
  type RequestId,
} from "@/vendor/threadbear/acp/connection";
import { identifiesOpencode } from "@/vendor/threadbear/acp/agents";
import { AcpNormalizer, isPlainObject, requestPaths, type AcpOutput, type AcpToolCall } from "@/vendor/threadbear/acp/normalize";
import { describeToolCall, gateToolCall } from "./toolGate";
import {
  SessionNotFoundError,
  type DirectEngine,
  type DirectSession,
  type SessionSink,
  type StartSessionOptions,
  type TurnResult,
  type TurnUsage,
  type UserInput,
} from "./types";

export type AcpEngineDeps = {
  binary: string;
  args: string[];
  /** The whole child env (scrubbed by buildChildEnv, plus opencodeEnv last). */
  env: Record<string, string | undefined>;
  log: AcpLogger;
  timings?: Partial<AcpTimings>;
  now?: () => number;
  /** The worktree root: an edit outside it never auto-allows. */
  workspaceRoot?: string;
  /** Checks that the process is the agent we meant (default: OpenCode). */
  identifies?: (init: InitializeResult) => boolean;
  newId?: () => string;
};

type SessionResult = {
  sessionId?: string;
  configOptions?: { id?: string; category?: string; currentValue?: unknown }[] | null;
};

function notFound(e: unknown): boolean {
  if (e instanceof AcpRpcError && e.code === -32002) return true;
  return /not found|no such session|does not exist/i.test(e instanceof Error ? e.message : String(e));
}

export class AcpEngine implements DirectEngine {
  readonly name = "opencode-acp" as const;
  constructor(private readonly deps: AcpEngineDeps) {}

  start(opts: StartSessionOptions, sink: SessionSink): DirectSession {
    const s = new AcpSession(opts, sink, this.deps);
    s.start();
    return s;
  }
}

type State = "starting" | "ready" | "turn" | "closing" | "closed";
type PermissionOption = { optionId?: string; kind?: string };
type Pending = { abort: AbortController; options: PermissionOption[] };

export class AcpSession implements DirectSession {
  private opts: StartSessionOptions;
  private sink: SessionSink;
  private deps: AcpEngineDeps;
  private now: () => number;
  private proc: AcpProcess;
  private normalizer: AcpNormalizer;
  private state: State = "starting";
  private sessionId?: string;
  private init: InitializeResult = {};
  private held: UserInput[] = [];
  private turn?: { startedAt: number; interrupted: boolean };
  private pending = new Map<RequestId, Pending>();
  private configOptions: NonNullable<SessionResult["configOptions"]> = [];
  private preamble?: string;
  private replaying = false;
  private exitedCalled = false;

  constructor(opts: StartSessionOptions, sink: SessionSink, deps: AcpEngineDeps) {
    this.opts = opts;
    this.sink = sink;
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.preamble = opts.sessionId ? undefined : opts.preamble;
    this.normalizer = new AcpNormalizer({ cwd: opts.cwd }, deps.newId);
    this.proc = new AcpProcess({ binary: deps.binary, args: deps.args, env: deps.env, cwd: opts.cwd, log: deps.log, label: opts.taskId, timings: deps.timings });
    this.proc.onNotification = (method, params) => this.notification(method, params);
    this.proc.onRequest = (id, method, params) => this.request(id, method, params);
    this.proc.onExit = (err) => this.exited(err);
  }

  start(): void {
    void this.boot().catch((e: unknown) => {
      if (this.state === "closing" || this.state === "closed") return void this.finish();
      this.deps.log.warn("acp session did not start", { taskId: this.opts.taskId, error: String(e) });
      void this.finish(e instanceof Error ? e : new Error(String(e)));
    });
  }

  private async boot(): Promise<void> {
    this.init = await this.proc.start();
    if (this.state !== "starting") return void (await this.proc.close());
    const identifies = this.deps.identifies ?? identifiesOpencode;
    if (!identifies(this.init)) {
      const said = this.init.agentInfo?.name ? ` (it says it's ${this.init.agentInfo.name})` : "";
      throw new Error(`The program found for OpenCode isn't OpenCode${said}, so this thread wasn't started.`);
    }
    let res: SessionResult;
    try {
      res = await this.openSession();
    } catch (e) {
      if (e instanceof AcpRpcError && e.code === AUTH_REQUIRED) {
        throw new Error("OpenCode needs a sign-in. Run `opencode auth login` in a terminal on the worker, then send this again.");
      }
      throw e;
    }
    if (this.state !== "starting") return;
    this.sessionId = this.sessionId ?? res.sessionId;
    if (typeof this.sessionId !== "string" || !this.sessionId) throw new Error("OpenCode started a session without an id");
    if (Array.isArray(res.configOptions)) this.configOptions = res.configOptions;
    if (this.opts.model) await this.applyModel(this.opts.model);
    const model = this.modelNow();
    this.sink.output({ kind: "session", sessionId: this.sessionId, ...(model ? { model } : {}) });
    this.state = "ready";
    this.next();
  }

  private openSession(): Promise<SessionResult> {
    const { opts } = this;
    const caps = this.init.agentCapabilities;
    if (!opts.sessionId) return this.proc.request<SessionResult>("session/new", { cwd: opts.cwd, mcpServers: [] });
    this.sessionId = opts.sessionId;
    const common = { sessionId: opts.sessionId, cwd: opts.cwd, mcpServers: [] };
    const opened =
      caps?.sessionCapabilities?.resume !== undefined
        ? this.proc.request<SessionResult>("session/resume", common)
        : caps?.loadSession
          ? this.load(common)
          : Promise.reject(new SessionNotFoundError("This agent can't carry on a session in a new process."));
    return opened.catch((e: unknown) => {
      if (e instanceof SessionNotFoundError || notFound(e)) {
        throw new SessionNotFoundError(`The session to resume wasn't found (${(e as Error).message}).`);
      }
      throw e;
    });
  }

  // session/load replays the old conversation as updates: already in the
  // transcript, so they're dropped.
  private async load(params: Record<string, unknown>): Promise<SessionResult> {
    this.replaying = true;
    try {
      return await this.proc.request<SessionResult>("session/load", params);
    } finally {
      this.replaying = false;
    }
  }

  private modelNow(): string | undefined {
    const v = this.configOptions.find((o) => o.category === "model")?.currentValue;
    return typeof v === "string" ? v : undefined;
  }

  private async applyModel(model: string): Promise<void> {
    const option = this.configOptions.find((o) => o.category === "model");
    if (!option?.id || option.currentValue === model) return;
    try {
      const r = await this.proc.request<SessionResult>("session/set_config_option", { sessionId: this.sessionId, configId: option.id, value: model });
      if (Array.isArray(r?.configOptions)) this.configOptions = r.configOptions;
    } catch (e) {
      this.deps.log.warn("could not set the model", { taskId: this.opts.taskId, model, error: String(e) });
      this.emit([{ kind: "event", event: { type: "system.note", text: `${model} couldn't be picked, so this thread uses ${this.modelNow() ?? "the default model"}.` } }]);
    }
  }

  // ---- From the agent

  private notification(method: string, params: unknown): void {
    if (this.replaying || method !== "session/update" || !isPlainObject(params)) return;
    if (this.sessionId && params.sessionId !== undefined && params.sessionId !== this.sessionId) return;
    this.emit(this.normalizer.handle(params.update));
  }

  private emit(outs: AcpOutput[]): void {
    for (const o of outs) this.sink.output(o);
  }

  private request(id: RequestId, method: string, params: unknown): void {
    if (method === "session/request_permission" && !this.replaying) {
      // Never left unanswered: the turn would hang with session/prompt open.
      this.permission(id, (params ?? {}) as { toolCall?: AcpToolCall; options?: PermissionOption[] }).catch((e: unknown) => {
        this.deps.log.error("acp permission handler threw", { taskId: this.opts.taskId, error: String(e) });
        this.pending.delete(id);
        this.proc.respond(id, { outcome: { outcome: "cancelled" } });
      });
      return;
    }
    // We said we offer no fs or terminal: refused at once, so nothing hangs.
    this.deps.log.info("refused an ACP request", { taskId: this.opts.taskId, method });
    this.proc.respondError(id, -32601, `Fhara doesn't handle ${method}.`);
  }

  // Only the once kinds: "always" would be remembered by the agent, past
  // this thread. "Always allow" is kept by Fhara (tasks.direct.allowRules).
  private answer(id: RequestId, options: PermissionOption[], allow: boolean): void {
    const kind = allow ? "allow_once" : "reject_once";
    const optionId = options.find((o) => o?.kind === kind)?.optionId;
    // No plain allow or reject on offer: nothing ever goes ahead by default.
    this.proc.respond(id, optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
  }

  private async permission(id: RequestId, p: { toolCall?: AcpToolCall; options?: PermissionOption[] }): Promise<void> {
    const options = Array.isArray(p.options) ? p.options : [];
    const seen = this.normalizer.noteCall(p.toolCall ?? {});
    this.emit(this.normalizer.flush());
    this.emit(seen.events);
    const rawInput = isPlainObject(p.toolCall?.rawInput) && Object.keys(p.toolCall!.rawInput as object).length ? (p.toolCall!.rawInput as Record<string, unknown>) : seen.input;
    const description = describeToolCall({
      cwd: this.opts.cwd,
      kind: seen.kind,
      rawInput,
      paths: [...new Set([...seen.paths, ...requestPaths(p.toolCall ?? {})])],
      title: seen.title,
      workspaceRoot: this.deps.workspaceRoot ?? this.opts.cwd,
    });
    const pending: Pending = { abort: new AbortController(), options };
    this.pending.set(id, pending);
    const gate = await gateToolCall(
      {
        requestApproval: (call) => this.sink.requestApproval(call),
        note: (text) => this.emit([{ kind: "event", event: { type: "system.note", text } }]),
      },
      { itemId: seen.id, description, signal: pending.abort.signal }
    );
    // Already answered as cancelled: an interrupt, or the session ending.
    if (!this.pending.delete(id)) return;
    if (!gate.allowed && pending.abort.signal.aborted) return void this.proc.respond(id, { outcome: { outcome: "cancelled" } });
    this.answer(id, options, gate.allowed);
  }

  // Every open request answered as cancelled, which ACP requires of a
  // client cancelling a turn. Cards close with it.
  private cancelPending(respond: boolean): void {
    for (const [id, p] of this.pending) {
      p.abort.abort();
      if (respond) this.proc.respond(id, { outcome: { outcome: "cancelled" } });
    }
    this.pending.clear();
  }

  // ---- Turns

  send(input: UserInput): void {
    if (this.state === "closing" || this.state === "closed") {
      this.deps.log.warn("a message reached an acp session that has ended", { taskId: this.opts.taskId });
      return;
    }
    // ACP has no way to add to a running turn: it's the next prompt, and
    // the runner keeps it in the same turn (a steer).
    this.held.push(input);
    this.next();
  }

  private next(): void {
    if (this.state !== "ready" || this.turn || !this.held.length) return;
    void this.runTurn(this.held.shift()!);
  }

  private promptBlocks(input: UserInput): unknown[] {
    const blocks: unknown[] = [];
    if (this.preamble) {
      blocks.push({ type: "text", text: this.preamble });
      this.preamble = undefined;
    }
    blocks.push({ type: "text", text: input.text });
    return blocks;
  }

  private async runTurn(input: UserInput): Promise<void> {
    const turn = { startedAt: this.now(), interrupted: false };
    this.turn = turn;
    this.state = "turn";
    let result: Omit<TurnResult, "queuedTurns">;
    try {
      const r = await this.proc.request<{ stopReason?: string; usage?: Record<string, unknown> }>(
        "session/prompt",
        { sessionId: this.sessionId, prompt: this.promptBlocks(input) },
        null
      );
      this.emit(this.normalizer.closeOpen("Stopped"));
      result = { ...this.resultFor(turn, r?.stopReason), ...(usageOf(r?.usage, this.normalizer.costUsd, this.modelNow()) ?? {}) };
    } catch (e) {
      if (e instanceof AcpExitedError) return; // the exit handler reports it
      this.emit(this.normalizer.closeOpen("Failed"));
      const auth = e instanceof AcpRpcError && e.code === AUTH_REQUIRED;
      result = {
        outcome: turn.interrupted ? "interrupted" : "failed",
        durationMs: Math.max(0, this.now() - turn.startedAt),
        ...(turn.interrupted ? {} : { error: (e as Error).message }),
        ...(auth ? { errorKind: "auth" as const } : {}),
      };
    }
    if (this.turn !== turn) return;
    this.turn = undefined;
    if (this.state === "turn") this.state = "ready";
    this.sink.output({ kind: "result", result: { ...result, queuedTurns: this.held.length } });
    this.next();
  }

  private resultFor(turn: { startedAt: number; interrupted: boolean }, stop: string | undefined): Omit<TurnResult, "queuedTurns"> {
    const durationMs = Math.max(0, this.now() - turn.startedAt);
    switch (stop) {
      case "cancelled":
        return { outcome: "interrupted", durationMs };
      case "refusal":
        return { outcome: "failed", durationMs, error: "The model refused to continue." };
      case "max_tokens":
        return { outcome: "failed", durationMs, error: "The reply reached the model's length limit." };
      case "max_turn_requests":
        return { outcome: "failed", durationMs, error: "The turn reached the agent's limit on steps." };
      default:
        return { outcome: turn.interrupted ? "interrupted" : "completed", durationMs };
    }
  }

  async interrupt(): Promise<void> {
    if (this.state === "closed" || this.state === "closing") {
      if (!this.proc.alive) throw new Error("The agent has already exited.");
      return;
    }
    // Stop means stop: what's waiting for a later prompt goes too.
    this.held = [];
    const turn = this.turn;
    if (!turn) return;
    turn.interrupted = true;
    this.cancelPending(true);
    this.proc.notify("session/cancel", { sessionId: this.sessionId });
  }

  // ---- Ending

  async end(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closing";
    await this.finish();
  }

  kill(): void {
    if (this.state === "closed") return;
    this.state = "closing";
    this.proc.kill();
    this.exited();
  }

  private async finish(error?: Error): Promise<void> {
    if (this.state !== "closed") this.state = "closing";
    this.proc.onExit = null;
    await this.proc.close().catch(() => undefined);
    this.exited(error);
  }

  private exited(error?: Error): void {
    if (this.exitedCalled) return;
    this.exitedCalled = true;
    this.state = "closed";
    this.cancelPending(false);
    this.proc.onRequest = null;
    this.emit(this.normalizer.closeOpen("Interrupted"));
    this.turn = undefined;
    this.sink.exited(error);
  }
}

/** Token usage from a session/prompt answer (OpenCode reports it there). */
export function usageOf(raw: Record<string, unknown> | undefined, costUsd: number | undefined, model: string | undefined): { usage: TurnUsage } | null {
  if (!raw || typeof raw !== "object") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const inputTokens = n(raw.inputTokens);
  const outputTokens = n(raw.outputTokens);
  if (!inputTokens && !outputTokens) return null;
  return {
    usage: {
      inputTokens,
      outputTokens,
      ...(n(raw.cachedReadTokens) ? { cachedReadTokens: n(raw.cachedReadTokens) } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(model ? { model } : {}),
    },
  };
}
