// Adapted from threadbear (https://github.com/mikecann/threadbear), runner/src/adapters/acp/connection.ts @ 43fa197.
// MIT License, Copyright (c) 2026 Mike Cann. See THIRD_PARTY_NOTICES.md.
//
// Changes for Fhara: the runner's log, process registry and line reader
// (proc.ts, codex/appserver.ts) are replaced by a small Logger interface,
// a detached spawn with process-group kills, and a local newline reader
// with the same size guard; the child env goes through buildChildEnv so a
// worker secret never reaches the agent. clientInfo names Fhara. The stderr
// tail is redacted (vendor/nuphos/stderrTail.ts, from openab) and the exit
// message names the cause of death (vendor/nuphos/processDeath.ts, from
// Nuphos); a bare internal error gets the redacted tail as its detail. The
// agent's process group is reported to processHooks (direct/agentPids.ts)
// and, once its leader exits, any member left behind is signalled.
// Everything else (the JSON-RPC framing, pending map, timeouts, close/kill
// order) is unchanged.

// One ACP agent process (Agent Client Protocol, agentclientprotocol.com):
// newline-delimited JSON-RPC 2.0 over its stdio, in its own process group.
import { spawn, type ChildProcess } from 'node:child_process';
import { buildChildEnv } from '@/api/convex/lib/childEnv';
import { redactText } from '../../../utils/redact';
import { StderrTail } from '../../nuphos/stderrTail';
import { describeProcessDeath, oomKills, ownCgroup } from '../../nuphos/processDeath';

export type RequestId = number | string;

/** The logging the connection needs; the worker passes its own. */
export type AcpLogger = {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
};

export const silentLogger: AcpLogger = { debug() {}, info() {}, warn() {}, error() {} };

// Numbered as ACP's errors are; -32000 is its auth_required.
export const AUTH_REQUIRED = -32000;

/** Longest line read from an agent (threadbear: MAX_LINE_BYTES). */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** JSON-RPC's internal error: agents send it bare when something they didn't expect broke. */
export const INTERNAL_ERROR = -32603;

export class AcpRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  /**
   * The agent's message is its own text and may quote a credential, so it is
   * masked (L2). A bare internal error carries the agent's redacted stderr
   * tail instead of nothing (openab `with_recent_stderr`).
   */
  constructor(method: string, body: { code?: unknown; message?: unknown; data?: unknown }, stderrTail = '') {
    const base = typeof body?.message === 'string' ? redactText(body.message) : `${method} failed`;
    const code = typeof body?.code === 'number' ? body.code : INTERNAL_ERROR;
    const dataMessage = (body?.data as { message?: unknown } | undefined)?.message;
    const bare = code === INTERNAL_ERROR && !(typeof dataMessage === 'string' && dataMessage.trim());
    super(bare && stderrTail ? `${base}\nThe agent gave no error details. Its last error output:\n${stderrTail}` : base);
    this.name = 'AcpRpcError';
    this.code = code;
    this.data = body?.data;
  }
}

export class AcpExitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpExitedError';
  }
}

export type InitializeResult = {
  protocolVersion?: number;
  agentCapabilities?: {
    loadSession?: boolean;
    mcpCapabilities?: { http?: boolean; sse?: boolean };
    promptCapabilities?: { image?: boolean; embeddedContext?: boolean };
    sessionCapabilities?: { resume?: unknown; close?: unknown };
  };
  agentInfo?: { name?: string; version?: string } | null;
  authMethods?: { id?: string; name?: string }[];
};

export type AcpTimings = {
  requestMs: number; // an ordinary request
  sessionMs: number; // session/new, load and resume, which start MCP servers
  closeWaitMs: number; // after closing stdin, before killing the group
};
export const DEFAULT_ACP_TIMINGS: AcpTimings = { requestMs: 30_000, sessionMs: 90_000, closeWaitMs: 2_000 };

