import type { ExecutionHistoryEntry, ExecutionPlan, OutstandingIssue } from "@/types";

/** The decision-context fields the advisor prompt reads. */
export interface DecisionPromptContext {
  objective: string;
  plan: Pick<ExecutionPlan, "goal">;
  step: number;
  results: Array<Pick<ExecutionHistoryEntry, "subtaskKey" | "status" | "summary" | "findings">>;
  openIssues: Array<Pick<OutstandingIssue, "status" | "severity" | "description">>;
  budget: {
    llmCalls: number;
    maxLLMCalls: number;
    totalTokens: number;
    maxTokenBudget: number;
    agentCount: number;
    maxAgents: number;
    delegationDepth: number;
  };
  /** describeCapabilities(ctx.agents): one line per available agent. */
  capabilityList: string;
}

/** The latest observation the advisor is asked about. */
export interface DecisionPromptObservation {
  outcome: string;
  decision: string;
  reason: string;
  delegationRecommendation?: { targetCapability: string; reason: string } | null;
}

export const DECISION_ACTION_LIST = [
  "execute — run the selected agent on one node",
  "delegate — add work for another capability",
  "call_agent — invoke an agent once (ephemeral, no new subtask)",
  "parallel — add independent nodes in one batch",
  "replan — replace the remaining graph, keep completed work",
  "complete — objective evidence satisfied (requires expectedOutcome)",
  "ask_user — blocked on missing information/approval (requires question)",
].join("\n");

/** The decision advisor prompt (single strict-JSON action). */
export function decisionAdvisorPrompt(ctx: DecisionPromptContext, observation: DecisionPromptObservation): string {
  const lastResults = ctx.results.slice(-6).map((entry) => {
    const findings = entry.findings?.map((finding) => `${finding.severity}:${finding.description}`).join("; ") ?? "";
    return `- ${entry.subtaskKey} [${entry.status}] ${entry.summary ?? ""}${findings ? ` findings: ${findings}` : ""}`;
  });
  const issues = ctx.openIssues
    .filter((issue) => issue.status === "open")
    .slice(-6)
    .map((issue) => `- [${issue.severity}] ${issue.description}`);
  const proposal = observation.delegationRecommendation
    ? `Proposal: agent delegated to capability "${observation.delegationRecommendation.targetCapability}" — reason: ${observation.delegationRecommendation.reason}`
    : "Proposal: none (no delegation was proposed)";
  const remaining = ctx.budget.llmCalls < ctx.budget.maxLLMCalls
    ? `${ctx.budget.llmCalls}/${ctx.budget.maxLLMCalls} LLM calls spent`
    : "LLM call budget exhausted";
  const tokens = `${ctx.budget.totalTokens}/${ctx.budget.maxTokenBudget} tokens spent`;

  return [
    "You are the decision advisor of a multi-agent software engineering orchestrator.",
    "Reply with a single STRICT JSON object and nothing else.",
    "",
    `Objective: ${ctx.objective}`,
    `Plan goal: ${ctx.plan.goal}`,
    `Decision step: ${ctx.step}`,
    `Remaining budget: ${remaining}; ${tokens}; agents ${ctx.budget.agentCount}/${ctx.budget.maxAgents}; delegations ${ctx.budget.delegationDepth}`,
    "",
    "Agents available (only use capabilities listed here):",
    ctx.capabilityList,
    "",
    "Last results (summary only):",
    ...(lastResults.length > 0 ? lastResults : ["- (none)"]),
    "",
    "Open issues:",
    ...(issues.length > 0 ? issues : ["- (none)"]),
    "",
    proposal,
    "",
    `Latest observation: ${observation.outcome}; ${observation.decision}; ${observation.reason}`,
    "",
    "Choose exactly one action:",
    DECISION_ACTION_LIST,
    "",
    'Schema: {"action":"delegate","reasoning":"<=500 chars","target":{"capability":"..."},"task":{"key":"...","title":"...","description":"...","kind":"...","capability":"..."},"dependencies":["..."],"expectedOutcome":"..."}',
    "Rules:",
    `- reasoning must be <= 500 characters.`,
    "- for execute/delegate/parallel: task is required, capability must be in the agent list, dependencies must reference existing subtask keys or keys in the same decision.",
    "- for call_agent: target.capability is required, capability must be in the agent list. No subtask is created.",
    "- for complete: expectedOutcome is required.",
    "- for ask_user: question is required. Add `options` (2-6 short strings) when the answer is a choice between known alternatives — the UI then offers A/B/C buttons instead of a text box.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
