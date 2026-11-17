import { wenv } from "@fhara/config/worker";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner";
import * as AcpClient from "effect-acp/client";
import * as AcpError from "effect-acp/errors";

import { buildChildEnv } from "@/api/convex/lib/childEnv";
import type { EventSink } from "@/types/events";
import { resolveSandboxPath } from "@/tools/sandbox";
import { killTree, type NativeRunResult, type SpawnOptions } from "./nativeProvider";
import { evaluateOpencodeRule, type OpencodePolicy } from "./opencodePolicy";

/**
 * ACP runtime (plan 058 step 3): executes a subtask through an Agent Client
 * Protocol agent (e.g. `claude-code-acp`) speaking JSON-RPC over stdio,
 * running its own tools and credentials inside the task workspace. Study
 * source: upstream t3code (D:/CODE/t3code) — `docs/user/providers-acp.md`,
 * `docs/internals/adding-a-provider.md`, and `effect-acp`'s own client test,
 * NOT the FharaV2 fork's orchestration adapter.
 *
 * Like the OpenCode runtime, sessions are per-call processes — no long-lived
 * session id. The process boundary plus the handlers below are the safety
 * model:
 *  - `session/request_permission`: Fhara's deny-by-default policy decides
 *    every request; the agent's own option id is selected unchanged
 *    (upstream rule: pass option ids through, never fabricate one). When no
 *    matching option exists the response is `cancelled`, the protocol's
 *    decline-without-selection path.
 *  - `fs/read_text_file` / `fs/write_text_file`: the client executes the
 *    file operation, so every path goes through `resolveSandboxPath` and the
 *    same read/edit rule maps OpenCode uses; writes only for mutating
 *    subtasks. Violations fail the request (the agent sees a tool error)
 *    and log `agent.permission_denied`.
 *  - terminal and MCP requests are never handled: the client advertises no
 *    such capability and unhandled requests fail closed at the protocol
 *    layer.
 *
 * Usage/events map onto the native-provider vocabulary (`native.run.started`,
 * `native.tool`, `native.run.finished`) so downstream consumers stay uniform.
 */

export function acpCommand(env?: Record<string, string | undefined>): string {
  return wenv("ORCHESTRATOR_ACP_COMMAND", env);
}

/**
 * Literal argv for the ACP command, from ORCHESTRATOR_ACP_ARGS as a JSON
 * array (upstream "Local ACP command" parity: one literal argument per
 * entry, never parsed through a shell). Anything that is not a JSON array
 * of strings means "no arguments".
 */
export function acpArgs(env?: Record<string, string | undefined>): string[] {
  const raw = wenv("ORCHESTRATOR_ACP_ARGS", env);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

// Launchability is checked once per process per command, like the OpenCode probe.
const acpAvailabilityCache = new Map<string, Promise<boolean>>();

export function resetAcpAvailabilityCache(): void {
  acpAvailabilityCache.clear();
}

/**
 * Probe whether the ACP command is launchable at all: a spawn error (ENOENT)
 * or an immediate non-zero exit means no; a process that is still alive (or
 * exited cleanly) within the 3s window means yes. The agent is started with
 * an open, never-written stdin so an ACP agent waiting for the protocol does
 * not exit early.
 */
function probeAcpCommand(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let child: import("node:child_process").ChildProcess;
    try {
      child = spawn(command, args, {
        env: buildChildEnv(),
        windowsHide: true,
        shell: process.platform === "win32",
        stdio: ["pipe", "ignore", "ignore"],
      });
    } catch {
      resolve(false);
      return;
    }
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (!child.killed) child.kill();
      } catch {}
      resolve(ok);
    };
    child.on("error", () => finish(false));
    child.on("close", (code) => {
      if (!done && code !== 0 && code !== null) finish(false);
    });
    const timer = setTimeout(() => finish(true), 3_000);
  });
}

export function isAcpAvailable(command = acpCommand(), args = acpArgs()): Promise<boolean> {
  const cached = acpAvailabilityCache.get(`${command} ${args.join(" ")}`);
  if (cached) return cached;
  const probe = probeAcpCommand(command, args);
  acpAvailabilityCache.set(`${command} ${args.join(" ")}`, probe);
  return probe;
}

