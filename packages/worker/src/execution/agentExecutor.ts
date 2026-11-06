import { createProviderForAgent } from "../llm";
import type { AgentDefinition, ExecutionPlan, PlanSubtask } from "../orchestrator/types";
import { extractFileHint, parseDraft, parseReview } from "../utils/json";
import { validateFilePath } from "../governance/tools";
import { computeDiff, type FileDiff } from "../tools/gitDiff";
import { exploreRepository } from "./repositoryContext";
import { runResponsiveQa } from "./qa";

export interface SubtaskExecutionInput {
  workspacePath: string;
  command: string;
  plan: ExecutionPlan;
  subtask: PlanSubtask;
  agent: AgentDefinition;
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

function resolveModelForAgent(agent: AgentDefinition): string {
  if (agent.llmModel) return agent.llmModel;
  if ((agent.llmProvider ?? "anthropic") === "openai-compatible") return "gpt-4o-mini";
  return "claude-sonnet-4-20250514";
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
  const prior = Array.from(priorOutputs.entries())
    .map(([key, value]) => `### ${key}\n${value.slice(0, 4000)}`)
    .join("\n\n");
  return [
    ...(agent.systemPrompt
      ? [{ role: "system" as const, content: agent.systemPrompt }]
      : []),
    {
      role: "user" as const,
      content: [
        prior ? `Previous subtask outputs:\n${prior}` : "",
        userContent,
      ]
        .filter(Boolean)
        .join("\n\n"),
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

  const provider = createProviderForAgent(agent);
  const basePayload = [
    `Task: ${command}`,
    `Your role in the plan: ${subtask.title} — ${subtask.description}`,
    `Repository context:\n${context}`,
    "",
    "Return JSON only with the files you want to change:",
    '{"files":[{"filePath":"relative/path","newContent":"FULL file content"}]}',
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

  let response = await provider.complete(baseMessages(input, basePayload));
  if (input.onTokenUsage) {
    await input.onTokenUsage(response.inputTokens ?? 0, response.outputTokens ?? 0, resolveModelForAgent(agent));
  }

  let draft = parseDraft(response.content);
  if (!draft) {
    await onEvent("agent.context", {
      capability: subtask.capability,
      retry: true,
      reason: "invalid-file-changes-json",
    });
    response = await provider.complete(
      baseMessages(
        input,
        `${basePayload}\n\nYour previous response was not a valid file-changes JSON object. Return ONLY the JSON object again.\n\nPrevious response (for reference):\n${response.content.slice(0, 2000)}`
      )
    );
    if (input.onTokenUsage) {
      await input.onTokenUsage(response.inputTokens ?? 0, response.outputTokens ?? 0, resolveModelForAgent(agent));
    }
    draft = parseDraft(response.content);
  }
  if (!draft) {
    return {
      status: "failed",
      error: "The implementation agent did not return valid file changes JSON",
    };
  }

  const prepared: FileDiff[] = [];
  if (draft.files.length === 0) {
    const output = "No file changes needed for this task.";
    await onMessage(output);
    return { status: "completed", output, meta: { filePaths: [] } };
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
    meta: { filePaths: prepared.map((change) => change.filePath) },
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

  const response = await createProviderForAgent(agent).complete(
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
    await input.onTokenUsage(response.inputTokens ?? 0, response.outputTokens ?? 0, resolveModelForAgent(agent));
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
      "Do not modify files and do not return JSON.",
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

  const provider = createProviderForAgent(agent);
  const messages = baseMessages(
    input,
    `${instruction}\n\nRepository context:\n${context}\n\nUser request: ${command}`
  );
  const response = provider.stream
    ? await provider.stream(messages, async (delta) => {
        await input.onChunk(delta);
      })
    : await provider.complete(messages);
  if (input.onTokenUsage) {
    await input.onTokenUsage(response.inputTokens ?? 0, response.outputTokens ?? 0, resolveModelForAgent(agent));
  }

  const content = response.content.trim();
  if (!content) {
    return { status: "failed", error: `The ${mode} agent returned an empty response` };
  }
  await input.onMessage(content);
  return { status: "completed", output: content };
}

const FORBIDDEN_PATHS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.git\//i,
  /(^|\/)node_modules\//i,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i,
  /(^|\/)\.ssh(\/|$)/i,
];

export function isForbiddenPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return FORBIDDEN_PATHS.some((pattern) => pattern.test(normalized));
}
