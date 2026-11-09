import type { SharedTaskContext, ExecutionHistoryEntry, TaskArtifact, OutstandingIssue } from "./taskContext";
import type { AgentDefinition } from "@/types";
import { capabilitiesOf } from "./capabilities";

export interface AgentExecutionContext {
  taskId: string;
  agentId: string;
  agentName: string;
  systemPrompt: string;
  assignment: string;
  relevantRequirements: string[];
  previousResults: ExecutionHistoryEntry[];
  relevantArtifacts: TaskArtifact[];
  outstandingIssues: OutstandingIssue[];
  constraints: string[];
  expectedOutput: string;
  relevantDecisions?: string[];
}

export function buildAgentExecutionContext(input: {
  taskContext: SharedTaskContext;
  agent: AgentDefinition;
  assignment: string;
  relevantFilePaths?: string[];
  maxPreviousResults?: number;
}): AgentExecutionContext {
  const { taskContext, agent, assignment } = input;
  const maxPrevious = input.maxPreviousResults ?? 5;

  // Filter previous results: only relevant ones (same capability domain or recent)
  const agentCaps = capabilitiesOf(agent);
  const relevantPrevious = taskContext.agentExecutions
    .slice(-maxPrevious)
    .filter((entry) => {
      if (entry.agentName === agent.name) return true;
      if (agentCaps.includes(entry.capability)) return true;
      // Always include most recent execution regardless of capability
      if (entry === taskContext.agentExecutions[taskContext.agentExecutions.length - 1]) return true;
      return false;
    })
    .slice(-3) // cap to 3 most relevant to avoid context bloat

  const relevantArtifacts = taskContext.artifacts.filter((artifact) => {
    if (!input.relevantFilePaths) return true;
    if (!artifact.path) return true;
    return input.relevantFilePaths.some((p) => artifact.path!.includes(p) || p.includes(artifact.path!));
  });

  const outstandingIssues = taskContext.outstandingIssues.filter((issue) => issue.status === "open");

  const relevantRequirements = taskContext.classification.suggestedCapabilities;
  const constraints = [
    "Only modify files within the project workspace",
    "Do not touch .env, node_modules, lockfiles",
    "Keep changes minimal and focused",
  ];

  const expectedOutput = agent.capabilities?.includes("browser-testing")
    ? "Test report with verdict (passed/failed/inconclusive) and concrete failures"
    : agent.capabilities?.includes("code-review")
      ? 'Review verdict JSON: {"verdict":"approved"|"changes_requested","findings":[...]}'
      : '{"files":[{"filePath":"relative/path","newContent":"FULL file content"}]} or plain summary if no files';

  const relevantDecisions = taskContext.decisions.slice(-3).map((d) => `${d.decision}: ${d.reason}`);

  return {
    taskId: taskContext.taskId,
    agentId: agent._id,
    agentName: agent.name,
    systemPrompt: agent.systemPrompt ?? "",
    assignment,
    relevantRequirements,
    previousResults: relevantPrevious,
    relevantArtifacts,
    outstandingIssues,
    constraints,
    expectedOutput,
    relevantDecisions,
  };
}

export function formatAgentContextForPrompt(ctx: AgentExecutionContext): string {
  const parts: string[] = [
    `Task: ${ctx.assignment}`,
    `Your role: ${ctx.agentName} focus`,
  ];

  if (ctx.outstandingIssues.length > 0) {
    parts.push(
      "Outstanding issues to consider:",
      ...ctx.outstandingIssues.map((i) => `- [${i.severity}] ${i.description} (raised by ${i.raisedBy ?? "unknown"})`)
    );
  }

  if (ctx.previousResults.length > 0) {
    parts.push("Previous results (summaries only):");
    for (const r of ctx.previousResults) {
      parts.push(`- ${r.agentName} (${r.capability}, ${r.status}): ${r.summary ?? ""}`);
    }
  }

  if (ctx.relevantArtifacts.length > 0) {
    parts.push("Relevant artifacts from previous work:");
    for (const a of ctx.relevantArtifacts) {
      parts.push(`- ${a.path ?? a.kind}: ${a.summary}`);
    }
  }

  if (ctx.relevantDecisions && ctx.relevantDecisions.length > 0) {
    parts.push("Recent decisions:", ...ctx.relevantDecisions.map((d) => `- ${d}`));
  }

  if (ctx.relevantRequirements.length > 0) {
    parts.push(`Capabilities in scope: ${ctx.relevantRequirements.join(", ")}`);
  }

  if (ctx.constraints.length > 0) {
    parts.push("Constraints:", ...ctx.constraints.map((c) => `- ${c}`));
  }

  parts.push(`Expected output: ${ctx.expectedOutput}`);

  return parts.join("\n");
}

// Backward-compat for older imports (not used in new code path)
export function previousOutputsFromContext(ctx: SharedTaskContext): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of ctx.agentExecutions) {
    if (entry.summary) map.set(entry.subtaskKey, entry.summary);
  }
  return map;
}