// ── policy mapping (pure, unit-tested) ────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Short operation target from a permission subject: never full payloads. */
export function acpPermissionTarget(subject: Record<string, unknown> | undefined): string | undefined {
  if (!subject) return undefined;
  if (subject.type === "command" && typeof subject.command === "string") {
    return subject.command.slice(0, 200);
  }
  if (subject.type === "tool_call") {
    const tool = asRecord(subject.toolCall);
    const locations = Array.isArray(tool?.locations) ? tool?.locations : [];
    for (const location of locations) {
      const p = asRecord(location)?.path;
      if (typeof p === "string") return p.slice(0, 200);
    }
    const input = asRecord(tool?.rawInput);
    const raw = input?.filePath ?? input?.path ?? input?.command ?? input?.pattern ?? input?.url;
    if (typeof raw === "string") return raw.slice(0, 200);
    if (typeof tool?.title === "string") return tool.title.slice(0, 200);
  }
  return undefined;
}

function extractCommandFromToolCall(tool: Record<string, unknown>): string | undefined {
  const input = asRecord(tool.rawInput);
  const raw = input?.command ?? tool.command;
  if (typeof raw === "string" && raw.trim()) return raw.slice(0, 200);
  const title = typeof tool.title === "string" ? tool.title : "";
  return title ? title.slice(0, 200) : undefined;
}

/**
 * Fhara's deny-by-default verdict for one ACP permission request. `allow`
 * is only ever returned for operations the same policy grants through
 * OpenCode: in-worktree reads, in-scope edits for mutating runs, bash
 * allowlist commands, and web fetches for web-enabled roles.
 */
export function acpDispositionForRequest(
  policy: OpencodePolicy,
  subject: unknown,
  options: { mutating: boolean; workspaceRoot: string }
): { disposition: "allow" | "deny"; reason?: string } {
  const s = asRecord(subject);
  if (!s) return { disposition: "deny", reason: "permission request has no subject" };
  const rule = (map: Record<string, "allow" | "deny" | "ask">, value: string) => {
    // Rule maps are worktree-relative. ACP sends absolute paths; relative
    // values (and shell commands) are agent-cwd-relative, so resolve them
    // against the workspace root, not the worker's process cwd.
    const resolved = path.isAbsolute(value)
      ? path.resolve(value)
      : path.resolve(options.workspaceRoot, value);
    const root = path.resolve(options.workspaceRoot);
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return "deny" as const;
    return evaluateOpencodeRule(map, rel.split(path.sep).join("/"));
  };
  if (s.type === "command") {
    const command = typeof s.command === "string" ? s.command : "";
    if (!command) return { disposition: "deny", reason: "command subject without a command" };
    return rule(policy.bash, command) === "allow"
      ? { disposition: "allow" }
      : { disposition: "deny", reason: `policy denies command: ${command.slice(0, 100)}` };
  }
  if (s.type === "tool_call") {
    const tool = asRecord(s.toolCall) ?? {};
    const kind = typeof tool.kind === "string" ? tool.kind : "other";
    const target = acpPermissionTarget(s);
    switch (kind) {
      case "read":
      case "search": {
        // Reads are allowed anywhere in the worktree; no path means an
        // in-cwd search, which the read policy already covers.
        if (!target) return { disposition: "allow" };
        return rule(policy.read, target) === "allow"
          ? { disposition: "allow" }
          : { disposition: "deny", reason: `policy denies read: ${target}` };
      }
      case "edit":
      case "delete":
      case "move": {
        if (!options.mutating) {
          return { disposition: "deny", reason: `read-only subtask: ${kind} denied` };
        }
        if (!target) return { disposition: "deny", reason: `${kind} request without a path` };
        return rule(policy.edit, target) === "allow"
          ? { disposition: "allow" }
          : { disposition: "deny", reason: `policy denies edit: ${target}` };
      }
      case "execute": {
        const command = extractCommandFromToolCall(tool);
        if (!command) return { disposition: "deny", reason: "execute request without a command" };
        return rule(policy.bash, command) === "allow"
          ? { disposition: "allow" }
          : { disposition: "deny", reason: `policy denies command: ${command.slice(0, 100)}` };
      }
      case "fetch": {
        return policy.webfetch === "allow"
          ? { disposition: "allow" }
          : { disposition: "deny", reason: "policy denies web fetch" };
      }
      case "think": {
        return { disposition: "allow" };
      }
      default: {
        return {
          disposition: "deny",
          reason: `policy denies tool kind "${kind}"${target ? `: ${target}` : ""}`,
        };
      }
    }
  }
  return { disposition: "deny", reason: `unknown permission subject type "${String(s.type)}"` };
}

