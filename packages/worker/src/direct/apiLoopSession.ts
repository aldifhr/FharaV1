/**
 * Fallback engine for direct threads when OpenCode is not available
 * (threadbear T2, "api-loop"): the same DirectEngine interface as the ACP
 * session, so the turn state machine (threadRunner.ts) is unchanged.
 *
 * Scope in T2: a conversation with the role's model through Fhara's own
 * LLM provider (budget-gated by the runner before every prompt, usage
 * recorded per turn, streamed into hot rows). It has NO file or shell
 * tools yet: writing files from the API loop needs the apply_changes
 * approval path (T5 edit-before-Accept), so the agent is told it can only
 * answer and propose changes. The ACP engine is the one that edits.
 */
import crypto from "node:crypto";
import type { LLMMessage, LLMProvider, LLMResult } from "@/llm";
import { callWithOverflowRecovery } from "@/context/overflowRecovery";
import type { DirectEngine, DirectSession, SessionSink, StartSessionOptions, TurnResult, UserInput } from "./types";

export const API_LOOP_NOTE =
  "You are running without workspace tools in this thread: you cannot read or change files or run commands. Answer from what the user tells you, and propose changes as diffs or steps for the user to apply.";

export type ApiLoopDeps = {
  provider: LLMProvider;
  model?: string;
  /** Runs one LLM call under the worker and task LLM gates. */
  gate?: <T>(fn: () => Promise<T>, signal: AbortSignal) => Promise<T>;
  now?: () => number;
  newId?: () => string;
  /** Turns of history kept (user + assistant pairs). */
  maxHistory?: number;
};

export class ApiLoopEngine implements DirectEngine {
  readonly name = "api-loop" as const;
  constructor(private readonly deps: ApiLoopDeps) {}

  start(opts: StartSessionOptions, sink: SessionSink): DirectSession {
    return new ApiLoopSession(opts, sink, this.deps);
  }
}

class ApiLoopSession implements DirectSession {
  private history: LLMMessage[] = [];
  private held: UserInput[] = [];
  private running?: { abort: AbortController; interrupted: boolean };
  private closed = false;
  private readonly sessionId: string;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly system: string;

  constructor(
    private readonly opts: StartSessionOptions,
    private readonly sink: SessionSink,
    private readonly deps: ApiLoopDeps
  ) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    // The API loop keeps no state outside this process: a "resumed" id is
    // a fresh conversation (the runner adds a handoff note when it can).
    this.sessionId = `api-loop-${this.newId()}`;
    this.system = [opts.preamble, API_LOOP_NOTE].filter(Boolean).join("\n\n");
    queueMicrotask(() => {
      if (this.closed) return;
      this.sink.output({ kind: "session", sessionId: this.sessionId, ...(deps.model ? { model: deps.model } : {}) });
      this.next();
    });
  }

  send(input: UserInput): void {
    if (this.closed) return;
    this.held.push(input);
    this.next();
  }

  private next(): void {
    if (this.closed || this.running || !this.held.length) return;
    void this.runTurn(this.held.shift()!);
  }

  private async runTurn(input: UserInput): Promise<void> {
    const run = { abort: new AbortController(), interrupted: false };
    this.running = run;
    const startedAt = this.now();
    const itemId = this.newId();
    const messages: LLMMessage[] = [
      ...(this.system ? [{ role: "system" as const, content: this.system }] : []),
      ...this.history,
      { role: "user", content: input.text },
    ];
    let result: Omit<TurnResult, "queuedTurns">;
    try {
      const call = (current: LLMMessage[]) => () =>
        this.deps.provider.stream
          ? this.deps.provider.stream(
              current,
              (delta) => {
                if (!run.interrupted && delta) this.sink.output({ kind: "delta", delta: { type: "assistant.text.delta", itemId, text: delta } });
              },
              this.deps.model,
              { signal: run.abort.signal }
            )
          : this.deps.provider.complete(current, this.deps.model, { signal: run.abort.signal });
      // A context overflow shrinks the older history and retries the same
      // turn, bounded (context/overflowRecovery.ts, DeepSeek Harness D2).
      const recovered = await callWithOverflowRecovery<LLMResult>({
        messages,
        call: (current) => (this.deps.gate ? this.deps.gate(call(current), run.abort.signal) : call(current)()),
        protectFirst: 0,
        protectLast: 1,
      });
      const answer = recovered.result;
      if (recovered.retries > 0) this.history = messages.filter((m) => m.role !== "system").slice(0, -1);
      if (run.interrupted) throw new Error("Stopped");
      const text = answer.content ?? "";
      if (text) this.sink.output({ kind: "event", event: { type: "assistant.text", itemId, text } });
      this.history.push({ role: "user", content: input.text }, { role: "assistant", content: text });
      const keep = (this.deps.maxHistory ?? 20) * 2;
      if (this.history.length > keep) this.history = this.history.slice(-keep);
      result = {
        outcome: "completed",
        durationMs: Math.max(0, this.now() - startedAt),
        ...(answer.inputTokens || answer.outputTokens
          ? { usage: { inputTokens: answer.inputTokens ?? 0, outputTokens: answer.outputTokens ?? 0, ...(this.deps.model ? { model: this.deps.model } : {}) } }
          : {}),
      };
    } catch (error) {
      result = run.interrupted
        ? { outcome: "interrupted", durationMs: Math.max(0, this.now() - startedAt) }
        : { outcome: "failed", durationMs: Math.max(0, this.now() - startedAt), error: error instanceof Error ? error.message : String(error) };
    }
    if (this.running !== run) return;
    this.running = undefined;
    if (this.closed) return;
    this.sink.output({ kind: "result", result: { ...result, queuedTurns: this.held.length } });
    this.next();
  }

  async interrupt(): Promise<void> {
    this.held = [];
    const run = this.running;
    if (!run) return;
    run.interrupted = true;
    run.abort.abort();
  }

  async end(): Promise<void> {
    this.kill();
  }

  kill(): void {
    if (this.closed) return;
    this.closed = true;
    this.running?.abort.abort();
    this.running = undefined;
    this.held = [];
    this.sink.exited();
  }
}
