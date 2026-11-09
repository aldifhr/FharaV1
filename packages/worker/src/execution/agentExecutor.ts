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
} from "./nativeProvider";
import type { SharedTaskContext } from "@/orchestrator/taskContext";
import { extractFileHint, parseDelegation, parseDraft, parseReview, sanitizeForChat } from "@/utils/json";
import { validateFilePath } from "@/governance/tools";
import { isPathWithinOwnership } from "@/orchestrator/ownership";
import { computeDiff, snapshotIdForChanges, type FileDiff } from "@/tools/gitDiff";
import { isCommandAllowed, runCommand } from "@/tools/runCommand";
import { resolveSandboxPathAsync } from "@/tools/sandbox";
import { promises as fs } from "node:fs";
import { extractUrls, type WebClient } from "@/tools/webClient";
import { exploreRepository } from "./repositoryContext";
import { runResponsiveQa } from "./qa";
import { wantsVisualQa } from "@/orchestrator/planner";
import { getMcpRegistry, type McpHooks, type McpSession } from "@/mcp/registry";
import { runMcpToolLoop } from "@/mcp/toolLoop";
import type { McpToolDefinition } from "@/mcp/types";

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
  onEvent: (
    type: string,
    payload: Record<string, unknown>,
    level?: "info" | "warn" | "error"
  ) => Promise<void>;
  onMessage: (content: string) => Promise<void>;
  onChunk: (delta: string) => Promise<void>;
  saveFileChange: (change: FileDiff) => Promise<void>;
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
    if (input.runtime === "native-provider") {
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

  const result = await runNativeProvider({
    workspacePath,
    prompt,
    command: input.nativeProviderCommand,
    signal,
    onEvent,
    onMessage,
  });

  if (input.onTokenUsage && (result.inputTokens > 0 || result.outputTokens > 0)) {
    await input.onTokenUsage(result.inputTokens, result.outputTokens, "native-provider", undefined);
  }

  if (result.status !== "completed") {
    return { status: "failed", error: result.output || "Native provider run failed" };
  }

  // Stage whatever the provider changed in the workspace so the
  // verification and approval flows still review it.
  const prepared: { filePath: string }[] = [];
  if (subtask.kind === "code_change" || subtask.kind === "shell") {
    try {
      const { stdout } = await runCommand(workspacePath, "git", ["status", "--short"], { signal });
      const changedPaths = stdout
        .split(/\r?\n/)
        .map((line) => line.slice(3).trim())
        .filter(Boolean)
        .slice(0, 50);
      for (const filePath of changedPaths) {
        if (signal.aborted) return { status: "failed", error: "Execution cancelled" };
        if (isForbiddenPath(filePath)) continue;
        const check = validateFilePath(filePath);
        if (!check.ok) continue;
        if (!isPathWithinOwnership(filePath, subtask.allowedPaths)) continue;
        try {
          const resolved = await resolveSandboxPathAsync(workspacePath, filePath);
          const newContent = await fs.readFile(resolved, "utf-8");
          const diff = await computeDiff(workspacePath, filePath, newContent);
          await input.saveFileChange(diff);
          prepared.push({ filePath });
        } catch {
          // Per-file staging failures are best-effort; the summary stands.
        }
      }
    } catch {
      // Workspace may not be a git repo; the provider's own output stands.
    }
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
      stagedFiles: prepared.map((c) => c.filePath),
    },
  };
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
  const basePayload =
    [
    `Task: ${command}`,
    `Your role in the plan: ${subtask.title} — ${subtask.description}`,
    `Repository context:\n${context}`,
    "",
    "Return JSON only with the files you want to change:",
    '{"files":[{"filePath":"relative/path","newContent":"FULL file content"}]}',
    "",
    "You may add these optional top-level fields to the same JSON object:",
    '- "delegationRecommendation":{"targetCapability":"...","reason":"..."} when another capability should take over after you (e.g. browser-testing for QA).',
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
  let { result: response, servedBy } = await runLlmCallWithFallback(
    handles,
    baseMessages(input, basePayload),
    { health: healthFor(input), signal: input.signal, taskGate: input.llmTaskGate }
  );
  if (input.onTokenUsage) {
    await input.onTokenUsage(
      response.inputTokens ?? 0,
      response.outputTokens ?? 0,
      servedBy.config.model,
      usageMetaFor(servedBy, response.inputTokens ?? 0, response.outputTokens ?? 0)
    );
  }

  let draft = parseDraft(response.content);
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
    ({ result: response, servedBy } = await runLlmCallWithFallback(
      [servedBy],
      baseMessages(
        input,
        `${basePayload}\n\nYour previous response was not a valid file-changes JSON object. Return ONLY the JSON object again.\n\nPrevious response (for reference):\n${response.content.slice(0, 2000)}`
      ),
      { health: healthFor(input), signal: input.signal, taskGate: input.llmTaskGate }
    ));
    if (input.onTokenUsage) {
      await input.onTokenUsage(
        response.inputTokens ?? 0,
        response.outputTokens ?? 0,
        servedBy.config.model,
        usageMetaFor(servedBy, response.inputTokens ?? 0, response.outputTokens ?? 0)
      );
    }
    draft = parseDraft(response.content);
  }
  if (!draft) {
    return {
      status: "failed",
      error: "The implementation agent did not return valid file changes JSON",
    };
  }

  const delegation = parseDelegation(response.content);
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
      const diff = await computeDiff(workspacePath, file.filePath, file.newContent);
      await input.saveFileChange(diff);
      prepared.push(diff);
    } catch (error) {
      return {
        status: "failed",
        error: `Could not stage ${file.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const output = `Prepared ${prepared.length} file change(s): ${prepared
    .map((change) => change.filePath)
    .join(", ")}`;
  return {
    status: "completed",
    output,
    meta: {
      filePaths: prepared.map((change) => change.filePath),
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
  const { result: response, servedBy } = await runLlmCallWithFallback(
    handlesFor(input),
    baseMessages(
      input,
      [
        `Review these prepared changes for: ${input.command}`,
        `Review scope: ${subtask.description}`,
        `Change-set snapshot id: ${snapshotId}. Review exactly this frozen set.`,
        diffText,
        "",
        "Return JSON only:",
        '{"verdict":"approved"|"changes_requested","findings":[{"severity":"critical"|"high"|"medium"|"low","filePath":"...","description":"...","suggestion":"..."}]}',
        "Reject only for concrete correctness, security, or regression risks. Do not request style-only changes.",
      ].join("\n")
    ),
    { health: healthFor(input), signal: input.signal, taskGate: input.llmTaskGate }
  );
  if (input.onTokenUsage) {
    await input.onTokenUsage(
      response.inputTokens ?? 0,
      response.outputTokens ?? 0,
      servedBy.config.model,
      usageMetaFor(servedBy, response.inputTokens ?? 0, response.outputTokens ?? 0)
    );
  }

  const review = parseReview(response.content);
  if (!review) {
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
  const summary = `QA verdict: ${report.verdict} — ${passedCount}/${report.checks.length} checks ok on ${checked}: ${report.checks
    .map((check) => `${check.label}=${check.status}`)
    .join(", ")}${report.checks.length > 0 && !visualRegression ? ". No visual comparison — structural checks only" : ""}.`;
  await input.onMessage(summary);

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
    await input.onMessage(sanitizeForChat(content));
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
            { signal: input.signal }
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
  await input.onMessage(sanitizeForChat(content));
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