/**
 * Pick the agent's own option for a verdict — never a fabricated id.
 * Upstream rule: every request must be declinable; when the agent offers no
 * matching option the answer is `cancelled`.
 */
export function acpOutcomeForDisposition<T>(
  options: ReadonlyArray<{ optionId: T; kind?: unknown }>,
  disposition: "allow" | "deny"
): { outcome: "cancelled" } | { outcome: "selected"; optionId: T } {
  const wanted = disposition === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of wanted) {
    const option = options.find((o) => o.kind === kind);
    if (option) return { outcome: "selected", optionId: option.optionId };
  }
  return { outcome: "cancelled" };
}

/**
 * Sandbox + policy check for one fs request path. ACP sends absolute paths;
 * containment against the workspace root is verified first, then the same
 * relative path is re-validated through `resolveSandboxPath` like every
 * other Fhara file tool.
 */
export function acpPathAllowed(
  policy: OpencodePolicy,
  map: "read" | "edit",
  requestPath: string,
  workspaceRoot: string
): { ok: boolean; rel?: string; reason?: string } {
  // ACP sends absolute paths; a relative value is agent-cwd-relative.
  const resolved = path.isAbsolute(requestPath)
    ? path.resolve(requestPath)
    : path.resolve(workspaceRoot, requestPath);
  const root = path.resolve(workspaceRoot);
  const relRaw = path.relative(root, resolved);
  if (relRaw.startsWith("..") || path.isAbsolute(relRaw)) {
    return { ok: false, reason: `Path escapes workspace: "${requestPath}"` };
  }
  const rel = relRaw.split(path.sep).join("/");
  try {
    resolveSandboxPath(root, rel);
  } catch (error) {
    return {
      ok: false,
      rel,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const rules = map === "read" ? policy.read : policy.edit;
  return evaluateOpencodeRule(rules, rel) === "allow"
    ? { ok: true, rel }
    : { ok: false, rel, reason: `Policy denies ${map}: ${rel}` };
}

// ── run ───────────────────────────────────────────────────────────────

export interface AcpRunInput {
  workspacePath: string;
  prompt: string;
  command?: string;
  /** Literal argv for the command (ORCHESTRATOR_ACP_ARGS); never shell-parsed. */
  args?: string[];
  /** Per-run permissions (buildOpencodePolicy); read-only when omitted. */
  policy?: OpencodePolicy;
  /** Whether the subtask may mutate the workspace (code_change/shell). */
  mutating?: boolean;
  /** Hard wall-clock limit; default ORCHESTRATOR_NATIVE_TIMEOUT_MS or 10 min. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: EventSink;
  onChunk?: (delta: string) => Promise<void>;
  onMessage?: (text: string) => Promise<void>;
}

// The transport reads these streams with a PlatformError channel; node
// stream failures map onto the normalized SystemError shape.
const streamFailed = (method: string) =>
  new PlatformError.PlatformError(
    new PlatformError.SystemError({
      _tag: "Unknown",
      module: "ChildProcess",
      method,
      description: "stdio stream failed",
    })
  );

/**
 * Node-side spawn result wrapped as the effect ChildProcessHandle that
 * effect-acp's layerChildProcess expects. Only the fields makeChildStdio and
 * makeTerminationError read are populated; stdin write errors resolve
 * silently because a dead child is reported through the transport.
 */
function buildHandle(
  child: import("node:child_process").ChildProcess,
  kill: () => void
): import("effect/process/ChildProcessSpawner").ChildProcessHandle {
  let exit = { code: null as number | null, signal: null as string | null };
  child.on("close", (code, signal) => {
    exit = { code, signal };
  });
  const stdoutStream = child.stdout
    ? Stream.mapError(
        Stream.fromAsyncIterable(child.stdout as unknown as AsyncIterable<Uint8Array>, () => streamFailed("stdout")),
        () => streamFailed("stdout")
      )
    : Stream.empty;
  const stderrStream = child.stderr
    ? Stream.mapError(
        Stream.fromAsyncIterable(child.stderr as unknown as AsyncIterable<Uint8Array>, () => streamFailed("stderr")),
        () => streamFailed("stderr")
      )
    : Stream.empty;
  return makeHandle({
    pid: ProcessId(child.pid ?? 0),
    exitCode: Effect.suspend(() =>
      Effect.succeed(ExitCode(exit.code ?? (exit.signal ? 130 : 0)))
    ) as Effect.Effect<ExitCode, never>,
    isRunning: Effect.succeed(child.exitCode === null),
    kill: () =>
      Effect.sync(() => {
        kill();
      }),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.forEach((chunk: Uint8Array) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            child.stdin?.write(Buffer.from(chunk), () => resolve());
          })
      )
    ),
    stdout: stdoutStream,
    stderr: stderrStream,
    all: stdoutStream,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

export interface AcpRunOutcome {
  sessionId?: string;
  stopReason?: string;
  protocolVersion: number;
}

export async function runAcpProvider(input: AcpRunInput): Promise<NativeRunResult> {
  const command = input.command ?? acpCommand();
  const timeoutMs = input.timeoutMs ?? wenv("ORCHESTRATOR_NATIVE_TIMEOUT_MS");
  const policy = input.policy;
  const mutating = input.mutating ?? false;

  await input.onEvent?.(
    "native.run.started",
    { provider: command, cwd: input.workspacePath, runtime: "acp", mutating, timeoutMs },
    "info",
  );

  let child: import("node:child_process").ChildProcess;
  try {
    child = spawn(command, input.args ?? [], {
      cwd: input.workspacePath,
      env: buildChildEnv({ PWD: input.workspacePath }),
      shell: process.platform === "win32",
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    await input.onEvent?.(
      "native.runtime.unavailable",
      { provider: command, runtime: "acp", reason: error instanceof Error ? error.message : String(error) },
      "warn",
    );
    return {
      status: "failed",
      output: `ACP agent failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  // Timeout + external abort kill the whole process tree; the transport
  // turns the dead process into a failed prompt.
  let timedOut = false;
  let cancelled = false;
  const kill = () => killTree(child);
  const onOuterAbort = () => {
    cancelled = true;
    kill();
  };
  if (input.signal?.aborted) {
    cancelled = true;
    kill();
  } else {
    input.signal?.addEventListener("abort", onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);

  // Ordered event/text emission: session updates arrive on the transport
  // fiber; a chain keeps chunk order stable like the OpenCode feeder.
  let chain = Promise.resolve();
  const enqueue = (fn: () => Promise<void>) => {
    chain = chain.then(fn).catch(() => {});
  };
  const emit = (type: string, payload: Record<string, unknown>, level?: "info" | "warn" | "error") => {
    enqueue(async () => {
      await input.onEvent?.(type, payload, level ?? "info");
    });
  };

  const texts: string[] = [];
  const handle = buildHandle(child, kill);
  const startedAt = Date.now();
  let usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  } = { inputTokens: 0, outputTokens: 0 };
  let stopReason: string | undefined;

  const layer = AcpClient.layerChildProcess(handle, { onTermination: () => Effect.void });

  const outcome = Effect.gen(function* () {
    const acp = yield* AcpClient.AcpClient;

    yield* acp.handleSessionUpdate((notification) => {
      const update = asRecord(notification.update);
      const kind = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : "";
      if (kind === "agent_message_chunk") {
        // v1 passes a single content block through; v2 uses an array.
        const blocks = Array.isArray(update?.content) ? update.content : [update?.content];
        for (const block of blocks) {
          const b = asRecord(block);
          const text = typeof b?.text === "string" ? b.text : undefined;
          if (b?.type === "text" && text) {
            texts.push(text);
            enqueue(async () => {
              await input.onChunk?.(text);
            });
          }
        }
        return Effect.void;
      }
      if (kind === "tool_call" || kind === "tool_call_update") {
        const tool = asRecord(update) ?? {};
        const status = typeof tool.status === "string" ? tool.status : "unknown";
        const target = acpPermissionTarget({ type: "tool_call", toolCall: tool });
        emit(
          "native.tool",
          {
            provider: command,
            tool: typeof tool.name === "string" ? tool.name : "unknown",
            status,
            ...(typeof tool.title === "string" ? { title: tool.title.slice(0, 200) } : {}),
            ...(target ? { target: target.slice(0, 200) } : {}),
          },
          status === "failed" ? "warn" : "info",
        );
        return Effect.void;
      }
      if (kind === "state_update" && update?.state === "idle") {
        const u = asRecord(update.usage);
        if (u) {
          const num = (value: unknown) => {
            const n = Number(value ?? 0);
            return Number.isFinite(n) ? n : 0;
          };
          usage = {
            inputTokens: usage.inputTokens + num(u.inputTokens),
            outputTokens: usage.outputTokens + num(u.outputTokens),
            ...(u.cachedReadTokens !== undefined && u.cachedReadTokens !== null
              ? { cachedInputTokens: num(u.cachedReadTokens) }
              : {}),
            ...(u.cachedWriteTokens !== undefined && u.cachedWriteTokens !== null
              ? { cacheWriteTokens: num(u.cachedWriteTokens) }
              : {}),
            ...(u.thoughtTokens !== undefined && u.thoughtTokens !== null
              ? { reasoningTokens: num(u.thoughtTokens) }
              : {}),
          };
        }
        if (typeof update.stopReason === "string") stopReason = update.stopReason;
        return Effect.void;
      }
      return Effect.void;
    });

    yield* acp.handleRequestPermission((request) => {
      const verdict = acpDispositionForRequest(policy ?? readOnlyAcpPolicy(), request.subject, {
        mutating,
        workspaceRoot: input.workspacePath,
      });
      const result = acpOutcomeForDisposition(request.options, verdict.disposition);
      if (verdict.disposition === "deny" || result.outcome === "cancelled") {
        const target = acpPermissionTarget(asRecord(request.subject));
        emit(
          "agent.permission_denied",
          {
            provider: command,
            action: request.title ?? "permission",
            ...(target ? { target: target.slice(0, 200) } : {}),
            reason: verdict.reason ?? "no decline option offered by the agent",
          },
          "warn",
        );
      }
      return Effect.succeed({ outcome: result });
    });

    yield* acp.handleReadTextFile((request) =>
      Effect.flatMap(
        Effect.try({
          try: () => {
            const check = acpPathAllowed(policy ?? readOnlyAcpPolicy(), "read", request.path, input.workspacePath);
            if (!check.ok || !check.rel) throw new Error(check.reason ?? `Policy denies read: ${request.path}`);
            return check.rel;
          },
          catch: (cause) => {
            const message = cause instanceof Error ? cause.message : String(cause);
            emit(
              "agent.permission_denied",
              { provider: command, action: "fs/read_text_file", reason: message.slice(0, 300) },
              "warn",
            );
            return AcpError.AcpRequestError.invalidParams(message.slice(0, 300));
          },
        }),
        (rel) =>
          Effect.map(
            Effect.tryPromise({
              try: async () => {
                // line is 0-based per the ACP spec; limit caps the line count.
                const raw = await fs.readFile(path.resolve(input.workspacePath, rel), "utf-8");
                const lines = raw.split("\n");
                const start = Math.max(0, Number(request.line ?? 0));
                const limit = request.limit ?? null;
                const slice = limit !== null ? lines.slice(start, start + Number(limit)) : lines.slice(start);
                emit(
                  "native.tool",
                  { provider: command, tool: "fs.read_text_file", status: "completed", target: rel.slice(0, 200) },
                );
                return slice.join("\n");
              },
              catch: (cause) =>
                AcpError.AcpRequestError.internalError(
                  cause instanceof Error ? cause.message : String(cause),
                ),
            }),
            (content) => ({ content }),
          )
      )
    );

    if (mutating) {
      yield* acp.handleWriteTextFile((request) =>
        Effect.flatMap(
          Effect.try({
            try: () => {
              const check = acpPathAllowed(policy ?? readOnlyAcpPolicy(), "edit", request.path, input.workspacePath);
              if (!check.ok || !check.rel) throw new Error(check.reason ?? `Policy denies edit: ${request.path}`);
              return check.rel;
            },
            catch: (cause) => {
              const message = cause instanceof Error ? cause.message : String(cause);
              emit(
                "agent.permission_denied",
                { provider: command, action: "fs/write_text_file", reason: message.slice(0, 300) },
                "warn",
              );
              return AcpError.AcpRequestError.invalidParams(message.slice(0, 300));
            },
          }),
          (rel) =>
            Effect.map(
              Effect.tryPromise({
                try: async () => {
                  const abs = path.resolve(input.workspacePath, rel);
                  await fs.mkdir(path.dirname(abs), { recursive: true });
                  await fs.writeFile(abs, request.content, { encoding: "utf-8", mode: 0o600 });
                  emit(
                    "native.tool",
                    { provider: command, tool: "fs.write_text_file", status: "completed", target: rel.slice(0, 200) },
                  );
                  return {};
                },
                catch: (cause) =>
                  AcpError.AcpRequestError.internalError(
                    cause instanceof Error ? cause.message : String(cause),
                  ),
              }),
              () => ({}),
            )
        )
      );
    }

    yield* acp.handleElicitation(() =>
      // Fhara never answers agent elicitation forms; declining is the
      // protocol-honoring response (upstream rule).
      Effect.succeed({ action: "decline" as const, content: {} })
    );

    const init = yield* acp.agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: mutating },
        terminal: false,
        elicitation: { form: {} },
      },
      clientInfo: { name: "fhara", version: "0.0.0" },
    });
    const initRecord = asRecord(init);
    const protocolVersion =
      typeof initRecord?.protocolVersion === "number" ? initRecord.protocolVersion : 1;

    const session = yield* acp.agent.createSession({ cwd: input.workspacePath, mcpServers: [] });
    yield* acp.agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: input.prompt }],
    });
    return { sessionId: session.sessionId, stopReason, protocolVersion } satisfies AcpRunOutcome;
  }).pipe(Effect.provide(layer), Effect.scoped);

  let promptError: unknown;
  let promptOk: AcpRunOutcome | undefined;
  try {
    promptOk = (await Effect.runPromise(
      outcome as Effect.Effect<AcpRunOutcome>,
      input.signal ? { signal: input.signal } : undefined
    )) as AcpRunOutcome;
  } catch (error) {
    promptError = error;
  }
  // The prompt call resolves on the agent's response; session updates run on
  // their own transport fibers. A short bounded drain lets the trailing
  // updates (final text, usage, idle stop reason) land before the child is
  // killed — v1 agents often reply to session/prompt last.
  const settleDeadline = Date.now() + 3_000;
  while (stopReason === undefined && Date.now() < settleDeadline && !cancelled) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  clearTimeout(timer);
  input.signal?.removeEventListener("abort", onOuterAbort);
  try {
    if (!child.killed) kill();
  } catch {}
  await chain;
  const durationMs = Date.now() - startedAt;

  const errorText = promptError
    ? `${promptError instanceof Error ? promptError.message : String(promptError)}`.slice(0, 2000)
    : "";
  await input.onEvent?.(
    "native.run.finished",
    {
      provider: command,
      runtime: "acp",
      stopReason: promptOk?.stopReason ?? stopReason,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      durationMs,
      ...(timedOut ? { timedOut: true, timeoutMs } : {}),
      ...(promptError ? { errors: [errorText] } : {}),
    },
    promptError ? "warn" : "info",
  );

  const failed = Boolean(promptError) || cancelled || timedOut;
  if (failed) {
    const reason = timedOut
      ? `ACP agent timed out after ${timeoutMs}ms`
      : cancelled
        ? "Execution cancelled"
        : "";
    const output = [reason, errorText, texts.join("").trim()].filter(Boolean).join("\n").slice(0, 12000);
    return {
      status: "failed",
      output: output || "ACP agent ended without a result",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
      ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      durationMs,
      ...(timedOut ? { timedOut: true } : {}),
    };
  }
  const stop = promptOk?.stopReason ?? stopReason;
  const output = texts.join("").trim().slice(0, 12000);
  if (output) await input.onMessage?.(output);
  return {
    status: stop === "refusal" ? "failed" : "completed",
    output: output || (stop ? `(agent stopped: ${stop})` : ""),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    durationMs,
  };
}

/** Read-only policy for calls that reach the ACP runtime without one (tests). */
export function readOnlyAcpPolicy(): OpencodePolicy {
  // Mirrors READ_ONLY_OPENCODE_POLICY without importing it (avoids pulling
  // the whole rule-table construction into this module's init).
  return {
    external_directory: "deny",
    question: "deny",
    doom_loop: "deny",
    read: { "*": "allow" },
    edit: { "*": "deny" },
    bash: { "*": "deny" },
    webfetch: "deny",
    websearch: "deny",
    task: "deny",
  };
}
