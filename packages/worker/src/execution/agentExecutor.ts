import { createProviderForAgent, getGlobalLLMConfig, type GlobalLLMConfig } from "@/llm";
import { runLlmCall } from "@/effects/llmCall";
import type { AgentDefinition, ExecutionPlan, PlanSubtask } from "@/orchestrator/types";
import {
  buildAgentExecutionContext,
  formatAgentContextForPrompt,
} from "@/orchestrator/agentContext";
import type { SharedTaskContext } from "@/orchestrator/taskContext";
import { extractFileHint, parseDelegation, parseDraft, parseReview } from "@/utils/json";
import { validateFilePath } from "@/governance/tools";
import { computeDiff, type FileDiff } from "@/tools/gitDiff";
import { extractUrls, type WebClient } from "@/tools/webClient";
import { exploreRepository } from "./repositoryContext";
import { runResponsiveQa } from "./qa";

export interface SubtaskExecutionInput {
  workspacePath: string;
  command: string;
  plan: ExecutionPlan;
  subtask: PlanSubtask;
  agent: AgentDefinition;
  browser?: WebClient;
  /** Explicit per-task LLM config resolved by the runner (env fallback when absent). */
  llmConfig?: GlobalLLMConfig;
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
  onTokenUsage?: (inputTokens: number, outputTokens: number, model: string) => Promise<void>;
}

function resolveModelForAgent(_agent?: AgentDefinition, llmConfig?: GlobalLLMConfig): string {
  return llmConfig?.model ?? getGlobalLLMConfig().model;
}

export type SubtaskExecutionResult =
  | { status: "completed"; output?: string; meta?: Record<string, unknown> }
  | { status: "failed"; error: string };

export async function executeSubtask(
  input: SubtaskExecutionInput
): Promise<SubtaskExecutionResult> {
  const { subtask, agent } = input;
  if (input.signal.aborted) {
    return { status: "failed", error: "Execution cancelled" };
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
    case "analysis":
    default:
      return await executeReadOnly(input, "analysis");
  }
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

  const provider = createProviderForAgent(agent, input.llmConfig);
  const basePayload = [
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
    "- Only relative paths inside the workspace.",
    "- Preserve unrelated behavior and code.",
    "- Do not touch lockfiles, secrets, .env files, or node_modules.",
    "- Keep the change minimal and focused on the task.",
  ].join("\n");

  let response = await runLlmCall(provider, baseMessages(input, basePayload));
  if (input.onTokenUsage) {
    await input.onTokenUsage(response.inputTokens ?? 0, response.outputTokens ?? 0, resolveModelForAgent(agent, input.llmConfig));
  }

  let draft = parseDraft(response.content);
  if (!draft) {
    await onEvent("agent.context", {
      capability: subtask.capability,
      retry: true,
      reason: "invalid-file-changes-json",
    });
    response = await runLlmCall(
      provider,
      baseMessages(
        input,
        `${basePayload}\n\nYour previous response was not a valid file-changes JSON object. Return ONLY the JSON object again.\n\nPrevious response (for reference):\n${response.content.slice(0, 2000)}`
      )
    );
    if (input.onTokenUsage) {
      await input.onTokenUsage(response.inputTokens ?? 0, response.outputTokens ?? 0, resolveModelForAgent(agent, input.llmConfig));
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
  for (const file of draft.files.slice(0, 5)) {
    if (isForbiddenPath(file.filePath)) {
      return { status: "failed", error: `Refusing to modify protected path: ${file.filePath}` };
    }
    const filePathCheck = validateFilePath(file.filePath);
    if (!filePathCheck.ok) {
      return { status: "failed", error: `Refusing to modify protected path (${filePathCheck.reason}): ${file.filePath}` };
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

  const diffText = fileChanges
    .map((change) => `### ${change.filePath} (${change.changeType})\n${change.diff}`)
    .join("\n\n")
    .slice(0, 40_000)
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9_]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)\b/g, "[REDACTED]");

  const response = await runLlmCall(
    createProviderForAgent(agent, input.llmConfig),
    baseMessages(
      input,
      [
        `Review these prepared changes for: ${input.command}`,
        `Review scope: ${subtask.description}`,
        diffText,
        "",
        "Return JSON only:",
        '{"verdict":"approved"|"changes_requested","findings":[{"severity":"critical"|"high"|"medium"|"low","filePath":"...","description":"...","suggestion":"..."}]}',
        "Reject only for concrete correctness, security, or regression risks. Do not request style-only changes.",
      ].join("\n")
    )
  );
  if (input.onTokenUsage) {
    await input.onTokenUsage(response.inputTokens ?? 0, response.outputTokens ?? 0, resolveModelForAgent(agent, input.llmConfig));
  }

  const review = parseReview(response.content);
  if (!review) {
    return {
      status: "failed",
      error: "The review agent returned an unparseable review; refusing to proceed",
    };
  }

  await input.onEvent("review.completed", {
    verdict: review.verdict,
    findings: review.findings,
  });
  await input.onMessage(
    review.verdict === "approved"
      ? "Review approved the prepared changes."
      : `Review requested changes:\n${review.findings
          .map((finding) => `- [${finding.severity}] ${finding.filePath}: ${finding.description}`)
          .join("\n")}`
  );

  if (review.verdict !== "approved") {
    return {
      status: "completed",
      output: `Review requested changes:\n${review.findings
        .map((finding) => `- [${finding.severity}] ${finding.filePath}: ${finding.description}`)
        .join("\n")}`,
      meta: { verdict: review.verdict, findings: review.findings },
    };
  }
  return {
    status: "completed",
    output: "Review approved.",
    meta: { verdict: review.verdict, findings: review.findings },
  };
}

async function executeQa(
  input: SubtaskExecutionInput
): Promise<SubtaskExecutionResult> {
  const report = await runResponsiveQa(input.workspacePath, {
    onCheck: async (check) => {
      await input.onEvent(
        "task.check",
        { label: check.label, status: check.status, details: check.details },
        check.status === "failed" ? "error" : "info"
      );
    },
  });

  const summary = `QA verdict: ${report.verdict}. Checks: ${report.checks
    .map((check) => `${check.label}=${check.status}`)
    .join(", ")}`;
  await input.onMessage(summary);

  if (report.verdict === "failed") {
    return {
      status: "failed",
      error: `QA failed: ${report.failures.join("; ")}`,
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

  const provider = createProviderForAgent(agent, input.llmConfig);
  const messages = baseMessages(
    input,
    `${instruction}\n\nRepository context:\n${context}${webContext.block ? `\n\n${webContext.block}` : ""}\n\nUser request: ${command}`
  );
  const response = provider.stream
    ? await provider.stream(messages, async (delta) => {
        await input.onChunk(delta);
      })
    : await runLlmCall(provider, messages);
  if (input.onTokenUsage) {
    await input.onTokenUsage(response.inputTokens ?? 0, response.outputTokens ?? 0, resolveModelForAgent(agent, input.llmConfig));
  }

  const content = response.content.trim();
  if (!content) {
    return { status: "failed", error: `The ${mode} agent returned an empty response` };
  }
  await input.onMessage(content);
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
