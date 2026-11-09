import { createProviderForAgent, getGlobalLLMConfig, type GlobalLLMConfig, type LLMResult } from "@/llm";
import {
  isTransientLlmError,
  runLlmCallWithFallback,
  runWithLlmGates,
  usageMetaFor,
  type FallbackHandle,
  type LlmConcurrencyGate,
  type TokenUsageMeta,
} from "@/effects/llmCall";
import { providerHealth } from "@/llm/health";
import { isBudgetExhaustedError } from "@/orchestrator/budget";
import type { AgentDefinition, ExecutionPlan, PlanSubtask } from "@/orchestrator/types";
import {
  buildAgentExecutionContext,
  formatAgentContextForPrompt,
} from "@/orchestrator/agentContext";
import {
  runNativeProvider,
  buildNativePrompt,
  isNativeProviderAvailable,
  type SpawnImpl,
} from "./nativeProvider";
import type { SharedTaskContext } from "@/orchestrator/taskContext";
import { extractFileHint, parseDelegation, parseDraft, parseReview, sanitizeForChat, type DraftFile } from "@/utils/json";
import { classifyToolCalls, parseToolCallMarkup, stripToolCallMarkup } from "@/utils/toolCallMarkup";
import { tmpdir } from "node:os";
import { validateFilePath } from "@/governance/tools";
import { isPathWithinOwnership } from "@/orchestrator/ownership";
import {
  computeDiff,
  diffFromContents,
  isNoOpChange,
  readHeadContent,
  snapshotDirtyFiles,
  snapshotIdForChanges,
  type FileDiff,
} from "@/tools/gitDiff";
import { isCommandAllowed, runCommand } from "@/tools/runCommand";
import { resolveSandboxPathAsync } from "@/tools/sandbox";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractUrls, type WebClient } from "@/tools/webClient";
import { exploreRepository } from "./repositoryContext";
import { runResponsiveQa } from "./qa";
import { wantsVisualQa } from "@/orchestrator/planner";
import { getMcpRegistry, type McpHooks, type McpSession } from "@/mcp/registry";
import { runMcpToolLoop } from "@/mcp/toolLoop";
import type { McpToolDefinition } from "@/mcp/types";

const execFileAsync = promisify(execFile);

export interface SubtaskExecutionInput {
  workspacePath: string;
  command: string;
  plan: ExecutionPlan;
  subtask: PlanSubtask;
  agent: AgentDefinition;
  browser?: WebClient;
  /** Explicit per-task LLM config resolved by the runner (env fallback when absent). */
  llmConfig?: GlobalLLMConfig;
  /**
   * Per-agent provider chain from the Phase 2 resolver (primary first).
   * When present it takes precedence over `llmConfig`: calls fall back to
   * the next connection in the chain within the same task after local
   * retries, and outcomes feed the provider health registry.
   */
  llmHandles?: FallbackHandle[];
  /**
   * Per-task LLM gate (Phase 4 hardening): every LLM request this
   * subtask makes — including the read-only streaming path — holds a
   * slot on this gate and on the worker-wide gate.
   */
  llmTaskGate?: LlmConcurrencyGate;
  /**
   * Explicit per-task QA base URL resolved by the runner
   * (project qaUrl > devUrl > worker-start env fallback). Threaded through
   * instead of read from shared process.env so concurrent tasks can never
   * QA against another project's URL (spec §8).
   */
  qaBaseUrl?: string;
  /** Shared orchestrator context; when present it replaces the raw prior-output dump. */
  taskContext?: SharedTaskContext;
  priorOutputs: Map<string, string>;
  fileChanges: FileDiff[];
  signal: AbortSignal;
  /**
   * Epoch ms at which the scheduler's subtask timeout fires. Every LLM call
   * is bounded by the time left until then, and a retry that cannot fit in
   * it is skipped instead of being started and killed mid-flight.
   */
  deadlineAt?: number;
  onEvent: (
    type: string,
    payload: Record<string, unknown>,
    level?: "info" | "warn" | "error"
  ) => Promise<void>;
  onMessage: (content: string) => Promise<void>;
  onChunk: (delta: string) => Promise<void>;
  saveFileChange: (change: FileDiff) => Promise<void>;
  /**
   * The change currently staged for a path by ANY subtask of this task
   * (live, unlike the `fileChanges` snapshot taken when this subtask
   * started). Used to detect an edit staged by a concurrent node after
   * this one read its context, so the later write cannot drop it.
   */
  getStagedChange?: (filePath: string) => FileDiff | undefined;
  /**
   * Un-stage a file: a later subtask returned it to its pre-task content
   * (the earlier staged edit is withdrawn instead of failing as a no-op).
   */
  discardFileChange?: (filePath: string) => Promise<void>;
  onTokenUsage?: (inputTokens: number, outputTokens: number, model: string, meta?: TokenUsageMeta) => Promise<void>;
  /**
   * Pre-call budget gate (Phase 5): invoked BEFORE every LLM call this
   * subtask makes. In "enforce" mode it throws BudgetExhaustedError —
   * executeSubtask converts that into a failed outcome carrying the
   * budget reason, and the runner ends the task as budget.exhausted.
   * In "warn" mode it reports via the runner's warning callback and the
   * call proceeds. Absent: no gate (legacy callers/tests).
   */
  assertBudgetForCall?: () => void;
  /**
   * Plan 009: MCP tool provider for this subtask. `sessions` are the
   * registry sessions seeded by the runner for this task's workspace
   * (shared across agents); absent or empty means "no MCP tools" and the
   * subtask runs on its existing path. `writeTools` defaults to false:
   * write-capable MCP tools are filtered for every role.
   */
  mcp?: {
    sessions: McpSession[];
    writeTools?: boolean;
    maxIterations?: number;
  };
  /**
   * Plan 014 runtime: "api" (default, host tools + gated LLM) or
   * "native-provider" (provider CLI with its own native tools in the
   * workspace; full-access per the recorded decision).
   */
  runtime?: "api" | "native-provider";
  /** Optional CLI binary override for the native-provider runtime. */
  nativeProviderCommand?: string;
  /**
   * Agent's OpenCode model (`provider/model`) for the native runtime.
   * Unset: OpenCode is pointed at this subtask's resolved MOAgent LLM.
   */
  nativeModel?: string;
  /** Native runtime wall-clock limit (default ORCHESTRATOR_NATIVE_TIMEOUT_MS / 10 min). */
  nativeTimeoutMs?: number;
  /** Test seam: spawn implementation for the native provider CLI. */
  nativeSpawnImpl?: SpawnImpl;
  /**
   * Browser-QA policy. With "never" the code_change prompt does not invite
   * a browser-testing delegation.
   */
  qaMode?: "always" | "auto" | "never";
}

/**
 * The provider chain for this subtask's agent: the resolver's chain when
 * threaded in, otherwise a single handle built from the task config (or
 * the worker env). Health is only recorded for resolver chains — the
 * synthetic single handle has no connection identity to track.
 */
function handlesFor(input: SubtaskExecutionInput): FallbackHandle[] {
  if (input.llmHandles && input.llmHandles.length > 0) return input.llmHandles;
  const config = input.llmConfig ?? getGlobalLLMConfig();
  return [{
    connectionId: "",
    connectionName: "(task config)",
    config,
    provider: createProviderForAgent(input.agent, config),
  }];
}

function healthFor(input: SubtaskExecutionInput) {
  return input.llmHandles && input.llmHandles.length > 0 ? providerHealth : undefined;
}

/** The agent's MCP scope: role matrix + supportedTools + the write knob. */
function mcpScope(input: SubtaskExecutionInput) {
  return {
    role: input.agent.role,
    supportedTools: input.agent.supportedTools,
    allowWrite: input.mcp?.writeTools === true,
  };
}

/**
 * Plan 009: run the bounded MCP tool loop for this subtask. Returns null
 * when MCP is not configured for the task or the server yielded no
 * permitted tools — the caller then uses its existing path unchanged.
 *
 * The loop runs one LLM step per iteration through the normal provider
 * chain, so the pre-call budget gate and both LLM concurrency gates apply
 * exactly as they do to a direct call.
 */
