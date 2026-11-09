import type { SharedTaskContext, ExecutionHistoryEntry, TaskArtifact, OutstandingIssue } from "@/types";
import type { AgentDefinition } from "@/types";
import { capabilitiesOf } from "@/utils/agentCapabilities";

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
  /** The user's steer/answer text, always rendered (never cut by the decision window). */
  userInstructions?: string[];
  /** taskInputs ids behind `userInstructions`, for the delivery ack. */
  userInputIds?: string[];
  /** Other subtasks of this task that are running or queued right now. */
  siblings?: SiblingSubtask[];
}

/** A subtask of the same task that runs or waits alongside this one. */
export interface SiblingSubtask {
  key: string;
  /** Agent role (or capability when no agent is assigned yet). */
  role: string;
  title: string;
  /** Files/dirs it owns (its allowedPaths); empty = no declared scope. */
  allowedPaths?: string[];
  status: "running" | "queued";
}

/** Bounds for the "Running alongside you" section (token budget). */
const SIBLING_LIMITS = { maxSiblings: 6, maxPathsEach: 4, maxTitleChars: 80, maxChars: 1_200 } as const;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The "Running alongside you" prompt section: each sibling subtask that is
 * running or queued in this task (role, title, owned paths, status) plus
 * the ownership rule. Running siblings are listed first. Bounded: at most
 * `maxSiblings` lines, `maxPathsEach` paths per line, `maxChars` overall;
 * the rest is summarized as "+N more". Empty string when there are none.
 */
export function formatSiblingsSection(
  siblings: SiblingSubtask[] | undefined,
  limits: Partial<typeof SIBLING_LIMITS> = {}
): string {
  if (!siblings || siblings.length === 0) return "";
  const bounds = { ...SIBLING_LIMITS, ...limits };
  const ordered = [...siblings].sort((a, b) =>
    a.status === b.status ? 0 : a.status === "running" ? -1 : 1
  );
  const header = "Running alongside you (other subtasks of this task):";
  const footer =
    "Do not edit files owned by another subtask. If you need a change in one, " +
    "say so through an escalation (out_of_scope_file) or ask, instead of editing it.";
  const lines: string[] = [];
  let used = header.length + footer.length + 2;
  let shown = 0;
  for (const sibling of ordered) {
    if (shown >= bounds.maxSiblings) break;
    const paths = (sibling.allowedPaths ?? []).filter(Boolean);
    const owned =
      paths.length === 0
        ? "no declared files"
        : paths.slice(0, bounds.maxPathsEach).join(", ") +
          (paths.length > bounds.maxPathsEach ? ` (+${paths.length - bounds.maxPathsEach} more)` : "");
    const line = `- [${sibling.status}] ${clip(sibling.role, 40)}: ${clip(sibling.title, bounds.maxTitleChars)} — owns ${owned}`;
    if (used + line.length + 1 > bounds.maxChars) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  const hidden = ordered.length - shown;
  if (hidden > 0) lines.push(`- (+${hidden} more not listed)`);
  return [header, ...lines, footer].join("\n");
}

/** Most recent user inputs kept in a prompt. */
const MAX_USER_INSTRUCTIONS = 10;

export function buildAgentExecutionContext(input: {
  taskContext: SharedTaskContext;
  agent: AgentDefinition;
  assignment: string;
  relevantFilePaths?: string[];
  maxPreviousResults?: number;
  siblings?: SiblingSubtask[];
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

  // User input is rendered on its own, so orchestrator decisions can never
  // push a steer or an answer out of the window (M9: "text lost").
  const userInputs = taskContext.decisions.filter((d) => d.decision === "user_answer").slice(-MAX_USER_INSTRUCTIONS);
  const userInstructions = userInputs.map((d) => d.reason);
  const userInputIds = userInputs.flatMap((d) => (d.inputId ? [d.inputId] : []));
  const relevantDecisions = taskContext.decisions
    .filter((d) => d.decision !== "user_answer")
    .slice(-3)
    .map((d) => `${d.decision}: ${d.reason}`);

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
    userInstructions,
    userInputIds,
    ...(input.siblings && input.siblings.length > 0 ? { siblings: input.siblings } : {}),
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

  if (ctx.userInstructions && ctx.userInstructions.length > 0) {
    parts.push(
      "Instructions from the user during this task (follow them; the latest wins on conflict):",
      ...ctx.userInstructions.map((text) => `- ${text}`)
    );
  }

  if (ctx.relevantDecisions && ctx.relevantDecisions.length > 0) {
    parts.push("Recent decisions:", ...ctx.relevantDecisions.map((d) => `- ${d}`));
  }

  const siblingSection = formatSiblingsSection(ctx.siblings);
  if (siblingSection) parts.push(siblingSection);

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