export type AcpProcessOptions = {
  binary: string;
  args: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  log: AcpLogger;
  label: string; // the task id, for log lines
  /** Who the agent is in an exit message ("OpenCode"); default "The agent". */
  agentName?: string;
  maxLineBytes?: number;
  timings?: Partial<AcpTimings>;
  clientVersion?: string;
  /**
   * Told about the agent's process group (direct/agentPids.ts): when it was
   * spawned, and when its leader exited (again once any leftover members
   * were signalled), so a worker that dies can have them reaped later.
   */
  processHooks?: AcpProcessHooks;
};

export type AcpProcessHooks = {
  spawned(pid: number, cmd: { binary: string; args: string[]; label: string }): void;
  exited(pid: number): void;
};

// The ACP version this client speaks; initialize's answer must match it.
export const ACP_VERSION = 1;

/** Splits a byte stream into lines; a line over the guard is skipped. */
class LineReader {
  private parts: Buffer[] = [];
  private size = 0;
  private skipping = false;
  constructor(
    private readonly max: number,
    private readonly onLine: (line: Buffer) => void,
    private readonly onOversized: (bytes: number) => void
  ) {}
  push(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl === -1) {
        const rest = chunk.subarray(start);
        if (!this.skipping) {
          this.parts.push(rest);
          this.size += rest.length;
          if (this.size > this.max) {
            this.skipping = true;
            this.parts = [];
          }
        } else this.size += rest.length;
        return;
      }
      const piece = chunk.subarray(start, nl);
      if (this.skipping) {
        this.onOversized(this.size + piece.length);
        this.skipping = false;
      } else {
        const line = this.parts.length ? Buffer.concat([...this.parts, piece]) : piece;
        if (line.length > this.max) this.onOversized(line.length);
        else if (line.length > 0) this.onLine(line);
      }
      this.parts = [];
      this.size = 0;
      start = nl + 1;
    }
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class AcpProcess {
  // Set by the session. A request from the agent with no handler is refused
  // at once, so the agent never waits on nobody.
  onRequest: ((id: RequestId, method: string, params: unknown) => void) | null = null;
  onNotification: ((method: string, params: unknown) => void) | null = null;
  onExit: ((error?: Error) => void) | null = null;
  version?: string;

  private opts: AcpProcessOptions;
  private t: AcpTimings;
  private child?: ChildProcess;
  private pid?: number;
  private nextId = 1;
  private pending = new Map<RequestId, { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();
  private stderrTail = new StderrTail();
  private cgroup: string | null = null;
  private oomKillsAtStart = 0;
  private exited = true;
  private exitWaiters: (() => void)[] = [];
  private closing = false;

  constructor(opts: AcpProcessOptions) {
    this.opts = opts;
    this.t = { ...DEFAULT_ACP_TIMINGS, ...opts.timings };
  }

  get alive(): boolean {
    return !this.exited;
  }

  /** The agent's recent stderr, redacted: error-like lines only, credentials withheld. */
  stderrLines(): string[] {
    return this.stderrTail.list();
  }

  // Spawns the process and completes initialize.
  start(): Promise<InitializeResult> {
    const { opts } = this;
    const child = spawn(opts.binary, opts.args, {
      cwd: opts.cwd,
      // The caller builds the env (allowlist + the agent's own variables);
      // the worker's secrets are dropped again here, whatever it passed.
      env: buildChildEnv(opts.env, { source: {} }),
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so close() and kill() reach its children too.
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: false,
    });
    this.child = child;
    this.pid = child.pid;
    if (this.pid && process.platform !== 'win32') this.hook((h, pid) => h.spawned(pid, { binary: opts.binary, args: opts.args, label: opts.label }));
    // The agent runs in the worker's cgroup: an OOM kill there while it ran
    // names the memory limit as its cause of death.
    this.cgroup = process.platform === 'linux' ? ownCgroup() : null;
    this.oomKillsAtStart = oomKills(this.cgroup);
    this.exited = false;
    let stderrBuf = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString('utf8');
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const line of lines) this.stderr(line);
    });
    return new Promise<InitializeResult>((resolve, reject) => {
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        reject(e);
      };
      child.on('error', (e) => {
        // ENOENT and friends: the spawn failed and no exit follows.
        this.markExited();
        for (const p of this.pending.values()) {
          if (p.timer) clearTimeout(p.timer);
          p.reject(new AcpExitedError(e.message));
        }
        this.pending.clear();
        fail(e);
      });
      child.stdin?.on('error', () => {
        // EPIPE when it died; the exit handler reports it.
      });
      const reader = new LineReader(
        opts.maxLineBytes ?? MAX_LINE_BYTES,
        (line) => this.onLine(line),
        (bytes) => opts.log.warn('skipped a line from an ACP agent over the size guard', { taskId: opts.label, bytes }),
      );
      child.stdout?.on('data', (d: Buffer) => reader.push(d));
      child.once('exit', (code, signal) => {
        if (stderrBuf) this.stderr(stderrBuf);
        stderrBuf = '';
        this.markExited();
        this.reapLeftovers();
        const what = this.exitMessage(code, signal);
        for (const p of this.pending.values()) {
          if (p.timer) clearTimeout(p.timer);
          p.reject(new AcpExitedError(what));
        }
        this.pending.clear();
        if (!settled) return fail(new AcpExitedError(what));
        const onExit = this.onExit;
        this.onExit = null;
        onExit?.(this.closing ? undefined : new Error(what));
      });
      this.request<InitializeResult>('initialize', {
        protocolVersion: ACP_VERSION,
        // Nothing the agent could use to read or write through the client:
        // it works on the files itself, and asks first (AcpSession).
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'fhara', title: 'Fhara', version: opts.clientVersion ?? '1.0.0' },
      })
        .then((init) => {
          if (init?.protocolVersion !== ACP_VERSION) {
            throw new Error(`This agent speaks ACP version ${String(init?.protocolVersion)}, and Fhara speaks ${ACP_VERSION}.`);
          }
          if (typeof init?.agentInfo?.version === 'string') this.version = init.agentInfo.version;
          settled = true;
          resolve(init ?? {});
        })
        .catch(fail);
    });
  }

  /** The cause of death in words, then the agent's last redacted error lines. */
  exitMessage(code: number | null, signal: NodeJS.Signals | string | null): string {
    const own = this.stderrTail.processDeath;
    const death = own
      ? `${own.replace(/\s*Send a message to continue\.?$/, '')} Send a message to continue.`
      : describeProcessDeath({
          agent: this.opts.agentName ?? 'The agent',
          code,
          signal,
          cgroup: this.cgroup,
          oomKillsBefore: this.oomKillsAtStart,
        });
    const tail = this.stderrTail.text(5);
    return tail ? `${death}\nIts last error output:\n${tail}` : death;
  }

  private hook(fn: (h: AcpProcessHooks, pid: number) => void): void {
    const h = this.opts.processHooks;
    if (!h || !this.pid) return;
    try {
      fn(h, this.pid);
    } catch (error) {
      this.opts.log.warn('acp process hook failed', { taskId: this.opts.label, error: String(error) });
    }
  }

  // The leader is gone; its children (MCP servers) may not be. They're
  // signalled like close() would, and the registry is told twice: now, and
  // once they've had their grace.
  private reapLeftovers(): void {
    const pid = this.pid;
    if (!pid || process.platform === 'win32') return;
    this.hook((h) => h.exited(pid));
    if (!groupAlive(pid)) return;
    killGroup(pid, 'SIGTERM');
    setTimeout(() => {
      if (groupAlive(pid)) killGroup(pid, 'SIGKILL');
      setTimeout(() => this.hook((h) => h.exited(pid)), 200).unref();
    }, 2000).unref();
  }

  private markExited(): void {
    this.exited = true;
    const ws = this.exitWaiters;
    this.exitWaiters = [];
    ws.forEach((w) => w());
  }

  private stderr(line: string): void {
    if (!line.trim()) return;
    this.stderrTail.push(line);
    this.opts.log.debug('acp stderr', { taskId: this.opts.label, line: redactText(line.slice(0, 500)) });
  }

  private onLine(line: Buffer): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line.toString('utf8'));
    } catch {
      this.opts.log.warn('unparseable line from an ACP agent', { taskId: this.opts.label, bytes: line.length });
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    // An id can be 0: OpenCode numbers its requests from it.
    const hasId = typeof msg.id === 'number' || typeof msg.id === 'string';
    if (typeof msg.method === 'string') {
      if (hasId) this.dispatchRequest(msg.id as RequestId, msg.method, msg.params);
      else this.safely(msg.method, () => this.onNotification?.(msg.method as string, msg.params));
      return;
    }
    if (hasId) {
      const p = this.pending.get(msg.id as RequestId);
      if (!p) return;
      this.pending.delete(msg.id as RequestId);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new AcpRpcError(p.method, msg.error as { code?: unknown; message?: unknown; data?: unknown }, this.stderrTail.text()));
      else p.resolve(msg.result);
    }
  }

  // What the agent sends is its own to get wrong: a bad frame is logged, as
  // an exception out of a stream handler would take the worker down.
  private safely(method: string, f: () => void): void {
    try {
      f();
    } catch (e) {
      this.opts.log.error('acp notification handler threw', { taskId: this.opts.label, method, error: String(e) });
    }
  }

  private dispatchRequest(id: RequestId, method: string, params: unknown): void {
    if (this.onRequest) {
      try {
        this.onRequest(id, method, params);
      } catch (e) {
        this.opts.log.error('acp request handler threw', { taskId: this.opts.label, method, error: String(e) });
        this.respondError(id, -32603, 'Fhara could not handle this request.');
      }
      return;
    }
    this.respondError(id, -32601, `Fhara doesn't handle ${method} here.`);
  }

  private write(msg: Record<string, unknown>): boolean {
    const stdin = this.child?.stdin;
    if (this.exited || !stdin || stdin.destroyed || stdin.writableEnded) return false;
    stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    return true;
  }

  // timeoutMs null: no timeout (session/prompt, which lasts as long as the
  // turn does). Left out: requestMs, or sessionMs for the session/ starters.
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number | null): Promise<T> {
    const id = this.nextId++;
    const starts = method === 'session/new' || method === 'session/load' || method === 'session/resume';
    const ms = timeoutMs === undefined ? (starts ? this.t.sessionMs : this.t.requestMs) : timeoutMs;
    return new Promise<T>((resolve, reject) => {
      if (this.exited) return reject(new AcpExitedError('The agent is not running.'));
      let timer: NodeJS.Timeout | undefined;
      if (ms !== null) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`The agent didn't answer ${method} within ${Math.round(ms / 1000)} s`));
        }, ms);
        timer.unref();
      }
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      const msg: Record<string, unknown> = { id, method };
      if (params !== undefined) msg.params = params;
      if (!this.write(msg)) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(new AcpExitedError('The agent is not running.'));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    const msg: Record<string, unknown> = { method };
    if (params !== undefined) msg.params = params;
    this.write(msg);
  }

  respond(id: RequestId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RequestId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private waitExit(ms: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      t.unref();
      this.exitWaiters.push(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }

  // Ends stdin; if the agent hasn't gone after closeWaitMs, its group is
  // killed. Agents that don't watch stdin (OpenCode's server loop) rely on
  // that second half.
  async close(): Promise<void> {
    this.closing = true;
    if (this.exited) return;
    this.child?.stdin?.end();
    if (await this.waitExit(this.t.closeWaitMs)) return;
    if (this.pid) killGroup(this.pid, 'SIGTERM');
    if (await this.waitExit(2000)) return;
    if (this.pid) killGroup(this.pid, 'SIGKILL');
    await this.waitExit(2000);
  }

  // Stops the process group straight away (SIGTERM, then SIGKILL).
  kill(): void {
    this.closing = true;
    if (this.exited) return;
    if (!this.pid) return void this.child?.kill('SIGKILL');
    const pid = this.pid;
    killGroup(pid, 'SIGTERM');
    setTimeout(() => {
      if (groupAlive(pid)) killGroup(pid, 'SIGKILL');
    }, 3000).unref();
  }
}
