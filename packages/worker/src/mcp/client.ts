/**
 * Plan 009: MCP stdio client.
 *
 * One JSON-RPC connection over a child process's stdin/stdout
 * (newline-delimited JSON, as the MCP stdio transport requires). No MCP
 * SDK dependency: `node:child_process` + `node:stream` do the work.
 *
 * Security properties:
 *  - The child env is filtered to a small allowlist, so the worker's
 *    `CONVEX_SERVICE_TOKEN` / `PROVIDER_ENCRYPTION_KEY` never enter the
 *    MCP process.
 *  - Per-request timeout; a hung server is killed, never awaited.
 *  - Results are truncated to `maxResultChars` before they reach the
 *    caller, and errors are masked before they are stored.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { maskStringSecrets } from "@/governance/tools";

/** Only these env vars may cross into an MCP child process. */
const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "HOMEDRIVE",
  "HOMEPATH",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PUBLIC",
  "WINDIR",
  "ALLUSERSPROFILE",
] as const;

/**
 * Build the child env. Never forward the whole `process.env` — the
 * worker holds the Convex service token and the provider encryption
 * key, and an MCP server (or a malicious config) must not see them.
 */
export function buildChildEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    // Extra vars are user-supplied config (e.g. a proxy). They must not
    // re-introduce worker secrets.
    if (/(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";
  private closed = false;
  private closing = false;

  private constructor(
    readonly command: string,
    readonly args: string[],
    readonly cwd: string,
    readonly timeoutMs: number,
    readonly maxResultChars: number,
    private readonly onStderr: (chunk: string) => void = () => undefined
  ) {}

  static start(options: {
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    maxResultChars: number;
    onStderr?: (chunk: string) => void;
  }): McpClient {
    return new McpClient(
      options.command,
      options.args,
      options.cwd,
      options.timeoutMs,
      options.maxResultChars,
      options.onStderr
    );
  }

  private spawnChild(): void {
    if (this.child || this.closed) return;
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: buildChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleChunk(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.onStderr(chunk.slice(0, 2_000)));

    child.on("exit", (code) => {
      this.failAll(new Error(`MCP server exited (code ${code ?? "null"})`));
    });
    child.on("error", (error) => {
      this.failAll(error);
    });
  }

  private failAll(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private handleChunk(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      // A non-JSON line is not a protocol message; drop it.
      return;
    }
    if (message.id === null || message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message || "MCP request failed"));
      return;
    }
    pending.resolve(message.result);
  }

  /**
   * Send a request with no response expected (MCP notification). Used for
   * `notifications/initialized`, which the protocol says must not be
   * answered.
   */
  notify(method: string, params?: unknown): void {
    if (this.closed || !this.child) return;
    const payload = { jsonrpc: "2.0", method, params };
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // The child is gone; the next request will surface the error.
    }
  }

  async request<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) throw new Error("MCP client is closed");
    if (signal?.aborted) throw new Error("MCP request aborted");
    this.spawnChild();
    const id = this.nextId;
    this.nextId += 1;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A timed-out request means the child is wedged: kill it so the
        // registry can retry with a fresh process.
        this.kill();
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.timeoutMs);
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        this.kill();
        reject(new Error("MCP request aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value as T);
        },
        reject: (reason) => {
          signal?.removeEventListener("abort", onAbort);
          reject(reason);
        },
        timer,
      });
      try {
        this.child?.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      }
    });
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.closing = false;
    this.failAll(new Error("MCP client disposed"));
    this.kill();
  }

  /** True when the process is no longer usable. */
  get isClosed(): boolean {
    return this.closed || (this.child !== null && this.child.exitCode !== null);
  }

  /** Test hook: number of in-flight requests. */
  get pendingCount(): number {
    return this.pending.size;
  }

  get closingState(): boolean {
    return this.closing;
  }
}

/** Flatten an MCP `tools/call` result into text, capped at `maxResultChars`. */
export function flattenToolResult(result: unknown, maxResultChars: number): {
  text: string;
  isError: boolean;
} {
  let text = "";
  let isError = false;
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    isError = record.isError === true;
    const content = record.content;
    if (Array.isArray(content)) {
      text = content
        .map((part) => {
          if (part && typeof part === "object") {
            const partRecord = part as Record<string, unknown>;
            if (typeof partRecord.text === "string") return partRecord.text;
            if (partRecord.type === "text") return String(partRecord.text ?? "");
          }
          return "";
        })
        .join("\n");
    } else if (typeof content === "string") {
      text = content;
    } else {
      text = JSON.stringify(result);
    }
  } else {
    text = String(result ?? "");
  }
  if (text.length > maxResultChars) {
    text = `${text.slice(0, maxResultChars)}\n[truncated: ${text.length - maxResultChars} chars]`;
  }
  return { text, isError };
}

export function maskMcpError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return maskStringSecrets(message).slice(0, 1_000);
}