async function runMcpExploration(
  input: SubtaskExecutionInput,
  instruction: string,
  context: string
): Promise<{ answer: string; toolCalls: number; toolCount: number } | null> {
  const sessions = input.mcp?.sessions ?? [];
  if (sessions.length === 0) return null;

  const scope = mcpScope(input);
  const hooks: McpHooks = {
    onEvent: async (type, payload) => {
      // The runner's event sink takes a plain record; the payload is already
      // free of file content and secret material (registry-side masking).
      const flat: Record<string, unknown> = { ...payload };
      await input.onEvent(type, flat, type === "mcp.server_error" || type === "mcp.tool_error" ? "warn" : "info");
    },
  };

  const tools: McpToolDefinition[] = [];
  for (const session of sessions) {
    tools.push(...(await getMcpRegistry().toolsFor(session, scope, hooks)));
  }
  if (tools.length === 0) return null;

  const handles = handlesFor(input);
  const health = healthFor(input);
  const messages = baseMessages(
    input,
    `${instruction}\n\nRepository context:\n${context}\n\nUser request: ${input.command}`
  );

  const result = await runMcpToolLoop({
    tools,
    maxIterations: input.mcp?.maxIterations ?? 6,
    signal: input.signal,
    messages,
    runLlm: async (loopMessages) => {
      input.assertBudgetForCall?.();
      const { result: llmResult, servedBy } = await runLlmCallWithFallback(handles, loopMessages, {
        health,
        signal: input.signal,
        timeoutMs: llmCallTimeoutMs(input),
        taskGate: input.llmTaskGate,
      });
      if (input.onTokenUsage) {
        await input.onTokenUsage(
          llmResult.inputTokens ?? 0,
          llmResult.outputTokens ?? 0,
          servedBy.config.model,
          usageMetaFor(servedBy, llmResult.inputTokens ?? 0, llmResult.outputTokens ?? 0)
        );
      }
      return llmResult.content;
    },
    callTool: async ({ tool, args }) => {
      const session =
        sessions.find((candidate) => candidate.tools.some((entry) => entry.name === tool)) ?? sessions[0];
      return await getMcpRegistry().callTool(session, scope, tool, args, input.agent._id, input.signal, hooks);
    },
  });

  return { answer: result.answer, toolCalls: result.toolCalls, toolCount: tools.length };
}

export type SubtaskExecutionResult =
  | { status: "completed"; output?: string; meta?: Record<string, unknown> }
  | { status: "failed"; error: string; meta?: Record<string, unknown> };

const STAGED_FILE_CHARS = 12_000;
const STAGED_TOTAL_CHARS = 40_000;

/** Current content of files staged by earlier subtasks of this task. */
export function stagedChangesContext(changes: FileDiff[]): string {
  if (changes.length === 0) return "";
  const sections: string[] = [];
  let total = 0;
  for (const change of changes) {
    if (total >= STAGED_TOTAL_CHARS) {
      sections.push(`--- ${change.filePath} (staged, omitted: context limit) ---`);
      continue;
    }
    if (change.changeType === "deleted") {
      sections.push(`--- ${change.filePath} (staged: DELETED) ---`);
      continue;
    }
    const body = (change.newContent ?? "").slice(0, STAGED_FILE_CHARS);
    total += body.length;
    sections.push(`--- ${change.filePath} (staged ${change.changeType}) ---\n${body}`);
  }
  return [
    "Files already changed by earlier subtasks of this task (NOT on disk yet). This is their CURRENT content: build on it and keep those changes; return the full updated file when you change one of them:",
    ...sections,
  ].join("\n");
}

