/**
 * Plan 009: MCP server registry (shared connection manager).
 *
 * One `McpClient` per `${serverId}:${workspaceRoot}`, shared across
 * agents and tasks on the same workspace. Connects are lazy — a server
 * is only spawned the first time a task actually needs its tools
 * (`ensure` is called by the runner per task, so a `/mcp` config with
 * no running task costs nothing). `autoConnect` pre-warms the process
 * at task start.
 *
 * Concurrency: a session is shared, so callbacks (`onEvent` /
 * `onStatus`) are passed PER CALL, never stored on the session — two
 * tasks on the same workspace must not route each other's events.
 *
 * The registry never throws: a dead server yields an empty tool list +
 * a `mcp.server_error` event, and the subtask continues on the existing
 * path.
 */

import { McpClient, flattenToolResult, maskMcpError } from "./client";
import {
  authorizeToolCall,
  filterToolsForAgent,
  isForbiddenRoot,
  type AgentScope,
} from "./permissions";
import { mcpRoleAllowed } from "@/api/convex/lib/mcpPresets";
import { redactSecrets, resolveMcpSpawn } from "./spawn";
import type { McpCallResult, McpEventFn, McpServerConfig, McpToolDefinition } from "./types";

/** A 4 KB path is never legitimate; args above this are refused before spawn. */
const MAX_ARGS_CHARS = 16_000;

export type McpServerStatus = "connected" | "disconnected" | "error";

export type McpStatusFn = (
  serverId: string,
  status: McpServerStatus,
  errorMessage?: string
) => Promise<void> | void;

export interface McpHooks {
  onEvent?: McpEventFn;
  onStatus?: McpStatusFn;
}

/** The MCP tool provider one task run hands its executors. */
export interface McpRunConfig {
  sessions: McpSession[];
  writeTools: boolean;
  maxIterations: number;
}

export interface McpSession {
  serverId: string;
  serverName: string;
  workspaceRoot: string;
  allowedRoots: string[];
  config: McpServerConfig;
  client: McpClient | null;
  tools: McpToolDefinition[];
  status: McpServerStatus;
  errorMessage?: string;
}

export interface McpRegistryOptions {
  timeoutMs: number;
  maxResultChars: number;
}

interface SessionEntry extends McpSession {
  connecting: Promise<McpSession> | null;
  stderr: string;
  /** Decrypted env values, kept only to redact them from reported errors. */
  secretValues: string[];
}

/** Whether an agent's role may use a server (its `agentRoles` allowlist). */
export function sessionAllowedForRole(session: Pick<McpSession, "config">, role: string | undefined): boolean {
  return mcpRoleAllowed(session.config.agentRoles, role);
}

function toolPolicy(config: McpServerConfig) {
  return { preset: config.preset, toolAllowlist: config.toolAllowlist };
}

function buildAllowedRoots(workspaceRoot: string, allowedDirectories?: string[]): string[] {
  const roots: string[] = [];
  const add = (candidate: string | undefined) => {
    if (!candidate || !candidate.trim()) return;
    const trimmed = candidate.trim();
    if (isForbiddenRoot(trimmed)) return;
    if (!roots.includes(trimmed)) roots.push(trimmed);
  };
  add(workspaceRoot);
  // Only absolute extra roots are honoured; a relative entry would be
  // resolved against the MCP child's cwd, which is not the workspace.
  for (const directory of allowedDirectories ?? []) {
    if (directory.startsWith("/")) add(directory);
  }
  return roots;
}

export class McpRegistry {
  private readonly sessions = new Map<string, SessionEntry>();
  private options: McpRegistryOptions = { timeoutMs: 30_000, maxResultChars: 8_000 };

  /**
   * Record (or refresh) the configs for a task's workspace. Call once per
   * task after the workspace exists. Idempotent: safe to call again for
   * the same workspace with updated configs. Only `local` servers with a
   * `command` are launched here; remote configs are stored and labelled.
   */
  ensure(configs: McpServerConfig[], workspaceRoot: string, options: McpRegistryOptions, hooks?: McpHooks): McpSession[] {
    this.options = options;
    const result: McpSession[] = [];
    for (const config of configs) {
      if (!config.command) continue;
      const key = `${config._id}:${workspaceRoot}`;
      const existing = this.sessions.get(key);
      if (existing) {
        existing.config = config;
        existing.allowedRoots = buildAllowedRoots(workspaceRoot, config.allowedDirectories);
        result.push(existing);
        continue;
      }
      const entry: SessionEntry = {
        serverId: config._id,
        serverName: config.name,
        workspaceRoot,
        allowedRoots: buildAllowedRoots(workspaceRoot, config.allowedDirectories),
        config,
        client: null,
        tools: [],
        status: "disconnected",
        connecting: null,
        stderr: "",
        secretValues: [],
      };
      this.sessions.set(key, entry);
      result.push(entry);
      if (config.autoConnect) {
        void this.connect(entry, hooks).catch(() => undefined);
      }
    }
    return result;
  }

