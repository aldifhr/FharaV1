import { markProgress } from "@/effects/observationContext";
import { createProviderForAgent, getGlobalLLMConfig, type GlobalLLMConfig, type LLMResult } from "@/llm";
import {
  isTransientLlmError,
  runLlmCallWithFallback,
  runWithLlmGates,
  usageMetaFor,
  nativeUsageMeta,
  withUsageEstimate,
  type FallbackHandle,
  type LlmConcurrencyGate,
} from "@/effects/llmCall";
import type { LLMMessage, SubtaskTokenUsageFn } from "@/types/llm";
import {
  buildRepairPrompt,
  codeChangeExplorationInstruction,
  codeChangePrompt,
  codeChangeFileRequestPrompt,
  codeChangeRetryPrompt,
  editFallbackPrompt,
  mcpFindingsBlock,
  REPAIR_SYSTEM_PROMPT,
} from "@/prompts/codeChange";
import { buildReviewPrompt, reviewRetryPrompt } from "@/prompts/review";
import {
  explorationUserContent,
  readOnlyInstruction,
  readOnlyUserContent,
  toolLoopSectionFor,
} from "@/prompts/readOnly";
import { parseShellReply, shellInstruction, shellRepairContent, shellUserContent } from "@/prompts/shell";

// Prompt text lives in `@/prompts`; re-exported for existing importers.
export { buildRepairPrompt } from "@/prompts/codeChange";
import type { EventSink } from "@/types/events";
import { providerHealth } from "@/llm/health";
import { isBudgetExhaustedError } from "@/utils/budgetError";
import type { AgentDefinition, ExecutionPlan, PlanSubtask } from "@/types";
import {
  buildAgentExecutionContext,
  formatAgentContextForPrompt,
  formatSiblingsSection,
  type SiblingSubtask,
} from "./agentContext";
import {
  runNativeProvider,
  buildNativePrompt,
  isNativeProviderAvailable,
  type SpawnImpl,
} from "./nativeProvider";
import type { SharedTaskContext } from "@/types";
import { extractFileHint, parseDelegation, parseReview, sanitizeForChat, type DraftFile } from "@/utils/json";
import { classifyToolCalls, parseToolCallMarkup, stripToolCallMarkup } from "@/utils/toolCallMarkup";
import { diagnoseDraftParse, parseDraftLenient, type DraftFormat } from "@/utils/draftLenient";
import { tmpdir } from "node:os";
import { maskStringSecrets, validateFilePath } from "@/governance/tools";
import { recordLlmSnapshot, withSnapshotScope } from "@/llm/snapshots";
import { isPathWithinOwnership } from "@/utils/ownershipPaths";
import { scopeRetryFeedback, scopeViolations } from "@/execution/scopeGuard";
import { newSyntaxErrors, syntaxRetryFeedback, syntaxWarning, type SyntaxIssue } from "@/execution/editGuards";
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
import { canWriteAny, permissionsForAgent, resolveRoleKey, shellDenial, writeDenial } from "@/utils/rolePolicy";
import { buildOpencodePolicy } from "./opencodePolicy";
import { toolLoopEnabled } from "./toolLoopFlag";
import { dangerousCommandReason } from "@/api/convex/lib/commandRules";
import { commandDeniedOutput, shellGuardDecisionForArgv, shellGuardOutput, type CommandApprovalOutcome } from "@/execution/commandGate";
import { resolveSandboxPathAsync } from "@/tools/sandbox";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import { promisify } from "node:util";
import { extractUrls, type WebClient } from "@/tools/webClient";
import { exploreRepository } from "./repositoryContext";
import { preloadOnDemandSkills } from "./skillLoading";
import { contentReader, detectEscalation, escalatedError, escalationFromAnswer } from "./escalation";
import { MAX_EDIT_REFLECTIONS, failedEditPaths, resolveEditAnswer, type EditWorkingSet } from "./editAnswer";
import { editFailureFeedback, type EditFailure } from "@/utils/editBlocks";
import type { Escalation } from "@/api/convex/lib/subtaskContract";
import { runResponsiveQa } from "./qa";
import { wantsVisualQa } from "@/utils/qaIntent";
import { getMcpRegistry, sessionAllowedForRole, type McpHooks, type McpRunConfig } from "@/mcp/registry";
import { runMcpToolLoop } from "@/mcp/toolLoop";
import type { McpToolDefinition } from "@/mcp/types";
import { runToolLoop } from "@/tools/toolLoop";
import { webReachToolLoopPromptSet } from "@/prompts/webReach";
import { SHOW_OPTIONS_TOOL, SHOW_OPTIONS_TOOL_NAME } from "@/review/showOptions";
import { DESIGN_LOOKUP_TOOL, DESIGN_LOOKUP_TOOL_NAME, designLookup } from "@/design/designLookup";
import { optionsInstruction } from "@/prompts/options";
import {
  agentAllowsWebReach,
  runWebReachTool,
  WEB_REACH_TOOL,
  WEB_REACH_TOOL_NAME,
  type WebReachConfig,
} from "./webReachTools";
import { turnMessages } from "./turnContext";

const execFileAsync = promisify(execFile);

export interface SubtaskExecutionInput {
  workspacePath: string;
  command: string;
  /**
   * Plan 022: escalations the CTO / the user already allowed for this run
   * (kind + detail); the deterministic guard does not stop on them again.
   */
  allowedEscalations?: Array<{ kind: string; detail?: string }>;
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
  /**
   * Other subtasks of this task running or queued when this one starts
   * (rendered as the "Running alongside you" section).
   */
  siblings?: SiblingSubtask[];
  /**
   * Delivery ack for user steer/answer inputs: called with the taskInputs
   * ids a built prompt actually rendered (single input guard).
   */
  onUserInputsRendered?: (inputIds: string[]) => void;
  priorOutputs: Map<string, string>;
  fileChanges: FileDiff[];
  signal: AbortSignal;
  /**
   * Epoch ms at which the scheduler's subtask timeout fires. Every LLM call
   * is bounded by the time left until then, and a retry that cannot fit in
   * it is skipped instead of being started and killed mid-flight.
   */
  deadlineAt?: number;
  onEvent: EventSink;
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
  onTokenUsage?: SubtaskTokenUsageFn;
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
  mcp?: Pick<McpRunConfig, "sessions"> & Partial<McpRunConfig>;
  /**
   * Plan 036: the Agent Reach web tool for read-only agents. Absent means
   * "no web tool" (the policy disabled it, or the runner did not build it).
   * The agent must also declare `web_reach` in its `supportedTools`.
   */
  webReach?: WebReachConfig;
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
   * Unset: OpenCode is pointed at this subtask's resolved Fhara LLM.
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
  /**
   * Chat UX: approval gate for an agent-initiated command, checked AFTER
   * the exact-argv allowlist (a hard deny) and BEFORE it runs. The runner
   * waits in-process (lease kept). Absent: legacy callers run the
   * allowlisted command without asking.
   */
  requestCommandApproval?: (command: { command: string; args: string[] }) => Promise<CommandApprovalOutcome>;
  /**
   * Options review (show_options): store the options, wait for the user's
   * picks and return them as the tool result. Offered only to roles whose
   * permissions allow `options`. Absent: no tool.
   */
  showOptions?: (args: Record<string, unknown>) => Promise<{ ok: boolean; text: string; isError: boolean }>;
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
    // Plan 040: MCP writes only for roles that may write anywhere in
    // scope; a path-scoped role (DevOps) stays on the gated diff path.
    allowWrite: input.mcp?.writeTools === true && permissionsForAgent(input.agent).write === true,
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
  const scope = mcpScope(input);
  // A run carries global + project servers; each agent only sees the ones
  // whose `agentRoles` allowlist admits its role.
  const sessions = (input.mcp?.sessions ?? []).filter((session) => sessionAllowedForRole(session, scope.role));
  if (sessions.length === 0) return null;

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
    explorationUserContent(instruction, context, input.command)
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
          usageMetaFor(servedBy, llmResult)
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

/**
 * Plan 036: run the bounded Agent Reach tool loop for this subtask.
 *
 * Returns null when the tool is not configured, when the agent did not
 * declare `web_reach` in its `supportedTools`, or when the mode is not
 * research / audit — the tool is read-only research aid, never part of a
 * code change.
 *
 * The loop runs one LLM step per iteration through the normal provider
 * chain, so the pre-call budget gate and both LLM concurrency gates apply
 * exactly as they do to a direct call.
 */
async function runWebReachExploration(
  input: SubtaskExecutionInput,
  instruction: string,
  context: string
): Promise<{ answer: string; toolCalls: number } | null> {
  const config = input.webReach;
  if (!config) return null;
  if (!agentAllowsWebReach(input.agent.supportedTools)) return null;
  if (!permissionsForAgent(input.agent).web) return null;

  const handles = handlesFor(input);
  const health = healthFor(input);
  const messages = baseMessages(
    input,
    readOnlyUserContent({ instruction, context, command: input.command })
  );

  const result = await runToolLoop({
    tools: [WEB_REACH_TOOL],
    maxIterations: config.maxIterations,
    signal: input.signal,
    messages,
    prompt: webReachToolLoopPromptSet,
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
          usageMetaFor(servedBy, llmResult)
        );
      }
      return llmResult.content;
    },
    callTool: async ({ tool, args }) => {
      if (tool !== WEB_REACH_TOOL_NAME) {
        return { ok: false, text: `Unknown tool "${tool}"`, isError: true };
      }
      const outcome = await runWebReachTool(args, { config, signal: input.signal });
      await input.onEvent(
        "tool.web_reach",
        { capability: input.subtask.capability, tool, ok: outcome.ok },
        outcome.ok ? "info" : "warn"
      );
      return outcome;
    },
  });

  return { answer: result.answer, toolCalls: result.toolCalls };
}