/** Workspace files an invalid answer asked for (tool-call markup or plain paths), with content. */
export async function requestedFilesContext(
  workspacePath: string,
  answer: string,
  staged: FileDiff[],
  explicitPaths: string[] = []
): Promise<string> {
  const candidates = new Set<string>(explicitPaths);
  for (const match of answer.matchAll(/<[\w-]*tool_call[^>]*>([\s\S]*?)<\/[\w-]*tool_call>/gi)) {
    for (const token of match[1].split(/[\s,"'{}:\[\]<>]+/)) if (/\.[A-Za-z0-9]{1,6}$/.test(token)) candidates.add(token);
  }
  for (const match of answer.matchAll(/(?:^|[\s`"'(])((?:[\w.-]+\/)*[\w.-]+\.(?:[jt]sx?|mjs|cjs|css|scss|html?|json|md|vue|svelte))(?=$|[\s`"'),:;])/g)) candidates.add(match[1]);
  const sections: string[] = [];
  const root = path.resolve(workspacePath);
  for (const raw of Array.from(candidates).slice(0, 12)) {
    const rel = raw.replace(/^\.\//, "");
    const stagedChange = staged.find((change) => change.filePath === rel);
    if (stagedChange) continue; // already in the staged section
    const absolute = path.resolve(root, rel);
    if (!absolute.startsWith(root + path.sep)) continue;
    try {
      const content = await fs.readFile(absolute, "utf-8");
      sections.push(`--- ${rel} ---\n${content.slice(0, STAGED_FILE_CHARS)}`);
    } catch {
      // Not a workspace file: ignore.
    }
    if (sections.length >= 6) break;
  }
  return sections.length > 0 ? ["Files you asked for:", ...sections].join("\n") : "";
}

/**
 * Parse a code-change answer: JSON draft after stripping tool-call markup,
 * else full-file write tool calls, plus the paths read-style tool calls
 * asked for (handed to the retry).
 */
export function parseCodeChangeAnswer(content: string): {
  draft: { files: DraftFile[] } | null;
  readPaths: string[];
  hadMarkup: boolean;
} {
  const markup = parseToolCallMarkup(content);
  const { files, readPaths } = classifyToolCalls(markup.calls);
  let draft = parseDraft(markup.hadMarkup ? markup.stripped : content);
  if (!draft && markup.hadMarkup) draft = parseDraft(content);
  if (draft && files.length > 0) {
    const byPath = new Map(draft.files.map((file) => [file.filePath, file]));
    for (const file of files) if (!byPath.has(file.filePath)) byPath.set(file.filePath, file);
    draft = { files: Array.from(byPath.values()) };
  } else if (!draft && files.length > 0) {
    draft = { files };
  }
  return { draft, readPaths, hadMarkup: markup.hadMarkup };
}

/** git merge-file -p base/ours/theirs: merged text, or null on conflict/error. */
export async function mergeThreeWay(base: string, ours: string, theirs: string): Promise<string | null> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "moagent-merge-"));
  try {
    const [b, o, t] = ["base", "ours", "theirs"].map((name) => path.join(dir, name));
    await Promise.all([fs.writeFile(b, base), fs.writeFile(o, ours), fs.writeFile(t, theirs)]);
    try {
      const { stdout } = await execFileAsync("git", ["merge-file", "-p", o, b, t], {
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout;
    } catch {
      return null; // exit code > 0 = conflicts; < 0 = error
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function meaningfulLines(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 2)
  );
}

/**
 * Whether `proposed` was written from the pre-task (disk) content and so
 * silently drops every line an earlier staged edit added: none of the
 * staged-only lines survive, the disk-only lines it replaced are all
 * back, and most lines both versions share are still there.
 */
export function dropsStagedEdit(disk: string, staged: string, proposed: string): boolean {
  const diskLines = meaningfulLines(disk);
  const stagedLines = meaningfulLines(staged);
  const proposedLines = meaningfulLines(proposed);
  const added = Array.from(stagedLines).filter((line) => !diskLines.has(line));
  const removed = Array.from(diskLines).filter((line) => !stagedLines.has(line));
  if (added.length === 0) return false;
  if (added.some((line) => proposedLines.has(line))) return false;
  if (!removed.every((line) => proposedLines.has(line))) return false;
  // It must still look like an edit of the same file: most unchanged lines
  // are kept. A refactor that moves the region out is not a dropped edit.
  const common = Array.from(diskLines).filter((line) => stagedLines.has(line));
  if (common.length === 0) return true;
  const kept = common.filter((line) => proposedLines.has(line)).length;
  return kept / common.length >= 0.6;
}

export type StagedReconcile =
  | { ok: true; content: string; merged?: "concurrent"; revertsStaged?: boolean }
  | { ok: false; error: string };

/**
 * Make a node's proposed full-file content keep the edits other nodes of
 * the same task already staged for that file (they are not on disk yet).
 *  - A concurrent node staged the file after this node read its context:
 *    3-way merge (base = what this node saw); a conflict fails the node.
 *  - The node saw the staged content but answered with the disk version
 *    of it: kept (usually an intentional move), flagged `revertsStaged`
 *    so the runner logs it for review.
 */
export async function reconcileWithStaged(params: {
  diskContent: string | undefined;
  seen: FileDiff | undefined;
  current: FileDiff | undefined;
  proposed: string;
}): Promise<StagedReconcile> {
  const { diskContent, seen, current, proposed } = params;
  if (!current || current.changeType === "deleted" || current.newContent === undefined) {
    return { ok: true, content: proposed };
  }
  const nodeBase = seen && seen.changeType !== "deleted" ? seen.newContent ?? "" : diskContent ?? "";
  if (current.newContent !== nodeBase) {
    if (proposed === current.newContent) return { ok: true, content: proposed };
    const merged = await mergeThreeWay(nodeBase, current.newContent, proposed);
    if (merged === null) {
      return {
        ok: false,
        error: `Conflicting edit: ${current.filePath} was changed by another subtask of this task while this one worked on it. Rebuild the change on its current staged content.`,
      };
    }
    return { ok: true, content: merged, merged: "concurrent" };
  }
  // The node saw the staged content (it is in its prompt). If it still
  // answers with the disk version of those lines, that is usually an
  // intentional move (e.g. a refactor moving the toggle out of main.js
  // into the header component): re-merging would duplicate the code
  // (seen in e2e ULTRA). Keep the proposal and only flag it.
  if (diskContent !== undefined && proposed !== current.newContent && dropsStagedEdit(diskContent, current.newContent, proposed)) {
    return { ok: true, content: proposed, revertsStaged: true };
  }
  return { ok: true, content: proposed };
}

/**
 * Error for a model call that produced no answer at all. Worded so the
 * scheduler classifies it as retryable (it matches none of the permanent
 * "unparseable"/"invalid JSON" patterns).
 */
export const EMPTY_MODEL_ANSWER_ERROR = (agent: "review" | "implementation") =>
  `The ${agent} agent got an empty answer from the model (no output); retrying the subtask`;

/** Safety margin kept between an LLM call's own timeout and the subtask deadline. */
const DEADLINE_MARGIN_MS = 2_000;
/** A retry is never started with less than this left in the subtask. */
export const MIN_RETRY_WINDOW_MS = 15_000;

/**
 * Timeout for one LLM call of this subtask: the time left until the
 * subtask deadline (minus a margin), capped by the configured LLM timeout
 * inside the provider. Undefined (= configured timeout) without a deadline.
 */
export function llmCallTimeoutMs(input: Pick<SubtaskExecutionInput, "deadlineAt">, now = Date.now()): number | undefined {
  if (input.deadlineAt === undefined) return undefined;
  return Math.max(1_000, input.deadlineAt - now - DEADLINE_MARGIN_MS);
}

/**
 * Whether a second LLM call fits before the subtask deadline: it needs at
 * least as long as the first call took (+25%) and never less than
 * MIN_RETRY_WINDOW_MS. Without a deadline a retry is always allowed.
 */
export function canAffordRetry(
  deadlineAt: number | undefined,
  previousCallMs: number,
  now = Date.now()
): { ok: boolean; remainingMs: number } {
  if (deadlineAt === undefined) return { ok: true, remainingMs: Number.POSITIVE_INFINITY };
  const remainingMs = Math.max(0, deadlineAt - now - DEADLINE_MARGIN_MS);
  const needed = Math.max(MIN_RETRY_WINDOW_MS, Math.ceil(previousCallMs * 1.25));
  return { ok: remainingMs >= needed, remainingMs };
}

export async function executeSubtask(
  input: SubtaskExecutionInput
): Promise<SubtaskExecutionResult> {
  const { subtask, agent } = input;
  if (input.signal.aborted) {
    return { status: "failed", error: "Execution cancelled" };
  }

  try {
    // Plan 014: native-provider runtime (provider CLI with its own native
    // tools in the task workspace). Falls back to the API path when the
    // provider binary is unavailable.
    // QA and review stay deterministic on every runtime: the provider CLI
    // returns no verdict, so a QA/review node sent there would always
    // read as failing (QA audit P0-5).
    if (
      input.runtime === "native-provider" &&
      subtask.kind !== "qa" &&
      subtask.kind !== "review"
    ) {
      const available = await isNativeProviderAvailable(input.nativeProviderCommand);
      if (!available) {
        await input.onEvent(
          "native.runtime.unavailable",
          { provider: input.nativeProviderCommand ?? "native-provider" },
          "warn"
        );
      } else {
        return await executeNativeProvider(input);
      }
    }
    switch (subtask.kind) {
      case "code_change":
        return await executeCodeChange(input);
      case "review":
        return await executeReview(input);
      case "qa":
        return await executeQa(input);
      case "audit":
        return await executeReadOnly(input, "audit");
      case "research":
        return await executeReadOnly(input, "research");
      case "shell":
        return await executeShell(input);
      case "analysis":
      default:
        return await executeReadOnly(input, "analysis");
    }
  } catch (error) {
    // Budget enforcement (Phase 5): a pre-call gate throw becomes a
    // normal failed outcome whose error carries the exhaustion reason —
    // the runner recognizes it and ends the task as budget.exhausted
    // instead of replanning it away like a generic failure.
    if (isBudgetExhaustedError(error)) {
      return { status: "failed", error: error.message };
    }
    throw error;
  }
}

/**
 * Plan 014 native-provider runtime: run the subtask through the provider
 * CLI in the task workspace (the provider owns its native tools there),
 * then stage any workspace changes it made through the normal host diff
 * pipeline so verification and the approval flow still see them. Budget
 * gate is waived per the recorded Plan 014 decision; usage is reported
 * for observability when the provider reports it.
 */
async function executeNativeProvider(input: SubtaskExecutionInput): Promise<SubtaskExecutionResult> {
  const {
    workspacePath,
    command,
    agent,
    subtask,
    signal,
    onEvent,
    onMessage,
  } = input;

  const fileHint = extractFileHint(`${subtask.description}\n${command}`);
  const { context } = await exploreRepository(workspacePath, { fileHint });
  await onEvent("native.context", {
    capability: subtask.capability,
    mode: "native-provider",
  });

  if (signal.aborted) return { status: "failed", error: "Execution cancelled" };

  let prior = "";
  if (input.taskContext) {
    const curated = buildAgentExecutionContext({
      taskContext: input.taskContext,
      agent,
      assignment: `${subtask.title} — ${subtask.description}`,
    });
    prior = `Shared task context:\n${formatAgentContextForPrompt(curated)}`;
  } else if (input.priorOutputs.size > 0) {
    const raw = Array.from(input.priorOutputs.entries())
      .map(([key, value]) => `### ${key}\n${value.slice(0, 4000)}`)
      .join("\n\n");
    prior = `Previous subtask outputs:\n${raw}`;
  }

  const prompt = buildNativePrompt({
    title: subtask.title,
    description: subtask.description,
    command,
    systemPrompt: agent.systemPrompt,
    priorContext: prior || undefined,
    fileContext: context,
  });

  // The native provider writes straight to disk, so the "before" content
  // must be captured now: reading it from disk after the run would make
  // every change look identical to its pre-task state.
  const preRunDirty = await snapshotNativeBaseline(workspacePath);
  // Commits are the runner's job. Remember HEAD so a commit the provider
  // makes anyway is undone (soft) and its files still pass the gate below.
  const preRunHead = await readGitHead(workspacePath, signal);

  // OpenCode uses the agent's own OpenCode model when set; otherwise the
  // same LLM the rest of MOAgent resolved for this agent (first handle of
  // the resolver chain, else the task/global config).
  const llm = input.llmHandles?.[0]?.config ?? input.llmConfig ?? getGlobalLLMConfig();
  const result = await runNativeProvider({
    workspacePath,
    prompt,
    command: input.nativeProviderCommand,
    model: input.nativeModel,
    llm,
    timeoutMs: input.nativeTimeoutMs,
    spawnImpl: input.nativeSpawnImpl,
    signal,
    onEvent,
    onChunk: input.onChunk,
    onMessage,
  });

  if (preRunHead) {
    const postRunHead = await readGitHead(workspacePath, signal);
    if (postRunHead && postRunHead !== preRunHead) {
      try {
        await runCommand(workspacePath, "git", ["reset", "--soft", preRunHead], { signal });
        await runCommand(workspacePath, "git", ["reset", "-q"], { signal });
        await onEvent("native.commit.undone", { from: postRunHead, to: preRunHead }, "warn");
      } catch (error) {
        return { status: "failed", error: `Native provider committed and the commit could not be undone: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
  }

  if (input.onTokenUsage && (result.inputTokens > 0 || result.outputTokens > 0)) {
    await input.onTokenUsage(result.inputTokens, result.outputTokens, result.model ?? "native-provider", undefined);
  }

  if (result.status !== "completed") {
    return { status: "failed", error: result.output || "Native provider run failed" };
  }

  // Staging gate: stage what the provider changed in scope so the
  // verification and approval flows still review it; revert everything
  // out of scope (forbidden paths, invalid paths, outside allowedPaths, or
  // any write from a read-only kind) so it can never reach a commit.
  const mutating = subtask.kind === "code_change" || subtask.kind === "shell";
  const prepared: { filePath: string }[] = [];
  const rejected: { filePath: string; reason: string }[] = [];
  let changedPaths: string[] = [];
  try {
    changedPaths = await listWorkspaceChanges(workspacePath, signal);
  } catch {
    // Workspace may not be a git repo; the provider's own output stands.
  }
  for (const filePath of changedPaths) {
    if (signal.aborted) return { status: "failed", error: "Execution cancelled" };
    let resolved: string;
    try {
      resolved = await resolveSandboxPathAsync(workspacePath, filePath);
    } catch {
      continue;
    }
    const newContent = await readIfExistsUtf8(resolved);
    const baseline = preRunDirty.has(filePath)
      ? preRunDirty.get(filePath) ?? undefined
      : await readHeadContent(workspacePath, filePath);
    // Dirty before the run and untouched by the provider: not its change.
    if ((baseline ?? null) === newContent) continue;
    const reason = !mutating
      ? `read-only ${subtask.kind} subtask`
      : isForbiddenPath(filePath)
        ? "forbidden path"
        : !validateFilePath(filePath).ok
          ? "invalid path"
          : !isPathWithinOwnership(filePath, subtask.allowedPaths)
            ? "outside allowedPaths"
            : "";
    if (reason) {
      try {
        if (baseline === undefined) await fs.rm(resolved, { force: true });
        else await fs.writeFile(resolved, baseline, "utf-8");
        rejected.push({ filePath, reason });
      } catch {
        rejected.push({ filePath, reason: `${reason} (revert failed)` });
      }
      continue;
    }
    if (newContent === null && baseline === undefined) continue;
    try {
      const diff: FileDiff =
        newContent === null
          ? {
              ...diffFromContents(filePath, baseline, ""),
              changeType: "deleted",
              newContent: undefined,
              newContentHash: undefined,
            }
          : diffFromContents(filePath, baseline, newContent);
      await input.saveFileChange(diff);
      prepared.push({ filePath });
    } catch {
      // Per-file staging failures are best-effort; the summary stands.
    }
  }
  if (rejected.length > 0) {
    await onEvent(
      "native.change.rejected",
      { files: rejected.slice(0, 50) },
      "warn"
    );
  }

  const output = [
    result.output,
    prepared.length > 0 ? `Staged ${prepared.length} file change(s): ${prepared.map((c) => c.filePath).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    status: "completed",
    output,
    meta: {
      runtime: "native-provider",
      provider: input.nativeProviderCommand ?? "opencode",
      ...(result.model ? { model: result.model } : {}),
      stagedFiles: prepared.map((c) => c.filePath),
      ...(rejected.length > 0 ? { rejectedFiles: rejected.map((r) => r.filePath) } : {}),
    },
  };
}

/** Porcelain paths (untracked files listed individually), capped. */
async function listWorkspaceChanges(workspacePath: string, signal?: AbortSignal): Promise<string[]> {
  // Host-internal read (not an agent command, so not via the allowlist).
  const { stdout } = await execFileAsync("git", ["status", "--porcelain", "-uall"], {
    cwd: workspacePath,
    maxBuffer: 10 * 1024 * 1024,
    shell: false,
    windowsHide: true,
    signal,
  });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .map((p) => (p.includes(" -> ") ? p.split(" -> ").pop() ?? p : p))
    .map((p) => p.replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
    .slice(0, 500);
}

async function readIfExistsUtf8(resolved: string): Promise<string | null> {
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return null;
    return await fs.readFile(resolved, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Pre-run content of every dirty path, including each untracked file
 * (`-uall`), so the post-run gate can tell the provider's writes from
 * pre-existing edits and restore out-of-scope paths exactly.
 */
async function snapshotNativeBaseline(workspacePath: string): Promise<Map<string, string | null>> {
  const snapshot = await snapshotDirtyFiles(workspacePath);
  try {
    for (const filePath of await listWorkspaceChanges(workspacePath)) {
      if (snapshot.has(filePath)) continue;
      try {
        const resolved = await resolveSandboxPathAsync(workspacePath, filePath);
        snapshot.set(filePath, await readIfExistsUtf8(resolved));
      } catch {
        // Outside the sandbox: not ours to track.
      }
    }
  } catch {
    // Not a git repo.
  }
  return snapshot;
}

function baseMessages(input: SubtaskExecutionInput, userContent: string) {
  const { agent, priorOutputs } = input;
  // Prefer the curated shared context (relevant summaries, open issues,
  // artifacts, recent decisions) over a raw dump of every previous output.
  // Full outputs remain recorded in the executions table. The raw dump is
  // only a fallback for callers without a shared context (e.g. resumeTask).
  let prior = "";
  if (input.taskContext) {
    const curated = buildAgentExecutionContext({
      taskContext: input.taskContext,
      agent,
      assignment: `${input.subtask.title} — ${input.subtask.description}`,
    });
    prior = `Shared task context:\n${formatAgentContextForPrompt(curated)}`;
  } else if (priorOutputs.size > 0) {
    const raw = Array.from(priorOutputs.entries())
      .map(([key, value]) => `### ${key}\n${value.slice(0, 4000)}`)
      .join("\n\n");
    prior = `Previous subtask outputs:\n${raw}`;
  }
  return [
    ...(agent.systemPrompt
      ? [{ role: "system" as const, content: agent.systemPrompt }]
      : []),
    {
      role: "user" as const,
      content: [prior, userContent].filter(Boolean).join("\n\n"),
    },
  ];
}

async function executeCodeChange(
  input: SubtaskExecutionInput
): Promise<SubtaskExecutionResult> {
  const { workspacePath, command, agent, subtask, onEvent, onMessage, signal } = input;
  const fileHint = extractFileHint(`${subtask.description}\n${command}`);
  const { context } = await exploreRepository(workspacePath, { fileHint });
  await onEvent("agent.context", {
    capability: subtask.capability,
    filesHinted: fileHint ?? null,
  });

  if (signal.aborted) return { status: "failed", error: "Execution cancelled" };

  // Plan 009: read-only MCP exploration before the diff call. Findings
  // are appended to the payload; a failed exploration never blocks the
  // diff call — it is caught, not propagated. Writes stay on the
  // approval-gated diff pipeline below, never on MCP.
  let mcpFindings = "";
  try {
    const explored = await runMcpExploration(
      input,
      `Explore the workspace with the available tools to gather context for this task: ${subtask.title} — ${subtask.description}`,
      context
    );
    if (explored && explored.toolCalls > 0) {
      mcpFindings = `\n\nWorkspace tool findings:\n${explored.answer.slice(0, 4000)}`;
    }
  } catch {
    // Best-effort only.
  }

  const handles = handlesFor(input);
  // Earlier subtasks of this task staged changes that are not on disk yet
  // (they land after approval). A later node — e.g. "header refactor"
  // after "dark mode" on the same files — must build on that content, or
  // it would rewrite the file from disk and drop the earlier change.
  const staged = stagedChangesContext(input.fileChanges);
  const basePayload =
    [
    `Task: ${command}`,
    `Your role in the plan: ${subtask.title} — ${subtask.description}`,
    `Repository context:\n${context}`,
    ...(staged ? ["", staged] : []),
    "",
    "You cannot call tools or read more files: everything available is above. Do not emit tool calls.",
    "Return JSON only with the files you want to change:",
    '{"files":[{"filePath":"relative/path","newContent":"FULL file content"}]}',
    "",
    "You may add these optional top-level fields to the same JSON object:",
    input.qaMode === "never"
      ? '- "delegationRecommendation":{"targetCapability":"...","reason":"..."} when another capability should take over after you (never browser-testing: browser QA is disabled by policy).'
      : '- "delegationRecommendation":{"targetCapability":"...","reason":"..."} when another capability should take over after you (e.g. browser-testing for QA).',
    '- "findings":["short description", ...] for concrete problems you noticed but did not fix.',
    "",
    "STRICT FORMAT RULES:",
    "- Use exactly the keys \"filePath\" and \"newContent\" (camelCase) on every entry.",
    "- Do NOT use keys like \"path\", \"filename\", \"newText\", or \"content\".",
    "- Return the raw JSON object only. No explanation, no markdown fences, no commentary.",
    "- Set newContent to the complete file after your change, not a diff or patch.",
    "- If no files need changing, return exactly {\"files\":[]}.",
    "",
    "Rules:",
    ...(subtask.allowedPaths && subtask.allowedPaths.length > 0
      ? [`- Declared ownership for this subtask: ${subtask.allowedPaths.join(", ")}. Only modify files inside it.`]
      : []),
    "- Only relative paths inside the workspace.",
    "- Preserve unrelated behavior and code.",
    "- Do not touch lockfiles, secrets, .env files, or node_modules.",
    "- Keep the change minimal and focused on the task.",
  ].join("\n") + mcpFindings;

  // Pre-call budget gate (Phase 5): no LLM call starts once the task's
  // call/token budget is spent (enforce mode throws here).
  input.assertBudgetForCall?.();
  const firstCallStartedAt = Date.now();
  let { result: response, servedBy } = await runLlmCallWithFallback(
    handles,
    baseMessages(input, basePayload),
    { health: healthFor(input), signal: input.signal, timeoutMs: llmCallTimeoutMs(input), taskGate: input.llmTaskGate }
  );
  if (input.onTokenUsage) {
    await input.onTokenUsage(
      response.inputTokens ?? 0,
      response.outputTokens ?? 0,
      servedBy.config.model,
      usageMetaFor(servedBy, response.inputTokens ?? 0, response.outputTokens ?? 0)
    );
  }

  const firstCallMs = Date.now() - firstCallStartedAt;
  let parsedAnswer = parseCodeChangeAnswer(response.content);
  let draft = parsedAnswer.draft;
  if (parsedAnswer.hadMarkup) {
    await onEvent("agent.context", {
      capability: subtask.capability,
      toolCallMarkup: true,
      readPaths: parsedAnswer.readPaths.slice(0, 12),
      draftFromMarkup: draft !== null,
    }, "warn");
  }
  if (!draft) {
    // The retry is a full second call: start it only when the subtask has
    // time left for one (as long as the first call took, plus margin).
    // Otherwise the scheduler would kill it mid-flight and report a
    // timeout that hides the real problem (invalid JSON).
    const retryCheck = canAffordRetry(input.deadlineAt, firstCallMs);
    if (!retryCheck.ok) {
      await onEvent(
        "agent.context",
        {
          capability: subtask.capability,
          retry: false,
          reason: "invalid-file-changes-json",
          skipped: "insufficient-time",
          remainingMs: retryCheck.remainingMs,
          firstCallMs,
        },
        "warn"
      );
      return {
        status: "failed",
        error: `The implementation agent did not return valid file changes JSON (retry skipped: ${Math.round(
          retryCheck.remainingMs / 1000
        )}s left in the subtask, the first call took ${Math.round(firstCallMs / 1000)}s)`,
      };
    }
    await onEvent("agent.context", {
      capability: subtask.capability,
      retry: true,
      reason: "invalid-file-changes-json",
    });
    // Retry on the connection that served the first call (stickiness);
    // the single-handle chain still applies local retries + health.
    // The retry is a second LLM call: the budget gate applies again.
    input.assertBudgetForCall?.();
    // The model often answers a missing file with a tool call
    // ("<x_tool_call>src/header.js</x_tool_call>") or by naming it: hand
    // those files to the retry so it can answer with JSON.
    const requested = await requestedFilesContext(workspacePath, response.content, input.fileChanges, parsedAnswer.readPaths);
    const previous = stripToolCallMarkup(response.content).slice(0, 2000);
    const retryNote = parsedAnswer.hadMarkup
      ? "Your previous response was a tool call. Tools are NOT available here: the files you asked for are included above. Return ONLY the file-changes JSON object now."
      : "Your previous response was not a valid file-changes JSON object. Return ONLY the JSON object again.";
    ({ result: response, servedBy } = await runLlmCallWithFallback(
      [servedBy],
      baseMessages(
        input,
        `${basePayload}${requested ? `\n\n${requested}` : ""}\n\n${retryNote}${previous ? `\n\nPrevious response (for reference):\n${previous}` : ""}`
      ),
      { health: healthFor(input), signal: input.signal, timeoutMs: llmCallTimeoutMs(input), taskGate: input.llmTaskGate }
    ));
    if (input.onTokenUsage) {
      await input.onTokenUsage(
        response.inputTokens ?? 0,
        response.outputTokens ?? 0,
        servedBy.config.model,
        usageMetaFor(servedBy, response.inputTokens ?? 0, response.outputTokens ?? 0)
      );
    }
    parsedAnswer = parseCodeChangeAnswer(response.content);
    draft = parsedAnswer.draft;
  }
  if (!draft) {
    if (stripToolCallMarkup(response.content).trim() === "" && parsedAnswer.readPaths.length === 0) {
      return { status: "failed", error: EMPTY_MODEL_ANSWER_ERROR("implementation") };
    }
    return {
      status: "failed",
      error: "The implementation agent did not return valid file changes JSON",
    };
  }

  const delegation = parseDelegation(stripToolCallMarkup(response.content));
  const delegationMeta = {
    ...(delegation?.delegationRecommendation ? { delegationRecommendation: delegation.delegationRecommendation } : {}),
    ...(delegation?.findings ? { findings: delegation.findings } : {}),
  };

  const prepared: FileDiff[] = [];
  if (draft.files.length === 0) {
    const output = "No file changes needed for this task.";
    await onMessage(output);
    return { status: "completed", output, meta: { filePaths: [], ...delegationMeta } };
  }
  // The task may have been cancelled / timed out while the model was
  // answering (a provider that ignores the abort signal can still
  // resolve late). A response that lost that race must not stage any
  // file changes (Phase 4 anti-zombie rule).
  if (signal.aborted) return { status: "failed", error: "Execution cancelled" };
  const unchanged: string[] = [];
  const reverted: string[] = [];
  for (const file of draft.files.slice(0, 5)) {
    // Check between files: once aborted, no further changes are staged.
    if (signal.aborted) return { status: "failed", error: "Execution cancelled" };
    if (isForbiddenPath(file.filePath)) {
      return { status: "failed", error: `Refusing to modify protected path: ${file.filePath}` };
    }
    const filePathCheck = validateFilePath(file.filePath);
    if (!filePathCheck.ok) {
      return { status: "failed", error: `Refusing to modify protected path (${filePathCheck.reason}): ${file.filePath}` };
    }
    if (!isPathWithinOwnership(file.filePath, subtask.allowedPaths)) {
      return { status: "failed", error: `Refusing to modify path outside declared ownership: ${file.filePath}` };
    }
    try {
      // Build on what earlier/concurrent subtasks already staged for this
      // file (not on disk until approval) instead of dropping it.
      const seen = input.fileChanges.find((change) => change.filePath === file.filePath);
      const current = input.getStagedChange?.(file.filePath) ?? seen;
      let newContent = file.newContent;
      if (current) {
        const diskContent = (await computeDiff(workspacePath, file.filePath, "")).oldContent;
        const reconciled = await reconcileWithStaged({ diskContent, seen, current, proposed: file.newContent });
        if (!reconciled.ok) return { status: "failed", error: reconciled.error };
        if (reconciled.merged) {
          await onEvent("fileChanges.merged", { filePath: file.filePath, reason: reconciled.merged }, "warn");
        }
        if (reconciled.revertsStaged) {
          await onEvent(
            "fileChanges.revertsStaged",
            { filePath: file.filePath, stagedBy: (current as FileDiff & { subtaskKey?: string }).subtaskKey ?? null },
            "warn"
          );
        }
        newContent = reconciled.content;
        if (current.newContent === newContent && current.changeType !== "deleted") {
          unchanged.push(file.filePath);
          continue;
        }
      }
      const diff = await computeDiff(workspacePath, file.filePath, newContent);
      if (isNoOpChange(diff) && current && current.changeType !== "deleted" && input.discardFileChange) {
        // Back to the pre-task content while an earlier edit is staged:
        // that is a real change (withdraw the staged edit), not a no-op.
        await input.discardFileChange(file.filePath);
        reverted.push(file.filePath);
        continue;
      }
      if (isNoOpChange(diff)) {
        // Identical to what is on disk: staging it would only fail final
        // disk verification ("unchanged from its pre-task state").
        unchanged.push(file.filePath);
        continue;
      }
      await input.saveFileChange(diff);
      prepared.push(diff);
    } catch (error) {
      return {
        status: "failed",
        error: `Could not stage ${file.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (prepared.length === 0 && reverted.length === 0 && unchanged.length > 0) {
    return {
      status: "failed",
      error: `No effective change: ${unchanged.join(", ")} would be identical to the current content. Make the requested edit or report why none is needed.`,
    };
  }

  const output = [
    `Prepared ${prepared.length} file change(s): ${prepared.map((change) => change.filePath).join(", ")}`,
    reverted.length > 0 ? `Reverted ${reverted.length} staged file(s) to their original content: ${reverted.join(", ")}` : "",
    unchanged.length > 0 ? `Skipped ${unchanged.length} unchanged file(s): ${unchanged.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    status: "completed",
    output,
    meta: {
      filePaths: prepared.map((change) => change.filePath),
      ...(reverted.length > 0 ? { revertedPaths: reverted } : {}),
      ...delegationMeta,
    },
  };
}

async function executeReview(
  input: SubtaskExecutionInput
): Promise<SubtaskExecutionResult> {
  const { agent, subtask, fileChanges } = input;
  if (fileChanges.length === 0) {
    return {
      status: "completed",
      output: "No file changes were prepared, so there is nothing to review.",
    };
  }

  const snapshotId = snapshotIdForChanges(fileChanges);
  const diffText = fileChanges
    .map((change) => `### ${change.filePath} (${change.changeType})\n${change.diff}`)
    .join("\n\n")
    .slice(0, 40_000)
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9_]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)\b/g, "[REDACTED]");

  // Pre-call budget gate (Phase 5).
  input.assertBudgetForCall?.();
  const reviewStartedAt = Date.now();
  const reviewPrompt =
      [
        `Review these prepared changes for: ${input.command}`,
        `Review scope: ${subtask.description}`,
        `Change-set snapshot id: ${snapshotId}. Review exactly this frozen set.`,
        diffText,
        "",
        "Return JSON only:",
        '{"verdict":"approved"|"changes_requested","findings":[{"severity":"critical"|"high"|"medium"|"low","filePath":"...","description":"...","suggestion":"..."}]}',
        "Reject only for concrete correctness, security, or regression risks. Do not request style-only changes.",
        "You cannot call tools: the diff above is everything. Do not emit tool calls.",
      ].join("\n");
  let { result: response, servedBy } = await runLlmCallWithFallback(
    handlesFor(input),
    baseMessages(input, reviewPrompt),
    { health: healthFor(input), signal: input.signal, timeoutMs: llmCallTimeoutMs(input), taskGate: input.llmTaskGate }
  );
  const reportUsage = async () => {
    if (!input.onTokenUsage) return;
    await input.onTokenUsage(
      response.inputTokens ?? 0,
      response.outputTokens ?? 0,
      servedBy.config.model,
      usageMetaFor(servedBy, response.inputTokens ?? 0, response.outputTokens ?? 0)
    );
  };
  await reportUsage();

  let review = parseReview(stripToolCallMarkup(response.content));
  if (!review) {
    // One retry within the subtask's time budget, showing the model its
    // own unusable answer (the e2e ULTRA review failed here once).
    const retryCheck = canAffordRetry(input.deadlineAt, Date.now() - reviewStartedAt);
    await input.onEvent(
      "agent.context",
      {
        capability: subtask.capability,
        reason: "invalid-review-json",
        retry: retryCheck.ok,
        excerpt: stripToolCallMarkup(response.content).slice(0, 400),
      },
      "warn"
    );
    if (retryCheck.ok && !input.signal.aborted) {
      input.assertBudgetForCall?.();
      ({ result: response, servedBy } = await runLlmCallWithFallback(
        [servedBy],
        baseMessages(
          input,
          `${reviewPrompt}\n\nYour previous answer was not the review JSON object. Return ONLY {"verdict":...,"findings":[...]} now.\n\nPrevious answer (for reference):\n${stripToolCallMarkup(response.content).slice(0, 1500)}`
        ),
        { health: healthFor(input), signal: input.signal, timeoutMs: llmCallTimeoutMs(input), taskGate: input.llmTaskGate }
      ));
      await reportUsage();
      review = parseReview(stripToolCallMarkup(response.content));
    }
  }
  if (!review) {
    // An EMPTY answer (the e2e model returned 0 output tokens after ~5 min)
    // is a transient model failure, not a bad review: report it so the
    // scheduler retries the review node with a fresh time budget instead
    // of the runner replanning (and re-implementing) the whole task.
    if (stripToolCallMarkup(response.content).trim() === "") {
      return { status: "failed", error: EMPTY_MODEL_ANSWER_ERROR("review") };
    }
    return {
      status: "failed",
      error: "The review agent returned an unparseable review; refusing to proceed",
    };
  }

  // Findings as a proper markdown list (blank line before it) so the
  // chat renderer shows bullets instead of one run-on sentence. The
  // verdict itself is carried in the persisted output/meta for the
  // objective evaluation and resumed-state rebuild; the CTO's single
  // chat summary at completion reports it (no per-stage narration).
  const formatFindings = (findings: typeof review.findings) =>
    findings
      .map(
        (finding) =>
          `- **[${finding.severity}]** \`${finding.filePath}\` — ${finding.description}`
      )
      .join("\n");

  await input.onEvent("review.completed", {
    verdict: review.verdict,
    findings: review.findings,
    snapshotId,
  });

  if (review.verdict !== "approved") {
    return {
      status: "completed",
      output: `Review requested changes:\n\n${formatFindings(review.findings)}`,
      meta: { verdict: review.verdict, findings: review.findings, snapshotId },
    };
  }
  return {
    status: "completed",
    output: "Review approved.",
    meta: { verdict: review.verdict, findings: review.findings, snapshotId },
  };
}

async function executeQa(
  input: SubtaskExecutionInput
): Promise<SubtaskExecutionResult> {
  const visualRegression =
    input.plan.visualQa ??
    wantsVisualQa(input.command);
  const report = await runResponsiveQa(input.workspacePath, {
    baseUrl: input.qaBaseUrl,
    signal: input.signal,
    // Plan-level intent is authoritative (plan 011). The command heuristic
    // remains only for plans persisted before the field existed, so a
    // "no screenshots / no viewport testing" request can never fall through
    // to visual regression in the executor.
    visualRegression,
    onCheck: async (check) => {
      await input.onEvent(
        "task.check",
        { label: check.label, status: check.status, details: check.details },
        check.status === "failed" ? "error" : "info"
      );
    },
  });

  // Specific, not generic: name the URL that was actually checked, the
  // checks that ran, and the mode (structural vs visual regression).
  // The URL comes from the "application reachable" check's details (the
  // resolved base URL, including qa.ts's own fallback) because the
  // threaded qaBaseUrl may be unset when no project URL is configured.
  // The "QA verdict: <verdict>" prefix is load-bearing — buildStateFromDb
  // re-reads the verdict from this persisted output on resume.
  const passedCount = report.checks.filter((check) => check.status === "passed").length;
  const checked =
    report.checks.find((check) => check.label === "application reachable")?.details ??
    input.qaBaseUrl ??
    "the app";
  // Name what was asked and be explicit about what the deterministic
  // check actually covers, so a pass is never read as "the requested
  // behaviour was verified" (QA audit P1-8).
  const requested = (input.subtask.description || input.subtask.title || "").trim().slice(0, 400);
  const scopeNote = report.verdict === "blocked"
    ? ""
    : ` Executed checks cover only: page reachable, rendered with a visible body, no framework overlay, no console/page/network errors${
        visualRegression ? ", screenshot comparison" : ""
      }. The task-specific criteria were not asserted automatically.`;
  const summary = `QA verdict: ${report.verdict} — ${
    report.verdict === "blocked"
      ? `QA could not run: ${report.blockedReason ?? "environment problem"}`
      : `${passedCount}/${report.checks.length} checks ok on ${checked}: ${report.checks
          .map((check) => `${check.label}=${check.status}`)
          .join(", ")}${report.checks.length > 0 && !visualRegression ? ". No visual comparison — structural checks only" : ""}`
  }.${requested ? ` Requested: "${requested}".` : ""}${scopeNote}`;
  await input.onMessage(summary);

  if (report.verdict === "blocked") {
    // Environment, not code: completed node with a blocked verdict. The
    // QA loop reports it once and never routes it to an implementer fix.
    return {
      status: "completed",
      output: summary,
      meta: { verdict: report.verdict, checks: report.checks, blockedReason: report.blockedReason },
    };
  }
  if (report.verdict === "failed") {
    return {
      status: "failed",
      error: `QA failed: ${report.failures.join("; ")}`,
      // Plan 005 Step 5.2: keep the checks on the failure so the runner can
      // record the QA verdict and synthesize fix findings from them.
      meta: { verdict: report.verdict, checks: report.checks },
    };
  }
  if (report.verdict === "inconclusive") {
    // An inconclusive run is NOT a completed node: the QA verdict guard
    // (plan 011) requires an explicit pass, and the runner's QA loop
    // treats any non-pass verdict as failing. Surface it as failed
    // (with the verdict preserved in meta) so the scheduler and the
    // objective cannot read "inconclusive" as "done". The QA loop
    // synthesizes fix findings from the recorded inconclusive checks.
    return {
      status: "failed",
      error: `QA inconclusive: ${report.inconclusive.join("; ")}`,
      meta: { verdict: report.verdict, checks: report.checks },
    };
  }
  return {
    status: "completed",
    output: summary,
    meta: { verdict: report.verdict, checks: report.checks },
  };
}

async function executeReadOnly(
  input: SubtaskExecutionInput,
  mode: "audit" | "research" | "analysis"
): Promise<SubtaskExecutionResult> {
  const { workspacePath, command, agent, subtask } = input;
  const fileHint = extractFileHint(subtask.description);
  const { context } = await exploreRepository(workspacePath, {
    fileHint,
    maxFilesToRead: mode === "audit" ? 14 : 10,
  });
  await input.onEvent("agent.context", {
    capability: subtask.capability,
    filesHinted: fileHint ?? null,
  });

  if (input.signal.aborted) return { status: "failed", error: "Execution cancelled" };

  // Plan 006 Phase 5: dynamic tool discovery — wired for research/audit
  // first behind ORCHESTRATOR_TOOL_LOOP (default false). When enabled,
  // the agent's supportedTools scope is surfaced in the prompt; listing
  // is governed (tool_search) and secret args remain redacted.
  let toolLoopSection = "";
  if (
    (mode === "research" || mode === "audit") &&
    process.env.ORCHESTRATOR_TOOL_LOOP === "true"
  ) {
    const { tool_search } = await import("../governance/registry");
    const tools = tool_search({
      supportedTools: (input.agent as { supportedTools?: string[] }).supportedTools,
      query: "",
    });
    if (tools.length > 0) {
      toolLoopSection = `\n\nAvailable tools (search scope is your supportedTools): ${tools.map((t) => t.name).join(", ")}`;
    }
  }

  let instruction: string;
  if (mode === "audit") {
    instruction = [
      "Perform a read-only repository audit.",
      "Do not modify files and do not return file-change JSON.",
      "Report concrete findings with severity, file path, impact and a concise recommendation.",
      "If no issues are found, say so and summarize what you checked.",
      "Never claim a check passed unless the evidence is in the repository context.",
    ].join("\n");
  } else if (mode === "research") {
    instruction = [
      "Answer the user's question using only the repository context.",
      "Cite file paths for every claim.",
      "Do not modify files.",
      "If the context is insufficient, say exactly what is missing.",
    ].join("\n");
  } else {
    instruction = [
      "Respond to the user's message concisely.",
      "Do not modify files.",
      "If the user is greeting you, greet them and ask what change they want.",
    ].join("\n");
  }
  instruction +=
    '\nOptionally, end your reply with one single-line JSON object {"delegationRecommendation":{"targetCapability":"...","reason":"..."},"findings":["..."]} when another capability should follow up or you noticed concrete issues; omit it otherwise.';
  if (toolLoopSection) instruction += toolLoopSection;

  // Plan 009: MCP filesystem tools. When the runner seeded sessions and
  // the server yielded permitted tools, the agent uses them mid-task
  // (bounded loop, budget gate before every LLM step) instead of the
  // direct streaming path. A dead server or no permitted tools falls
  // through to the existing path unchanged.
  const mcpResult = await runMcpExploration(input, instruction, context);
  if (mcpResult) {
    const content = mcpResult.answer.trim() || "No findings from workspace tool exploration.";
    if (content) await input.onChunk(content);
    // Chat gets a sanitized excerpt only — never the raw answer with
    // its delegation JSON. Full output stays on the subtask row.
    await input.onMessage(sanitizeForChat(stripToolCallMarkup(content)));
    await input.onEvent("agent.mcp_tools", {
      capability: subtask.capability,
      toolCount: mcpResult.toolCount,
      toolCalls: mcpResult.toolCalls,
    });
    const delegation = parseDelegation(content);
    return {
      status: "completed",
      output: content,
      meta: {
        ...(delegation?.delegationRecommendation ? { delegationRecommendation: delegation.delegationRecommendation } : {}),
        ...(delegation?.findings ? { findings: delegation.findings } : {}),
      },
    };
  }

  const webContext = await buildWebContext(
    input.browser,
    `${subtask.title}\n${subtask.description}\n${command}`
  );
  if (webContext.fetched.length > 0 || webContext.failed.length > 0) {
    await input.onEvent("agent.web_context", {
      capability: subtask.capability,
      fetched: webContext.fetched,
      failed: webContext.failed,
    });
  }

  const handles = handlesFor(input);
  const health = healthFor(input);
  const messages = baseMessages(
    input,
    `${instruction}\n\nRepository context:\n${context}${webContext.block ? `\n\n${webContext.block}` : ""}\n\nUser request: ${command}`
  );
  // Pre-call budget gate (Phase 5): applies to the streaming path and
  // the fallback path alike — both make exactly one logical LLM call
  // from this point.
  input.assertBudgetForCall?.();
  let response: LLMResult;
  let servedModel = handles[0].config.model;
  // The handle that actually served the call (fallback can switch it);
  // its registry identity/pricing attributes the usage (Phase 5).
  let servedHandle: FallbackHandle = handles[0];
  const primary = handles[0];
  if (primary.provider.stream) {
    let chunkEmitted = false;
    try {
      // Streaming gate decision (Phase 4 hardening): the read-only
      // streaming path DOES pass through both LLM gates — it is an LLM
      // request like any other, and Phase 4's exemption let it bypass
      // the concurrency bound entirely. It keeps its own no-Effect
      // shape, though: streamed chunks cannot be replayed, so the
      // retry/fallback semantics stay the manual ones below instead of
      // runLlmCall's Effect retry. Only the slot acquisition is shared,
      // via runWithLlmGates.
      const stream = primary.provider.stream.bind(primary.provider);
      response = await runWithLlmGates(
        () =>
          stream(
            messages,
            async (delta) => {
              chunkEmitted = true;
              await input.onChunk(delta);
            },
            primary.config.model,
            { signal: input.signal, timeoutMs: llmCallTimeoutMs(input) }
          ),
        { signal: input.signal, taskGate: input.llmTaskGate }
      );
      health?.recordSuccess(primary.connectionId);
    } catch (error) {
      // A caller abort is not a provider failure and never falls back.
      if (input.signal.aborted) {
        throw error;
      }
      if (isTransientLlmError(error)) {
        health?.recordFailure(primary.connectionId, { transient: true });
      }
      // Fall back only when nothing was streamed yet — re-emitting partial
      // output from a second provider would corrupt the reply.
      if (chunkEmitted || !isTransientLlmError(error) || handles.length < 2) {
        throw error;
      }
      const fallback = await runLlmCallWithFallback(handles.slice(1), messages, {
        health,
        signal: input.signal,
        timeoutMs: llmCallTimeoutMs(input),
        taskGate: input.llmTaskGate,
      });
      response = fallback.result;
      servedModel = fallback.servedBy.config.model;
      servedHandle = fallback.servedBy;
      if (response.content) await input.onChunk(response.content);
    }
  } else {
    const { result, servedBy } = await runLlmCallWithFallback(handles, messages, {
      health,
      signal: input.signal,
      timeoutMs: llmCallTimeoutMs(input),
      taskGate: input.llmTaskGate,
    });
    response = result;
    servedModel = servedBy.config.model;
    servedHandle = servedBy;
  }
  if (input.onTokenUsage) {
    await input.onTokenUsage(
      response.inputTokens ?? 0,
      response.outputTokens ?? 0,
      servedModel,
      usageMetaFor(servedHandle, response.inputTokens ?? 0, response.outputTokens ?? 0)
    );
  }

  const content = response.content.trim();
  if (!content) {
    return { status: "failed", error: `The ${mode} agent returned an empty response` };
  }
  await input.onMessage(sanitizeForChat(stripToolCallMarkup(content)));
  const delegation = parseDelegation(content);
  return {
    status: "completed",
    output: content,
    meta: {
      ...(delegation?.delegationRecommendation ? { delegationRecommendation: delegation.delegationRecommendation } : {}),
      ...(delegation?.findings ? { findings: delegation.findings } : {}),
    },
  };
}

/**
 * Shell subtask ("ponytail" scope): the agent does NOT run commands itself.
 * It replies with {"command":"git","args":["pull"]} JSON and the worker
 * executes the allowlisted argv from the task workspace, so the LLM never
 * gets a free-form shell. Only `git pull` is wired — verify pass, then add
 * argv entries to the allowlist (daily limit 500 calls across tasks).
 */
async function executeShell(
  input: SubtaskExecutionInput
): Promise<SubtaskExecutionResult> {
  const { workspacePath, command, agent, subtask, signal, onEvent, onMessage } = input;
  await onEvent("agent.context", {
    capability: subtask.capability,
    mode: "shell (allowlisted)",
  });

  if (signal.aborted) return { status: "failed", error: "Execution cancelled" };

  const instruction = [
    "Reply with a single-line JSON object for the shell command to run:",
    '{"command":"<binary>","args":[<exact argv>]}',
    "",
    REGISTRY_LIST,
    "Rules:",
    "- Only run the command the user asked for. Prefer the narrowest variant.",
    "- If the user request needs a command outside the allowlist (including",
    "  file creation / write / printf / redirect), do NOT invent argv and",
    "  do NOT delegate to shell-execution (that is yourself — a loop).",
    "  Reply with a plain one-line explanation; the orchestrator will replan",
    "  as code_change.",
  ].join("\n");

  const handles = handlesFor(input);
  const health = healthFor(input);
  const messages = baseMessages(input, `${instruction}\n\nTask: ${command}`);
  const { result: response } = await runLlmCallWithFallback(handles, messages, {
    health,
    signal,
    timeoutMs: llmCallTimeoutMs(input),
    taskGate: input.llmTaskGate,
  });
  const parsed = parseShellCommand(response.content);
  if (!parsed) {
    return {
      status: "failed",
      error: "Shell agent did not return a valid command JSON",
    };
  }
  // The raw shell-command JSON must never reach chat; narrate the human
  // command line instead (the result summary below follows on completion).
  await input.onMessage(`$ ${parsed.command} ${parsed.args.join(" ")}`);
  if (!isCommandAllowed(parsed.command, parsed.args)) {
    return {
      status: "failed",
      error: `Command blocked (not allowlisted): ${parsed.command} ${parsed.args.join(" ")}`,
    };
  }

  await onEvent("shell.command", {
    command: parsed.command,
    args: parsed.args,
    cwd: workspacePath,
  }, "info");
  const result = await runCommand(workspacePath, parsed.command, parsed.args, {
    signal,
  });
  const summary = [
    `$ ${parsed.command} ${parsed.args.join(" ")}`,
    result.stdout ? `\n${result.stdout.trimEnd()}` : "",
    result.stderr ? `\n${result.stderr.trimEnd()}` : "",
  ]
    .filter(Boolean)
    .join("");
  await onMessage(summary);

  return {
    status: "completed",
    output: summary,
  };
}

const REGISTRY_LIST = [
  "Allowlisted commands:",
  "git status, git status --short, git status -sb, git branch --show-current,",
  "git diff, git diff --no-color, git diff --stat, git log --oneline -n 20,",
  "git fetch, git pull, git pull --ff-only, git pull --rebase",
].join("\n");

function parseShellCommand(content: string): { command: string; args: string[] } | null {
  const normalized = content.replace(/```json|```/g, "").trim();
  const match = normalized.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { command?: unknown; args?: unknown };
    if (!Array.isArray(parsed.args)) return null;
    const command = typeof parsed.command === "string" ? parsed.command.trim() : "";
    const args = parsed.args.filter((a): a is string => typeof a === "string");
    if (!command) return null;
    if (args.length !== parsed.args.length) return null;
    return { command, args };
  } catch {
    return null;
  }
}

const FORBIDDEN_PATHS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.git\//i,
  /(^|\/)node_modules\//i,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i,
  /(^|\/)\.ssh(\/|$)/i,
];

/**
 * Fetch referenced URLs through the shared Stagehand browser and render them
 * as a compact "Web context" block for read-only agents.
 * ponytail: 3 URLs / 8k chars each; raise limits or page-range follow the
 * links if a research task needs deeper crawling.
 */
async function buildWebContext(
  browser: WebClient | undefined,
  text: string
): Promise<{ block: string; fetched: string[]; failed: string[] }> {
  const urls = extractUrls(text).slice(0, 3);
  if (!browser || urls.length === 0) return { block: "", fetched: [], failed: [] };

  const fetched: string[] = [];
  const failed: string[] = [];
  const pages = await Promise.allSettled(
    urls.map(async (url) => {
      const result = await browser.fetch(url);
      return {
        url: result.url,
        title: result.title,
        content: result.content.replace(/\s+/g, " ").trim().slice(0, 8000),
      };
    })
  );

  const sections: string[] = [];
  pages.forEach((page, index) => {
    const target = urls[index];
    if (page.status === "fulfilled") {
      fetched.push(target);
      sections.push(
        `### ${page.value.title || page.value.url}\n${page.value.url}\n${page.value.content}`
      );
    } else {
      failed.push(target);
    }
  });

  if (sections.length === 0) return { block: "", fetched, failed };
  return {
    block: `Web context (live browser fetch):\n${sections.join("\n\n")}`,
    fetched,
    failed,
  };
}

export function isForbiddenPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return FORBIDDEN_PATHS.some((pattern) => pattern.test(normalized));
}


/** Current HEAD sha, or null when the workspace is not a git repo. */
async function readGitHead(workspacePath: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const { stdout } = await runCommand(workspacePath, "git", ["rev-parse", "HEAD"], { signal });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