  private async connect(entry: McpSession, hooks?: McpHooks): Promise<McpSession> {
    const session = entry as SessionEntry;
    if (entry.client && entry.status === "connected") return entry;
    if (session.connecting) return session.connecting;
    session.connecting = this.doConnect(session, hooks).finally(() => {
      session.connecting = null;
    });
    return session.connecting;
  }

  private async doConnect(entry: SessionEntry, hooks?: McpHooks): Promise<McpSession> {
    let spawnSpec: Awaited<ReturnType<typeof resolveMcpSpawn>>;
    try {
      // Decrypts the row's env (worker PROVIDER_ENCRYPTION_KEY) and fills
      // {workspace} / {env:KEY}; a missing key or bad ciphertext is a
      // server error, never a spawn without credentials.
      spawnSpec = await resolveMcpSpawn(entry.config, entry.workspaceRoot);
    } catch (error) {
      entry.status = "error";
      entry.errorMessage = maskMcpError(error);
      await this.reportStatus(entry, hooks);
      return entry;
    }
    const { command, args, env, secretValues } = spawnSpec;
    entry.secretValues = secretValues;
    const client = McpClient.start({
      command,
      args,
      env,
      cwd: entry.workspaceRoot,
      timeoutMs: this.options.timeoutMs,
      maxResultChars: this.options.maxResultChars,
      onStderr: (chunk) => {
        entry.stderr = (entry.stderr + chunk).slice(-4_000);
      },
    });
    try {
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "fhara-worker", version: "1.0.0" },
      });
      client.notify("notifications/initialized", {});
      const listed = await client.request<{ tools?: unknown }>("tools/list");
      const tools: McpToolDefinition[] = [];
      if (listed && Array.isArray(listed.tools)) {
        for (const raw of listed.tools as Array<Record<string, unknown>>) {
          if (typeof raw?.name === "string") {
            tools.push({
              name: raw.name,
              description: typeof raw.description === "string" ? raw.description : "",
              inputSchema:
                raw.inputSchema && typeof raw.inputSchema === "object"
                  ? (raw.inputSchema as Record<string, unknown>)
                  : {},
            });
          }
        }
      }
      entry.client = client;
      entry.tools = tools;
      entry.status = "connected";
      entry.errorMessage = undefined;
      await this.reportStatus(entry, hooks);
      return entry;
    } catch (error) {
      entry.status = "error";
      entry.errorMessage = redactSecrets(maskMcpError(error) || entry.stderr.slice(0, 500), entry.secretValues);
      await client.dispose().catch(() => undefined);
      await this.reportStatus(entry, hooks);
      await this.emit("mcp.server_error", entry, hooks, {
        agentId: "",
        tool: "",
        action: "",
        durationMs: 0,
        error: entry.errorMessage,
      });
      return entry;
    }
  }

  /** Tools an agent may call right now (lazily connecting). Never throws. */
  async toolsFor(entry: McpSession, scope: AgentScope, hooks?: McpHooks): Promise<McpToolDefinition[]> {
    // Role allowlist first: a server this role may not use is never spawned
    // on its behalf.
    if (!sessionAllowedForRole(entry, scope.role)) return [];
    const session = await this.safeConnect(entry, hooks);
    if (session.status !== "connected") return [];
    return filterToolsForAgent(session.tools, scope, toolPolicy(session.config));
  }

  /**
   * Execute one authorized tool call. Never throws. Every outcome emits
   * an event carrying the caller context (agentId comes from the call,
   * never from stored state).
   */
  async callTool(
    entry: McpSession,
    scope: AgentScope,
    tool: string,
    args: Record<string, unknown>,
    agentId: string,
    signal?: AbortSignal,
    hooks?: McpHooks
  ): Promise<McpCallResult> {
    const started = Date.now();
    const base = {
      agentId,
      serverId: entry.serverId,
      serverName: entry.serverName,
      tool,
      action: "",
      durationMs: 0,
      workspace: entry.workspaceRoot,
    };

    if (!sessionAllowedForRole(entry, scope.role)) {
      const error = "mcp-role-denied";
      await this.emit("mcp.tool_denied", entry, hooks, { ...base, durationMs: Date.now() - started, error });
      return { ok: false, text: `Tool call refused: ${error}.`, isError: true, error };
    }

    const session = await this.safeConnect(entry, hooks);
    if (session.status !== "connected" || !session.client) {
      const error = session.errorMessage ?? "MCP server unavailable";
      await this.emit("mcp.tool_error", entry, hooks, { ...base, durationMs: Date.now() - started, error });
      return { ok: false, text: `MCP server unavailable: ${error}`, isError: true, error };
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(args ?? {});
    } catch {
      const error = "mcp-args-invalid";
      await this.emit("mcp.tool_denied", entry, hooks, { ...base, durationMs: Date.now() - started, error });
      return { ok: false, text: `Tool arguments are not serializable. (${error})`, isError: true, error };
    }
    if (serialized.length > MAX_ARGS_CHARS) {
      const error = "mcp-args-too-large";
      await this.emit("mcp.tool_denied", entry, hooks, { ...base, durationMs: Date.now() - started, error });
      return { ok: false, text: `Tool arguments exceed ${MAX_ARGS_CHARS} chars.`, isError: true, error };
    }

    const authorized = await authorizeToolCall({
      tool,
      args: args ?? {},
      scope,
      allowedRoots: session.allowedRoots,
      policy: toolPolicy(session.config),
    });
    if (!authorized.ok) {
      await this.emit("mcp.tool_denied", entry, hooks, {
        ...base,
        action: authorized.reason,
        durationMs: Date.now() - started,
        error: authorized.reason,
      });
      return {
        ok: false,
        text: `Tool call refused: ${authorized.reason}.`,
        isError: true,
        error: authorized.reason,
      };
    }

    try {
      const raw = await session.client.request(
        "tools/call",
        { name: tool, arguments: args ?? {} },
        signal
      );
      const { text, isError } = flattenToolResult(raw, this.options.maxResultChars);
      const maskedText = redactSecrets(maskMcpError(text), (session as SessionEntry).secretValues ?? []);
      await this.emit(isError ? "mcp.tool_error" : "mcp.tool_call", entry, hooks, {
        ...base,
        action: authorized.action,
        durationMs: Date.now() - started,
        error: isError ? maskedText.slice(0, 500) : undefined,
      });
      return {
        ok: !isError,
        text: maskedText,
        isError,
        error: isError ? maskedText.slice(0, 500) : undefined,
      };
    } catch (error) {
      const message = redactSecrets(maskMcpError(error), (session as SessionEntry).secretValues ?? []);
      await this.emit("mcp.tool_error", entry, hooks, {
        ...base,
        action: authorized.action,
        durationMs: Date.now() - started,
        error: message,
      });
      return { ok: false, text: `MCP tool call failed: ${message}`, isError: true, error: message };
    }
  }

  async status(): Promise<Array<{ serverId: string; status: McpServerStatus; errorMessage?: string }>> {
    return [...this.sessions.values()].map((s) => ({
      serverId: s.serverId,
      status: s.status,
      errorMessage: s.errorMessage,
    }));
  }

  private async safeConnect(entry: McpSession, hooks?: McpHooks): Promise<McpSession> {
    try {
      return await this.connect(entry, hooks);
    } catch {
      return entry;
    }
  }

  private async reportStatus(entry: McpSession, hooks?: McpHooks): Promise<void> {
    const onStatus = hooks?.onStatus;
    if (!onStatus) return;
    try {
      await onStatus(entry.serverId, entry.status, entry.errorMessage);
    } catch {
      // Status reports are best-effort; a failed report never fails the task.
    }
  }

  private async emit(
    type: string,
    entry: McpSession,
    hooks: McpHooks | undefined,
    payload: Omit<Parameters<McpEventFn>[1], "serverId" | "serverName" | "workspace">
  ): Promise<void> {
    const onEvent = hooks?.onEvent;
    if (!onEvent) return;
    try {
      await onEvent(type, {
        ...payload,
        serverId: entry.serverId,
        serverName: entry.serverName,
        workspace: entry.workspaceRoot,
      });
    } catch {
      // Observability must never break execution.
    }
  }

  /** Kill every child process. Called at worker shutdown. */
  async disposeAll(): Promise<void> {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      entries.map(async (entry) => entry.client?.dispose().catch(() => undefined) ?? undefined)
    );
  }
}

let singleton: McpRegistry | null = null;

export function getMcpRegistry(): McpRegistry {
  if (!singleton) singleton = new McpRegistry();
  return singleton;
}