/** Most tool-loop steps a show_options subtask may take. */
const OPTIONS_LOOP_MAX_ITERATIONS = 8;

/** Whether this subtask gets the show_options tool. */
export function optionsToolAvailable(input: Pick<SubtaskExecutionInput, "showOptions" | "agent">): boolean {
  return Boolean(input.showOptions) && permissionsForAgent(input.agent).options === true;
}

/** design_lookup goes with the Designer (and any agent with the ui-ux-design capability). */
function designLookupAvailable(agent: SubtaskExecutionInput["agent"]): boolean {
  return resolveRoleKey(agent.role ?? "") === "designer" || (agent.capabilities ?? []).includes("ui-ux-design");
}

/**
 * Options review: a bounded tool loop with show_options (and design_lookup
 * for design work). show_options waits for the user's answer inside the
 * tool call, so the agent's next step reads the picks and writes the
 * final result for them. One review per subtask.
 */
async function runOptionsExploration(
  input: SubtaskExecutionInput,
  instruction: string,
  context: string
): Promise<{ answer: string; toolCalls: number; reviewed: boolean } | null> {
  if (!optionsToolAvailable(input)) return null;
  const handles = handlesFor(input);
  const health = healthFor(input);
  const tools = [SHOW_OPTIONS_TOOL, ...(designLookupAvailable(input.agent) ? [DESIGN_LOOKUP_TOOL] : [])];
  const required = /\bshow_options\b/i.test(`${input.subtask.title}\n${input.subtask.description}\n${input.subtask.deliverable ?? ""}`);
  const messages = baseMessages(
    input,
    readOnlyUserContent({ instruction: `${instruction}\n\n${optionsInstruction({ required, designLookup: tools.length > 1 })}`, context, command: input.command })
  );
  let reviewed = false;
  const result = await runToolLoop({
    tools,
    maxIterations: OPTIONS_LOOP_MAX_ITERATIONS,
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
        await input.onTokenUsage(llmResult.inputTokens ?? 0, llmResult.outputTokens ?? 0, servedBy.config.model, usageMetaFor(servedBy, llmResult));
      }
      return llmResult.content;
    },
    callTool: async ({ tool, args }) => {
      if (tool === DESIGN_LOOKUP_TOOL_NAME && tools.length > 1) return designLookup(args);
      if (tool !== SHOW_OPTIONS_TOOL_NAME) return { ok: false, text: `Unknown tool "${tool}"`, isError: true };
      if (reviewed) return { ok: false, isError: true, text: "This subtask already had its review; write your result from the answer you got." };
      const outcome = await input.showOptions!(args);
      if (outcome.ok) reviewed = true;
      await input.onEvent(
        "tool.show_options",
        { capability: input.subtask.capability, ok: outcome.ok, role: input.agent.role },
        outcome.ok ? "info" : "warn"
      );
      return outcome;
    },
  });
  return { answer: result.answer, toolCalls: result.toolCalls, reviewed };
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
    "Files already changed by earlier subtasks of this task (NOT on disk yet). This is their CURRENT content: build on it and keep those changes; SEARCH/REPLACE blocks for these files must match this content (or return the full updated file):",
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
  // `@` admits scoped packages (node_modules/@scope/pkg/dist/index.d.ts):
  // the implement prompt asks for library type definitions by path.
  for (const match of answer.matchAll(/(?:^|[\s`"'(])((?:[\w.@-]+\/)*[\w.-]+\.(?:[jt]sx?|mjs|cjs|css|scss|html?|json|md|vue|svelte))(?=$|[\s`"'),:;])/g)) candidates.add(match[1]);
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
  /** Which format the draft came from (null when none parsed). */
  format: DraftFormat | "tool-calls" | null;
} {
  const markup = parseToolCallMarkup(content);
  const { files, readPaths } = classifyToolCalls(markup.calls);
  // Strict JSON first, then the lenient fallbacks (file blocks, repaired
  // JSON): a slow model's large answer often breaks on JSON escaping.
  let parsed = parseDraftLenient(markup.hadMarkup ? markup.stripped : content);
  if (!parsed.draft && markup.hadMarkup) parsed = parseDraftLenient(content);
  let draft = parsed.draft;
  let format: DraftFormat | "tool-calls" | null = parsed.format;
  if (draft && files.length > 0) {
    const byPath = new Map(draft.files.map((file) => [file.filePath, file]));
    for (const file of files) if (!byPath.has(file.filePath)) byPath.set(file.filePath, file);
    draft = { files: Array.from(byPath.values()) };
  } else if (!draft && files.length > 0) {
    draft = { files };
    format = "tool-calls";
  }
  return { draft, readPaths, hadMarkup: markup.hadMarkup, format };
}

/** Scrubbed head of an unparseable answer, for the task events. */
export function invalidAnswerEvent(content: string): { parseError: string; answerChars: number; answerHead: string } {
  return {
    parseError: diagnoseDraftParse(content),
    answerChars: content.length,
    answerHead: maskStringSecrets(content.slice(0, 2048)),
  };
}

/** git merge-file -p base/ours/theirs: merged text, or null on conflict/error. */
export async function mergeThreeWay(base: string, ours: string, theirs: string): Promise<string | null> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "fhara-merge-"));
  try {
    const [b, o, t] = ["base", "ours", "theirs"].map((name) => path.join(dir, name));
    await Promise.all([fs.writeFile(b, base), fs.writeFile(o, ours), fs.writeFile(t, theirs)]);
    try {
      const { stdout } = await execFileAsync("git", ["merge-file", "-p", o, b, t], {
        env: buildChildEnv(),
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

/** Time a full code_change retry needs, as a multiple of the first call. */
export const FULL_RETRY_TIME_FACTOR = 1.5;

/**
 * The paths of an answer that is ONLY a list of files ("src/proxy.ts\n
 * src/app/layout.tsx", bullets/backticks allowed): the model asking to
 * read them (the prompt allows replying with paths). Null for anything else.
 */
export function bareFileListPaths(answer: string): string[] | null {
  const lines = answer
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, "").replace(/^`+|`+$/g, "").trim())
    .filter(Boolean);
  if (lines.length === 0 || lines.length > 20) return null;
  const paths: string[] = [];
  for (const line of lines) {
    if (!/^(?:\.\/)?(?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z0-9]{1,6}$/.test(line)) return null;
    const rel = line.replace(/^\.\//, "");
    if (rel.split("/").includes("..")) return null;
    if (!paths.includes(rel)) paths.push(rel);
  }
  return paths;
}

/**
 * Whether a second LLM call fits before the subtask deadline: it needs at
 * least FULL_RETRY_TIME_FACTOR × the first call's duration and never less
 * than MIN_RETRY_WINDOW_MS. Without a deadline a retry is always allowed.
 */
export function canAffordRetry(
  deadlineAt: number | undefined,
  previousCallMs: number,
  now = Date.now()
): { ok: boolean; remainingMs: number } {
  if (deadlineAt === undefined) return { ok: true, remainingMs: Number.POSITIVE_INFINITY };
  const remainingMs = Math.max(0, deadlineAt - now - DEADLINE_MARGIN_MS);
  // A full retry resends the whole payload: it needs about as long as the
  // first call, so start one only with ~1.5× that left (a 1.25× margin ran
  // past the 300 s subtask timeout on a slow model and forced a replan).
  const needed = Math.max(MIN_RETRY_WINDOW_MS, Math.ceil(previousCallMs * FULL_RETRY_TIME_FACTOR));
  return { ok: remainingMs >= needed, remainingMs };
}

/**
 * Skill v2: an on_demand agent first gets the read-only load_skill tool
 * (execution/skillLoading.ts); the skills it loads are appended to its
 * system prompt for the rest of this subtask. Best effort: a failed loop
 * leaves the index-only prompt. Budget exhaustion still propagates.
 */
async function withOnDemandSkills(input: SubtaskExecutionInput): Promise<SubtaskExecutionInput> {
  const skills = input.agent.onDemandSkills;
  if (!skills?.length) return input;
  const handles = handlesFor(input);
  try {
    const preload = await preloadOnDemandSkills({
      systemPrompt: input.agent.systemPrompt,
      skills,
      assignment: [`${input.subtask.title} — ${input.subtask.description}`, `Task: ${input.command}`].join("\n"),
      call: async (messages) => {
        input.assertBudgetForCall?.();
        const { result, servedBy } = await runLlmCallWithFallback(handles, messages, {
          health: healthFor(input),
          signal: input.signal,
          timeoutMs: llmCallTimeoutMs(input),
          taskGate: input.llmTaskGate,
        });
        if (input.onTokenUsage) {
          await input.onTokenUsage(
            result.inputTokens ?? 0,
            result.outputTokens ?? 0,
            servedBy.config.model,
            usageMetaFor(servedBy, result)
          );
        }
        return result.content;
      },
    });
    await input.onEvent("agent.skills_loaded", {
      capability: input.subtask.capability,
      loaded: preload.loaded,
      loads: preload.loads,
      llmCalls: preload.llmCalls,
      ...(preload.failed.length ? { failed: preload.failed.map((f) => f.name).slice(0, 8) } : {}),
    });
    if (preload.systemPrompt === input.agent.systemPrompt) return input;
    return { ...input, agent: { ...input.agent, systemPrompt: preload.systemPrompt } };
  } catch (error) {
    if (isBudgetExhaustedError(error) || input.signal.aborted) throw error;
    await input.onEvent(
      "agent.skills_loaded",
      { capability: input.subtask.capability, error: error instanceof Error ? error.message.slice(0, 200) : "load failed" },
      "warn"
    );
    return input;
  }
}

export async function executeSubtask(
  rawInput: SubtaskExecutionInput
): Promise<SubtaskExecutionResult> {
  const { subtask } = rawInput;
  if (rawInput.signal.aborted) {
    return { status: "failed", error: "Execution cancelled" };
  }

  // Context Snapshot: what this subtask's LLM calls are for.
  const callRole = subtask.kind === "review" ? "reviewer" : subtask.kind === "qa" ? "qa" : "executor";
  return await withSnapshotScope(
    { callRole, subtaskKey: subtask.key, agentId: rawInput.agent._id, agentRole: rawInput.agent.role },
    () => executeSubtaskScoped(rawInput)
  );
}

async function executeSubtaskScoped(rawInput: SubtaskExecutionInput): Promise<SubtaskExecutionResult> {
  const { subtask } = rawInput;
  try {
    // Plan 040: the role's permissions are enforced here, before any LLM
    // call or runtime, whatever the agent's prompt or declared tools say.
    const refused = roleRefusal(rawInput);
    if (refused) {
      await rawInput.onEvent(
        "agent.permission_denied",
        { capability: subtask.capability, role: rawInput.agent.role, kind: subtask.kind, reason: refused },
        "warn"
      );
      return { status: "failed", error: `Refused: ${refused}` };
    }
    const input = await withOnDemandSkills(rawInput);
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
 * O1 (jockey no-fallback rule, MIT, ported; see opencodeHome.ts): why a
 * bound provider connection cannot run, or null. A connection with an
 * empty key is only fine when it points at a local endpoint.
 */
export function boundKeyProblem(handle: { connectionName: string; config: { apiKey: string; baseUrl: string } } | undefined): string | null {
  if (!handle) return null;
  if (handle.config.apiKey?.trim()) return null;
  let host = "";
  try {
    host = new URL(handle.config.baseUrl).hostname;
  } catch {}
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return null;
  return `provider key unreadable for "${handle.connectionName}": the connection this agent is bound to has no usable key. Fhara will not fall back to another provider key; re-save the key in Settings.`;
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
  const { context } = await exploreRepository(workspacePath, { fileHint, query: `${subtask.description}\n${command}`, mentionedFiles: subtask.allowedPaths });
  await onEvent("native.context", {
    capability: subtask.capability,
    mode: "native-provider",
  });

  if (signal.aborted) return { status: "failed", error: "Execution cancelled" };

  const prior = priorContextFor(input);

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
  // same LLM the rest of Fhara resolved for this agent (first handle of
  // the resolver chain, else the task/global config).
  const handle = input.llmHandles?.[0];
  // O1 (jockey rule): a bound provider whose key is missing or unreadable
  // fails the run. It never falls through to the task/global config, which
  // would run (and bill) another account.
  const keyProblem = input.nativeModel?.trim() ? null : boundKeyProblem(handle);
  if (keyProblem) {
    await onEvent("native.credential.missing", { capability: subtask.capability, connection: handle?.connectionName, reason: keyProblem }, "error");
    return { status: "failed", error: keyProblem };
  }
  const llm = handle?.config ?? input.llmConfig ?? getGlobalLLMConfig();
  // O1: per-run, deny-by-default OpenCode permissions from the role and
  // the subtask's ownership scope. The staging gate below stays the
  // second line.
  const policy = buildOpencodePolicy({
    permissions: permissionsForAgent(agent),
    allowedPaths: subtask.allowedPaths,
    mutating: subtask.kind === "code_change" || subtask.kind === "shell",
    roleKey: resolveRoleKey(agent.role ?? ""),
  });
  const result = await runNativeProvider({
    policy,
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
    await input.onTokenUsage(result.inputTokens, result.outputTokens, result.model ?? "native-provider", nativeUsageMeta(result));
  }

  // Staging gate: stage what the provider changed in scope so the
  // verification and approval flows still review it; revert everything
  // out of scope (forbidden paths, invalid paths, outside allowedPaths, or
  // any write from a read-only kind) so it can never reach a commit.
  const mutating = subtask.kind === "code_change" || subtask.kind === "shell";
  const nativePermissions = permissionsForAgent(agent);
  const nativeRoleLabel = (agent.role ?? "").trim() || "agent";
  const prepared: { filePath: string }[] = [];
  const rejected: { filePath: string; reason: string }[] = [];
  // Live test 3: files OpenCode wrote before its run failed or timed out
  // had no fileChanges rows (left in the worktree, invisible in the UI).
  // The worktree is diffed against its base after EVERY run, completed or
  // not; a failed run diffs without the (possibly aborted) node signal.
  const stageWorkspaceChanges = async (stageSignal?: AbortSignal): Promise<"cancelled" | void> => {
    let changedPaths: string[] = [];
    try {
      changedPaths = await listWorkspaceChanges(workspacePath, stageSignal);
    } catch {
      // Workspace may not be a git repo; the provider's own output stands.
    }
    for (const filePath of changedPaths) {
      if (stageSignal?.aborted) return "cancelled";
      let resolved: string;
      try {
        resolved = await resolveSandboxPathAsync(workspacePath, filePath);
      } catch {
        continue;
      }
      const newContent = await readIfExistsUtf8(resolved);
      // A file an earlier attempt already staged keeps that change's base
      // (its pre-task content), so a retry never re-bases the diff on the
      // partial output of the failed attempt.
      const staged = input.getStagedChange?.(filePath) ?? input.fileChanges.find((change) => change.filePath === filePath);
      const baseline = staged
        ? staged.changeType === "new"
          ? undefined
          : staged.oldContent
        : preRunDirty.has(filePath)
          ? preRunDirty.get(filePath) ?? undefined
          : await readHeadContent(workspacePath, filePath);
      // Dirty before the run and untouched by the provider: not its change.
      if ((baseline ?? null) === newContent) continue;
      const roleDenied = mutating ? writeDenial(nativeRoleLabel, nativePermissions, filePath) : null;
      const reason = !mutating
        ? `read-only ${subtask.kind} subtask`
        : roleDenied
          ? roleDenied
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
  };

  if (result.status !== "completed") {
    // Record what the failed run left in the worktree, then fail.
    await stageWorkspaceChanges().catch(() => undefined);
    if (prepared.length > 0) {
      await onEvent("native.partial_changes", { files: prepared.map((c) => c.filePath).slice(0, 50) }, "warn");
    }
    const staged = prepared.length > 0 ? `\nStaged ${prepared.length} file change(s) the run left: ${prepared.map((c) => c.filePath).join(", ")}` : "";
    return { status: "failed", error: `${result.output || "Native provider run failed"}${staged}` };
  }
  if ((await stageWorkspaceChanges(signal)) === "cancelled") return { status: "failed", error: "Execution cancelled" };

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
    env: buildChildEnv(),
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

/**
 * What earlier work this subtask sees. Prefer the curated shared context
 * (relevant summaries, open issues, artifacts, recent decisions) over a raw
 * dump of every previous output. Full outputs remain recorded in the
 * executions table. The raw dump is only a fallback for callers without a
 * shared context (e.g. resumeTask). Shared by the API and native runtimes.
 */
export function priorContextFor(input: SubtaskExecutionInput): string {
  if (input.taskContext) {
    const curated = buildAgentExecutionContext({
      taskContext: input.taskContext,
      agent: input.agent,
      assignment: `${input.subtask.title} — ${input.subtask.description}`,
      siblings: input.siblings,
    });
    const rendered = `Shared task context:\n${formatAgentContextForPrompt(curated)}`;
    // Delivery ack (single input guard): the user's steer/answer text is in
    // this prompt now, so it is delivered — not before.
    if (curated.userInputIds && curated.userInputIds.length > 0) {
      input.onUserInputsRendered?.(curated.userInputIds);
    }
    return rendered;
  }
  if (input.priorOutputs.size > 0) {
    const raw = Array.from(input.priorOutputs.entries())
      .map(([key, value]) => `### ${key}\n${value.slice(0, 4000)}`)
      .join("\n\n");
    const siblings = formatSiblingsSection(input.siblings);
    return `Previous subtask outputs:\n${raw}${siblings ? `\n\n${siblings}` : ""}`;
  }
  return formatSiblingsSection(input.siblings);
}

function baseMessages(input: SubtaskExecutionInput, userContent: string) {
  const { agent } = input;
  const prior = priorContextFor(input);
  // D4/D5: persona, then the instruction chain and the call's content, the time line last.
  return turnMessages(agent.systemPrompt, input.workspacePath, input.subtask.allowedPaths, [prior, userContent]);
}

/**
 * Plan 022: the escalated result. A failed outcome (permanent: the error
 * starts with "Escalated (") carrying the escalation in meta; the runner
 * routes it to the CTO / the user instead of retrying or replanning blindly.
 */
async function escalateOutcome(input: SubtaskExecutionInput, escalation: Escalation): Promise<SubtaskExecutionResult> {
  await input.onEvent(
    "agent.escalation",
    { capability: input.subtask.capability, kind: escalation.kind, source: escalation.source ?? "executor" },
    "warn"
  );
  return {
    status: "failed",
    error: escalatedError(escalation),
    meta: { escalation },
  };
}

/**
 * Plan 040: why this agent may not run this subtask kind at all, or null.
 * A code_change needs some write permission, a shell node some shell
 * permission. Read-only kinds (analysis/audit/research/review/qa) are open
 * to every role; their writes are refused by construction.
 */
export function roleRefusal(input: Pick<SubtaskExecutionInput, "agent" | "subtask">): string | null {
  const permissions = permissionsForAgent(input.agent);
  const label = (input.agent.role ?? "").trim() || "agent";
  if (input.subtask.kind === "code_change" && !canWriteAny(permissions)) {
    return `the ${label} role is read-only and cannot modify files`;
  }
  if (input.subtask.kind === "shell" && permissions.shell === "none") {
    return `the ${label} role may not run commands`;
  }
  return null;
}

async function executeCodeChange(
  input: SubtaskExecutionInput
): Promise<SubtaskExecutionResult> {
  const { workspacePath, command, subtask, onEvent, onMessage, signal } = input;
  const permissions = permissionsForAgent(input.agent);
  const roleLabel = (input.agent.role ?? "").trim() || "agent";
  if (!canWriteAny(permissions)) {
    return {
      status: "failed",
      error: `Refusing to modify files: the ${roleLabel} role is read-only`,
    };
  }
  const fileHint = extractFileHint(`${subtask.description}\n${command}`);
  const { context } = await exploreRepository(workspacePath, { fileHint, query: `${subtask.description}\n${command}`, mentionedFiles: subtask.allowedPaths });
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
      codeChangeExplorationInstruction(subtask),
      context
    );
    if (explored && explored.toolCalls > 0) {
      mcpFindings = mcpFindingsBlock(explored.answer);
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
  const basePayload = codeChangePrompt({
    command,
    subtask,
    context,
    staged,
    qaMode: input.qaMode,
    mcpFindings,
  });

  // R2: SEARCH/REPLACE blocks (Format C) resolve against the current
  // content (a staged edit of an earlier subtask, else disk) into the same
  // full-content draft the other formats give; nothing below changes.
  const readForEdits = contentReader(workspacePath, (filePath) => input.getStagedChange?.(filePath) ?? input.fileChanges.find((change) => change.filePath === filePath));
  const editPaths = input.fileChanges.map((change) => change.filePath);
  let editWorking: EditWorkingSet | undefined;
  let editFailures: EditFailure[] = [];
  let editApplied = 0;
  let editAnswerText = "";
  const parseAnswer = async (content: string, mode: "fresh" | "continue" = "fresh") => {
    const parsed = parseCodeChangeAnswer(content);
    const stripped = stripToolCallMarkup(content);
    const edits = await resolveEditAnswer(stripped, readForEdits, {
      validPaths: editPaths,
      start: mode === "continue" ? editWorking : undefined,
    });
    if (!edits.used) {
      if (mode === "fresh") editFailures = [];
      return parsed;
    }
    if (mode === "fresh") editApplied = 0;
    editWorking = edits.working;
    editFailures = edits.failures;
    editApplied += edits.appliedCount;
    editAnswerText = stripped;
    return { ...parsed, draft: { files: edits.files }, format: "edit-blocks" as const };
  };

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
      usageMetaFor(servedBy, response)
    );
  }

  const firstCallMs = Date.now() - firstCallStartedAt;
  // Plan 022: an executor that met a decision it must not take alone
  // (schema change, new dependency, security choice, file outside scope,
  // ambiguous requirement) stops here — nothing is staged.
  {
    const asked = escalationFromAnswer(stripToolCallMarkup(response.content));
    if (asked) return await escalateOutcome(input, asked);
  }
  let parsedAnswer = await parseAnswer(response.content);
  let draft = parsedAnswer.draft;
  // A bare list of file paths is a request to read them, not an invalid
  // answer (live sandbox run: "src/proxy.ts\nsrc/app/layout.tsx" failed as
  // invalid-file-changes-json, then a full retry ran past the timeout).
  // Load those files and ask once for the edit; no repair round after it.
  const fileRequest = !draft && !parsedAnswer.hadMarkup ? bareFileListPaths(stripToolCallMarkup(response.content)) : null;
  if (fileRequest) {
    await onEvent("agent.context", { capability: subtask.capability, reason: "file-request", files: fileRequest.slice(0, 12) });
    const followUpCheck = canAffordRetry(input.deadlineAt, firstCallMs);
    if (!followUpCheck.ok) {
      return {
        status: "failed",
        error: `The implementation agent asked to read ${fileRequest.slice(0, 6).join(", ")} before editing, but only ${Math.round(
          followUpCheck.remainingMs / 1000
        )}s are left in the subtask (the first call took ${Math.round(firstCallMs / 1000)}s)`,
      };
    }
    input.assertBudgetForCall?.();
    const requested = await requestedFilesContext(workspacePath, "", input.fileChanges, fileRequest);
    ({ result: response, servedBy } = await runLlmCallWithFallback(
      [servedBy],
      baseMessages(input, codeChangeFileRequestPrompt({ basePayload, requested, asked: fileRequest })),
      { health: healthFor(input), signal: input.signal, timeoutMs: llmCallTimeoutMs(input), taskGate: input.llmTaskGate }
    ));
    if (input.onTokenUsage) {
      await input.onTokenUsage(
        response.inputTokens ?? 0,
        response.outputTokens ?? 0,
        servedBy.config.model,
        usageMetaFor(servedBy, response)
      );
    }
    {
      const asked = escalationFromAnswer(stripToolCallMarkup(response.content));
      if (asked) return await escalateOutcome(input, asked);
    }
    parsedAnswer = await parseAnswer(response.content);
    draft = parsedAnswer.draft;
    if (!draft) {
      await onEvent(
        "agent.context",
        { capability: subtask.capability, reason: "invalid-file-changes-json", attempt: "file-request", ...invalidAnswerEvent(response.content) },
        "warn"
      );
      return {
        status: "failed",
        error: `The implementation agent did not return file changes after reading the files it asked for (${fileRequest.slice(0, 6).join(", ")})`,
      };
    }
  }
  if (editFailures.length > 0) {
    // R2: a SEARCH miss or an ambiguous match goes back to the model with
    // Aider's "did you mean" report (up to MAX_EDIT_REFLECTIONS rounds; the
    // reply only resends the failed blocks), then the full-file fallback.
    const summarize = () => editFailures.map((failure) => ({ filePath: failure.block.filePath, kind: failure.kind }));
    await onEvent("agent.edit_blocks", { capability: subtask.capability, round: 0, applied: editApplied, failed: summarize() }, "warn");
    for (let round = 1; round <= MAX_EDIT_REFLECTIONS && editFailures.length > 0; round += 1) {
      if (!canAffordRetry(input.deadlineAt, firstCallMs).ok || signal.aborted) break;
      input.assertBudgetForCall?.();
      const feedback = editFailureFeedback(editFailures, editApplied);
      ({ result: response, servedBy } = await runLlmCallWithFallback(
        [servedBy],
        [
          ...baseMessages(input, basePayload),
          { role: "assistant" as const, content: editAnswerText },
          { role: "user" as const, content: feedback },
        ],
        { health: healthFor(input), signal: input.signal, timeoutMs: llmCallTimeoutMs(input), taskGate: input.llmTaskGate }
      ));
      if (input.onTokenUsage) {
        await input.onTokenUsage(response.inputTokens ?? 0, response.outputTokens ?? 0, servedBy.config.model, usageMetaFor(servedBy, response));
      }
      {
        const asked = escalationFromAnswer(stripToolCallMarkup(response.content));
        if (asked) return await escalateOutcome(input, asked);
      }
      parsedAnswer = await parseAnswer(response.content, "continue");
      draft = parsedAnswer.draft;
      await onEvent(
        "agent.edit_blocks",
        { capability: subtask.capability, round, applied: editApplied, failed: summarize() },
        editFailures.length > 0 ? "warn" : "info"
      );
    }
    if (editFailures.length > 0) {
      const paths = failedEditPaths(editFailures);
      if (paths.length === 0) {
        // Malformed blocks with no file to fall back on: the generic
        // invalid-answer retry below asks for the full-file format.
        draft = null;
        editFailures = [];
      } else {
        const fallbackCheck = canAffordRetry(input.deadlineAt, firstCallMs);
        if (!fallbackCheck.ok) {
          return {
            status: "failed",
            error: `SEARCH/REPLACE blocks for ${paths.join(", ")} did not apply after ${MAX_EDIT_REFLECTIONS} correction round(s), and only ${Math.round(
              fallbackCheck.remainingMs / 1000
            )}s are left for the full-file fallback`,
          };
        }
        input.assertBudgetForCall?.();
        const requested = await requestedFilesContext(workspacePath, "", input.fileChanges, paths);
        const feedback = editFailureFeedback(editFailures, 0);
        ({ result: response, servedBy } = await runLlmCallWithFallback(
          [servedBy],
          baseMessages(input, editFallbackPrompt({ basePayload, requested, paths, feedback })),
          { health: healthFor(input), signal: input.signal, timeoutMs: llmCallTimeoutMs(input), taskGate: input.llmTaskGate }
        ));
        if (input.onTokenUsage) {
          await input.onTokenUsage(response.inputTokens ?? 0, response.outputTokens ?? 0, servedBy.config.model, usageMetaFor(servedBy, response));
        }
        {
          const asked = escalationFromAnswer(stripToolCallMarkup(response.content));
          if (asked) return await escalateOutcome(input, asked);
        }
        const full = parseCodeChangeAnswer(response.content).draft;
        const byPath = new Map((full?.files ?? []).map((file) => [file.filePath.replace(/^\.\//, ""), file]));
        const missing = paths.filter((filePath) => !byPath.has(filePath));
        if (missing.length > 0) {
          await onEvent("agent.edit_blocks", { capability: subtask.capability, fallback: "full-file", ok: false, missing }, "warn");
          return {
            status: "failed",
            error: `SEARCH/REPLACE blocks for ${paths.join(", ")} did not apply, and the full-file fallback did not return ${missing.join(", ")}`,
          };
        }
        const merged = new Map((draft?.files ?? []).map((file) => [file.filePath, file]));
        for (const filePath of paths) merged.set(filePath, { filePath, newContent: byPath.get(filePath)!.newContent });
        draft = { files: Array.from(merged.values()) };
        editFailures = [];
        await onEvent("agent.edit_blocks", { capability: subtask.capability, fallback: "full-file", ok: true, files: paths });
      }
    }
  }
  if (parsedAnswer.hadMarkup) {
    await onEvent("agent.context", {
      capability: subtask.capability,
      toolCallMarkup: true,
      readPaths: parsedAnswer.readPaths.slice(0, 12),
      draftFromMarkup: draft !== null,
    }, "warn");
  }
  if (parsedAnswer.draft && parsedAnswer.format && parsedAnswer.format !== "json") {
    await onEvent("agent.context", { capability: subtask.capability, answerFormat: parsedAnswer.format });
  }
  if (!draft) {
    // Make the cause visible next time: scrubbed head of the answer + parse
    // error (also for an empty answer or a tool call).
    await onEvent(
      "agent.context",
      {
        capability: subtask.capability,
        reason: "invalid-file-changes-json",
        attempt: 1,
        hadMarkup: parsedAnswer.hadMarkup,
        ...invalidAnswerEvent(response.content),
      },
      "warn"
    );
  }
  if (!draft) {
    // The retry is a full second call: start it only when the subtask has
    // time left for one (as long as the first call took, plus margin).
    // Otherwise the scheduler would kill it mid-flight and report a
    // timeout that hides the real problem (invalid JSON).
    const retryCheck = canAffordRetry(input.deadlineAt, firstCallMs);
    const previousAnswer = stripToolCallMarkup(response.content).trim();
    if (!retryCheck.ok) {
      // Not enough time for a full retry: a cheap "repair" call that only
      // reformats the previous answer (no repo context), bounded by the
      // time left. Only worth it when the answer carried content.
      const canRepair =
        !parsedAnswer.hadMarkup && previousAnswer.length > 0 && retryCheck.remainingMs >= MIN_RETRY_WINDOW_MS;
      await onEvent(
        "agent.context",
        {
          capability: subtask.capability,
          retry: canRepair ? "repair" : false,
          reason: "invalid-file-changes-json",
          ...(canRepair ? {} : { skipped: "insufficient-time" }),
          remainingMs: retryCheck.remainingMs,
          firstCallMs,
        },
        "warn"
      );
      if (canRepair) {
        input.assertBudgetForCall?.();
        try {
          ({ result: response, servedBy } = await runLlmCallWithFallback(
            [servedBy],
            [
              { role: "system" as const, content: REPAIR_SYSTEM_PROMPT },
              { role: "user" as const, content: buildRepairPrompt(previousAnswer) },
            ],
            { health: healthFor(input), signal: input.signal, timeoutMs: llmCallTimeoutMs(input), taskGate: input.llmTaskGate }
          ));
          if (input.onTokenUsage) {
            await input.onTokenUsage(
              response.inputTokens ?? 0,
              response.outputTokens ?? 0,
              servedBy.config.model,
              usageMetaFor(servedBy, response)
            );
          }
          parsedAnswer = await parseAnswer(response.content);
          draft = parsedAnswer.draft;
        } catch (error) {
          if (isBudgetExhaustedError(error) || input.signal.aborted) throw error;
          await onEvent(
            "agent.context",
            { capability: subtask.capability, retry: "repair", failed: maskStringSecrets(String((error as Error)?.message ?? error)).slice(0, 300) },
            "warn"
          );
        }
        if (draft) {
          await onEvent("agent.context", { capability: subtask.capability, repaired: true, answerFormat: parsedAnswer.format });
        } else {
          await onEvent(
            "agent.context",
            { capability: subtask.capability, reason: "invalid-file-changes-json", attempt: "repair", ...invalidAnswerEvent(response.content) },
            "warn"
          );
        }
      }
      if (!draft) {
        return {
          status: "failed",
          error: `The implementation agent did not return valid file changes JSON (full retry skipped: ${Math.round(
            retryCheck.remainingMs / 1000
          )}s left in the subtask, the first call took ${Math.round(firstCallMs / 1000)}s${canRepair ? "; repair retry failed" : ""})`,
        };
      }
    }
  }
  if (!draft) {
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
    ({ result: response, servedBy } = await runLlmCallWithFallback(
      [servedBy],
      baseMessages(
        input,
        codeChangeRetryPrompt({ basePayload, requested, hadMarkup: parsedAnswer.hadMarkup, previous })
      ),
      { health: healthFor(input), signal: input.signal, timeoutMs: llmCallTimeoutMs(input), taskGate: input.llmTaskGate }
    ));
    if (input.onTokenUsage) {
      await input.onTokenUsage(
        response.inputTokens ?? 0,
        response.outputTokens ?? 0,
        servedBy.config.model,
        usageMetaFor(servedBy, response)
      );
    }
    parsedAnswer = await parseAnswer(response.content);
    draft = parsedAnswer.draft;
    if (!draft) {
      await onEvent(
        "agent.context",
        { capability: subtask.capability, reason: "invalid-file-changes-json", attempt: 2, ...invalidAnswerEvent(response.content) },
        "warn"
      );
    }
  }
  if (editFailures.length > 0) {
    // A late retry answered with SEARCH/REPLACE blocks that do not apply.
    return {
      status: "failed",
      error: `SEARCH/REPLACE blocks did not apply: ${editFailures
        .map((failure) => `${failure.block.filePath || "(malformed)"} (${failure.kind})`)
        .join(", ")}`,
    };
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

  {
    // The retry answer may carry the escalation instead of the first one.
    const asked = escalationFromAnswer(stripToolCallMarkup(response.content));
    if (asked) return await escalateOutcome(input, asked);
    const detected = await detectEscalation({
      subtask,
      files: draft.files.slice(0, 5),
      allowed: input.allowedEscalations,
      currentContent: contentReader(workspacePath, (filePath) => input.getStagedChange?.(filePath) ?? input.fileChanges.find((change) => change.filePath === filePath)),
    });
    if (detected) return await escalateOutcome(input, detected);
  }

  // Syntax gate (R3, Aider lint_edited pattern): staged files that no
  // longer parse go back to the implementer ONCE with the errors and the
  // marked lines; files that still do not parse never reach approval.
  if (draft.files.length > 0 && !signal.aborted) {
    const readCurrent = contentReader(workspacePath, (filePath) => input.getStagedChange?.(filePath) ?? input.fileChanges.find((change) => change.filePath === filePath));
    const checkSyntax = async (files: DraftFile[]): Promise<SyntaxIssue[]> =>
      (await Promise.all(files.map(async (file) => newSyntaxErrors(file.filePath, file.newContent, await readCurrent(file.filePath))))).flat();
    let issues = await checkSyntax(draft.files);
    if (issues.length > 0) {
      await onEvent(
        "syntax.error",
        { capability: subtask.capability, attempt: 1, issues: issues.slice(0, 10).map((i) => `${i.filePath}:${i.line}:${i.column}: ${i.message}`) },
        "warn"
      );
      input.assertBudgetForCall?.();
      try {
        const contents = new Map(draft.files.map((file) => [file.filePath.replace(/\\/g, "/"), file.newContent] as const));
        const retried = await runLlmCallWithFallback(
          [servedBy],
          baseMessages(input, `${basePayload}\n\n${syntaxRetryFeedback(issues, contents)}`),
          { health: healthFor(input), signal: input.signal, timeoutMs: llmCallTimeoutMs(input), taskGate: input.llmTaskGate }
        );
        if (input.onTokenUsage) {
          await input.onTokenUsage(
            retried.result.inputTokens ?? 0,
            retried.result.outputTokens ?? 0,
            retried.servedBy.config.model,
            usageMetaFor(retried.servedBy, retried.result)
          );
        }
        const reparsed = parseCodeChangeAnswer(retried.result.content).draft;
        if (reparsed && reparsed.files.length > 0) {
          draft = reparsed;
          issues = await checkSyntax(reparsed.files);
        }
      } catch (error) {
        if (isBudgetExhaustedError(error) || input.signal.aborted) throw error;
      }
      await onEvent(
        "syntax.error",
        { capability: subtask.capability, attempt: 2, resolved: issues.length === 0 },
        issues.length === 0 ? "info" : "warn"
      );
      if (issues.length > 0) {
        return { status: "failed", error: syntaxWarning(issues) ?? "The staged files do not parse" };
      }
    }
  }

  // Scope guard (live test 4: a "JSDoc only" request rewrote formatRupiah's
  // output; a slugify change dropped an existing test). Deleted test cases,
  // removed exports, or code edits on a doc-only request send the answer
  // back to the implementer ONCE with the violations; what remains is
  // carried as a warning to the approval.
  let scopeWarnings: string[] = [];
  if (draft.files.length > 0 && !signal.aborted) {
    const readCurrent = contentReader(workspacePath, (filePath) => input.getStagedChange?.(filePath) ?? input.fileChanges.find((change) => change.filePath === filePath));
    const request = command;
    const checkScope = async (files: DraftFile[]) =>
      scopeViolations(
        request,
        await Promise.all(
          files.slice(0, 5).map(async (file) => {
            const current = await readCurrent(file.filePath);
            return current === null
              ? { filePath: file.filePath, changeType: "new", newContent: file.newContent }
              : { filePath: file.filePath, changeType: "modified", oldContent: current, newContent: file.newContent };
          })
        )
      );
    let violations = await checkScope(draft.files);
    if (violations.length > 0) {
      await onEvent(
        "scope.violation",
        { capability: subtask.capability, attempt: 1, violations: violations.map((v) => ({ code: v.code, filePath: v.filePath, message: v.message })) },
        "warn"
      );
      input.assertBudgetForCall?.();
      try {
        const retried = await runLlmCallWithFallback(
          [servedBy],
          baseMessages(input, `${basePayload}\n\n${scopeRetryFeedback(violations)}`),
          { health: healthFor(input), signal: input.signal, timeoutMs: llmCallTimeoutMs(input), taskGate: input.llmTaskGate }
        );
        if (input.onTokenUsage) {
          await input.onTokenUsage(
            retried.result.inputTokens ?? 0,
            retried.result.outputTokens ?? 0,
            retried.servedBy.config.model,
            usageMetaFor(retried.servedBy, retried.result)
          );
        }
        const reparsedAnswer = await parseAnswer(retried.result.content);
        // A scope retry whose SEARCH blocks do not apply keeps the first draft.
        const reparsed = editFailures.length > 0 ? null : reparsedAnswer.draft;
        editFailures = [];
        if (reparsed && reparsed.files.length > 0) {
          draft = reparsed;
          violations = await checkScope(reparsed.files);
        }
        await onEvent(
          "scope.violation",
          { capability: subtask.capability, attempt: 2, resolved: violations.length === 0, remaining: violations.map((v) => v.message) },
          violations.length === 0 ? "info" : "warn"
        );
      } catch (error) {
        if (isBudgetExhaustedError(error) || input.signal.aborted) throw error;
        await onEvent(
          "scope.violation",
          { capability: subtask.capability, retry: "failed", message: maskStringSecrets(String((error as Error)?.message ?? error)).slice(0, 300) },
          "warn"
        );
      }
      scopeWarnings = violations.map((v) => v.message);
    }
  }

  const prepared: FileDiff[] = [];
  if (draft.files.length === 0) {
    // No-target rule: "Not found: … Checked: …" is the answer, said plainly.
    const notFound = (delegation?.findings ?? []).filter((finding) => /^not found\b/i.test(finding.trim()));
    const output = notFound.length > 0 ? `${notFound.join("\n")}\nNo files were changed.` : "No file changes needed for this task.";
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
    const denied = writeDenial(roleLabel, permissions, file.filePath);
    if (denied) {
      await onEvent("agent.permission_denied", { capability: subtask.capability, role: input.agent.role, filePath: file.filePath, reason: denied }, "warn");
      return { status: "failed", error: `Refusing to modify ${file.filePath}: ${denied}` };
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
    scopeWarnings.length > 0 ? `Scope warning (after one corrective retry): ${scopeWarnings.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    status: "completed",
    output,
    meta: {
      filePaths: prepared.map((change) => change.filePath),
      ...(reverted.length > 0 ? { revertedPaths: reverted } : {}),
      ...(scopeWarnings.length > 0 ? { scopeWarnings } : {}),
      ...delegationMeta,
    },
  };
}

async function executeReview(
  input: SubtaskExecutionInput
): Promise<SubtaskExecutionResult> {
  const { subtask, fileChanges } = input;
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
  const reviewPrompt = buildReviewPrompt({ command: input.command, scope: subtask.description, snapshotId, diffText });
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
      usageMetaFor(servedBy, response)
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
          reviewRetryPrompt(reviewPrompt, stripToolCallMarkup(response.content).slice(0, 1500))
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
    // Console errors that name none of these files (or are hydration
    // mismatches) are reported as pre-existing, not as a failed check.
    changedFiles: input.fileChanges.map((change) => change.filePath),
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
  const { workspacePath, command, subtask } = input;
  const fileHint = extractFileHint(subtask.description);
  const { context } = await exploreRepository(workspacePath, {
    fileHint,
    query: `${subtask.description}\n${command}`,
    mentionedFiles: subtask.allowedPaths,
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
    toolLoopEnabled()
  ) {
    const { tool_search } = await import("../governance/registry");
    const tools = tool_search({
      supportedTools: (input.agent as { supportedTools?: string[] }).supportedTools,
      query: "",
    });
    if (tools.length > 0) {
      toolLoopSection = toolLoopSectionFor(tools.map((t) => t.name));
    }
  }

  // Plan 036: the Agent Reach web tool is offered to read-only agents that
  // declare it. The instruction then says the agent may read public web
  // content, so it does not claim the repository is the only source.
  const webReachAvailable =
    (mode === "research" || mode === "audit") &&
    Boolean(input.webReach) &&
    agentAllowsWebReach(input.agent.supportedTools) &&
    permissionsForAgent(input.agent).web;

  let instruction = readOnlyInstruction(mode, { webTool: webReachAvailable });
  if (toolLoopSection) instruction += toolLoopSection;

  // Options review: roles allowed to ask the user to pick (Designer now)
  // get show_options in a bounded tool loop; the answer arrives inside the
  // tool call and the final result is written for the picked option(s).
  if (optionsToolAvailable(input)) {
    const optionsResult = await runOptionsExploration(input, instruction, context);
    if (optionsResult) {
      const content = optionsResult.answer.trim() || "No result after the options review.";
      await input.onChunk(content);
      await input.onMessage(sanitizeForChat(stripToolCallMarkup(content)));
      await input.onEvent("agent.options_review", {
        capability: subtask.capability,
        toolCalls: optionsResult.toolCalls,
        reviewed: optionsResult.reviewed,
      });
      const delegation = parseDelegation(content);
      return {
        status: "completed",
        output: content,
        meta: {
          optionsReviewed: optionsResult.reviewed,
          ...(delegation?.delegationRecommendation ? { delegationRecommendation: delegation.delegationRecommendation } : {}),
          ...(delegation?.findings ? { findings: delegation.findings } : {}),
        },
      };
    }
  }

  // Plan 036: the Agent Reach web tool. When the policy enabled it and the
  // agent declared `web_reach`, the agent can search the public web and
  // read public platform content through a bounded tool loop. The tool is
  // read-only, so it is offered for research and audit only.
  if (webReachAvailable) {
    const webResult = await runWebReachExploration(input, instruction, context);
    if (webResult) {
      const content = webResult.answer.trim() || "No findings from web research.";
      if (content) await input.onChunk(content);
      await input.onMessage(sanitizeForChat(stripToolCallMarkup(content)));
      await input.onEvent("agent.web_reach", {
        capability: subtask.capability,
        toolCalls: webResult.toolCalls,
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
  }

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
    readOnlyUserContent({ instruction, context, webBlock: webContext.block, command })
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
    const streamStartedAt = Date.now();
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
              // Streamed output is progress: keeps the stall and task idle
              // watchdogs alive during a long streamed reply.
              markProgress();
              await input.onChunk(delta);
            },
            primary.config.model,
            { signal: input.signal, timeoutMs: llmCallTimeoutMs(input) }
          ),
        { signal: input.signal, taskGate: input.llmTaskGate }
      );
      // Streaming bypasses runLlmCallWithFallback: estimate usage here too
      // when the stream carried none.
      response = withUsageEstimate(messages, response);
      health?.recordSuccess(primary.connectionId);
      recordLlmSnapshot({
        messages,
        result: response,
        model: primary.config.model,
        provider: primary.config.provider,
        durationMs: Date.now() - streamStartedAt,
      });
    } catch (error) {
      // A caller abort is not a provider failure and never falls back.
      if (input.signal.aborted) {
        recordLlmSnapshot({ messages, error, model: primary.config.model, provider: primary.config.provider, durationMs: Date.now() - streamStartedAt });
        throw error;
      }
      if (chunkEmitted || !isTransientLlmError(error) || handles.length < 2) {
        recordLlmSnapshot({ messages, error, model: primary.config.model, provider: primary.config.provider, durationMs: Date.now() - streamStartedAt });
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
      usageMetaFor(servedHandle, response)
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
 * gets a free-form shell. The allowlist (utils/commandAllowlist) is the
 * single source for both the prompt and the executor; a reply that is not
 * the JSON contract gets one repair round before the subtask fails.
 */
async function executeShell(
  input: SubtaskExecutionInput
): Promise<SubtaskExecutionResult> {
  const { workspacePath, command, subtask, signal, onEvent, onMessage } = input;
  await onEvent("agent.context", {
    capability: subtask.capability,
    mode: "shell (allowlisted)",
  });

  if (signal.aborted) return { status: "failed", error: "Execution cancelled" };

  const instruction = shellInstruction();

  const handles = handlesFor(input);
  const health = healthFor(input);
  // The task's command is the user's whole request; the subtask description
  // says which command this node runs (a plan may hold several shell nodes).
  const task = subtask.description && subtask.description.trim() && subtask.description.trim() !== command.trim()
    ? `${subtask.description.trim()}\n\nUser request: ${command}`
    : command;
  const messages = baseMessages(input, shellUserContent(instruction, task));
  const ask = async (conversation: LLMMessage[]): Promise<string> => {
    const { result: response, servedBy } = await runLlmCallWithFallback(handles, conversation, {
      health,
      signal,
      timeoutMs: llmCallTimeoutMs(input),
      taskGate: input.llmTaskGate,
    });
    // Every executor path reports its call (the shell path used not to).
    if (input.onTokenUsage) {
      await input.onTokenUsage(
        response.inputTokens ?? 0,
        response.outputTokens ?? 0,
        servedBy.config.model,
        usageMetaFor(servedBy, response)
      );
    }
    return response.content;
  };
  const first = await ask(messages);
  let reply = parseShellReply(first);
  if (!reply) {
    // One repair round: re-ask with the exact schema before failing. A model
    // that answered in prose ("I can't run npm test…") gets one more chance
    // to give the contract; the JSON never reaches chat either way.
    if (signal.aborted) return { status: "failed", error: "Execution cancelled" };
    await onEvent("shell.reply_repair", { preview: first.trim().slice(0, 200) }, "warn");
    const second = await ask([
      ...messages,
      { role: "assistant" as const, content: first.trim() || "(empty)" },
      { role: "user" as const, content: shellRepairContent(first) },
    ]);
    reply = parseShellReply(second);
  }
  if (!reply) {
    return {
      status: "failed",
      error: "Shell agent did not return a valid command JSON (after one repair attempt)",
    };
  }
  if (reply.kind === "refusal") {
    return {
      status: "failed",
      error: `Shell agent found no allowlisted command for this task: ${reply.reason}`,
    };
  }
  const parsed = { command: reply.command, args: reply.args };
  // The raw shell-command JSON must never reach chat; narrate the human
  // command line instead (the result summary below follows on completion).
  await input.onMessage(`$ ${parsed.command} ${parsed.args.join(" ")}`);
  // L2 shell guard: environment dumps, secret exports and credential-file
  // reads are refused with the rule name, before the allowlist and before
  // any approval (no mode, Full access included, may run them).
  const guarded = shellGuardDecisionForArgv(parsed.command, parsed.args);
  if (guarded) {
    const line = `${parsed.command} ${parsed.args.join(" ")}`.trim();
    await onEvent("shell.command_blocked", { command: parsed.command, args: parsed.args, rule: guarded.rule, reason: guarded.reason }, "warn");
    return { status: "failed", error: shellGuardOutput(`$ ${line}`, guarded) };
  }
  if (!isCommandAllowed(parsed.command, parsed.args)) {
    return {
      status: "failed",
      error: `Command blocked (not allowlisted): ${parsed.command} ${parsed.args.join(" ")}`,
    };
  }
  // Plan 040: the role's shell permission (QA: verification commands only).
  const shellDenied = shellDenial((input.agent.role ?? "").trim() || "agent", permissionsForAgent(input.agent), parsed.command, parsed.args);
  if (shellDenied) {
    await onEvent("agent.permission_denied", { capability: subtask.capability, role: input.agent.role, command: parsed.command, args: parsed.args, reason: shellDenied }, "warn");
    return { status: "failed", error: `Command blocked: ${shellDenied}: ${parsed.command} ${parsed.args.join(" ")}` };
  }
  // Destructive / push-like commands always ask. With no approval channel
  // (legacy callers) such a command never runs.
  const danger = dangerousCommandReason(parsed.command, parsed.args, workspacePath);
  if (danger && !input.requestCommandApproval) {
    return { status: "failed", error: `Command blocked (${danger}; needs the user's approval): ${parsed.command} ${parsed.args.join(" ")}` };
  }

  // Approval gate (Supervised / Auto-accept edits ask; rules and Full
  // access approve; dangerous commands always ask). Waits in-process.
  if (input.requestCommandApproval) {
    const line = `${parsed.command} ${parsed.args.join(" ")}`.trim();
    const outcome = await input.requestCommandApproval({ command: parsed.command, args: parsed.args });
    if (!outcome.allowed) {
      await onEvent("shell.command_declined", { command: parsed.command, args: parsed.args, via: outcome.via, reason: outcome.reason }, "warn");
      // Only a real stop (task cancelled / aborted) fails the node. A pause
      // never ends the wait any more (commandApproval.ts); a legacy
      // "paused" outcome is treated as a decline the agent can act on,
      // never as a failed shell subtask.
      if (outcome.via === "cancelled") {
        return { status: "failed", error: `${outcome.reason}: ${line}` };
      }
      const output = commandDeniedOutput(`$ ${line}`, outcome);
      await onMessage(output);
      // Settled, not retried or replanned, but never a success: the backend
      // stores the subtask as `skipped` ("Declined by user: …") and the CTO
      // summary says the command was not run (finalize.ts).
      return { status: "completed", output, meta: { commandDeclined: outcome.via, declinedCommand: line } };
    }
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
