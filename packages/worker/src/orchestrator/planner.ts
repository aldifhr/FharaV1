import { createProviderForAgent } from "../llm";
import { CAPABILITY, type AgentDefinition, type Classification, type ExecutionPlan } from "./types";
import { routeCapability, capabilitiesOf, describeCapabilities, isAgentEnabled } from "./capabilities";
import { validatePlan } from "./planValidator";
import { extractJson } from "../utils/json";
import type { ExecutionPolicy } from "./policy";

export interface PlannerInput {
  command: string;
  classification: Classification;
  agents: AgentDefinition[];
  policy: ExecutionPolicy;
  feedback?: string;
}

export interface PlannerResult {
  plan: ExecutionPlan;
  createdBy: "orchestrator" | "fallback";
  notes: string[];
  degradedReason?: string;
}

export async function createPlan(input: PlannerInput): Promise<PlannerResult> {
  const notes: string[] = [];
  const orchestrator = pickOrchestrator(input.agents);
  if (orchestrator) {
    try {
      const provider = createProviderForAgent(orchestrator);
      const response = await provider.complete([
        ...(orchestrator.systemPrompt
          ? [{ role: "system" as const, content: orchestrator.systemPrompt }]
          : []),
        { role: "user", content: buildPlanningPrompt(input) },
      ]);
      const parsed = extractJson(response.content);
      const validation = validatePlan(
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? {
              ...(parsed as Record<string, unknown>),
              goal:
                (parsed as Record<string, unknown>).goal ??
                (parsed as Record<string, unknown>).summary ??
                input.command,
            }
          : parsed,
        input.policy.maxSubtasks
      );
      if (validation.ok && validation.plan) {
        const routed = ensureRoutable(validation.plan, input.agents);
        if (routed) return { plan: routed, createdBy: "orchestrator", notes };
        notes.push("planner output references capabilities that no enabled agent can serve");
      } else {
        notes.push(...validation.errors);
      }
    } catch (error) {
      notes.push(
        `LLM planner unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    notes.push("no planner-capable agent found; using deterministic plan");
  }

  return {
    plan: heuristicPlan(input),
    createdBy: "fallback",
    notes,
    degradedReason: notes.join("; "),
  };
}

export function pickOrchestrator(agents: AgentDefinition[]): AgentDefinition | null {
  const enabled = agents.filter(isAgentEnabled);
  if (enabled.length === 0) return null;
  const explicit = enabled.find((agent) =>
    capabilitiesOf(agent).includes(CAPABILITY.ARCHITECTURE)
  );
  if (explicit) return explicit;
  const byRole = enabled.find((agent) => /orchestrator|planner|manager|cto|lead/i.test(agent.role));
  return byRole ?? enabled[0];
}

function buildPlanningPrompt(input: PlannerInput): string {
  const { command, classification, agents, policy } = input;
  return [
    "You are the orchestrator of a multi-agent software engineering system.",
    "Produce an execution plan as STRICT JSON and nothing else.",
    "Agents available (only use capabilities listed here):",
    describeCapabilities(agents),
    "",
    `User task: ${command}`,
    `Classification: ${classification.kind} (${classification.reasons.join("; ")})`,
    `Suggested capabilities: ${classification.suggestedCapabilities.join(", ")}`,
    policy.maxReplans > 0 && input.feedback
      ? `A previous attempt failed. Feedback to address:\n${input.feedback}`
      : "",
    "",
    "Rules:",
    `- 1 to ${policy.maxSubtasks} subtasks.`,
    "- Each subtask: key (lowercase slug), title, description, kind, capability, dependencies (keys), order.",
    "- kind is one of: analysis, code_change, review, qa, research, audit.",
    "- Dependencies must reference earlier subtasks and must not form cycles.",
    "- code_change subtasks must be reviewed by a code-review capable agent when one exists.",
    "- qa must depend on the implementation and run AFTER approval/apply.",
    "- Do NOT invent capabilities that are not listed above.",
    "- Keep the plan minimal; do not add decorative steps.",
    "",
    'Schema: {"goal":"...","strategy":"single"|"dag","requiresApproval":true,"maxConcurrency":2,"subtasks":[{"key":"implement","title":"...","description":"...","kind":"code_change","capability":"frontend-development","dependencies":[],"order":0}]}',
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function ensureRoutable(plan: ExecutionPlan, agents: AgentDefinition[]): ExecutionPlan | null {
  const missing: string[] = [];
  for (const subtask of plan.subtasks) {
    const agent = routeCapability(subtask.capability, agents);
    if (!agent) missing.push(subtask.capability);
  }
  if (missing.length > 0) return null;
  return plan;
}

export function heuristicPlan(input: PlannerInput): ExecutionPlan {
  const { classification, command, agents } = input;
  const goal = command.slice(0, 500);
  const hasCapability = (capability: string) =>
    agents.some(
      (agent) => isAgentEnabled(agent) && capabilitiesOf(agent).includes(capability)
    );

  if (classification.kind === "conversation") {
    return {
      version: 1,
      goal,
      strategy: "direct",
      requiresApproval: false,
      maxConcurrency: 1,
      subtasks: [
        {
          key: "reply",
          title: "Reply to the user",
          description:
            "Respond briefly and ask for the concrete change the user wants. Do not modify files.",
          kind: "analysis",
          capability: CAPABILITY.GENERAL,
          dependencies: [],
          order: 0,
        },
      ],
    };
  }

  if (classification.kind === "audit") {
    const capability = hasCapability(CAPABILITY.SECURITY)
      ? CAPABILITY.SECURITY
      : CAPABILITY.CODE_REVIEW;
    return {
      version: 1,
      goal,
      strategy: "single",
      requiresApproval: false,
      maxConcurrency: 1,
      subtasks: [
        {
          key: "audit",
          title: "Repository audit",
          description: "Read-only audit. Report concrete findings with file references. Do not modify files.",
          kind: "audit",
          capability,
          dependencies: [],
          order: 0,
        },
      ],
    };
  }

  if (classification.kind === "research") {
    return {
      version: 1,
      goal,
      strategy: "single",
      requiresApproval: false,
      maxConcurrency: 1,
      subtasks: [
        {
          key: "research",
          title: "Answer the question",
          description: "Read the repository and answer the question with evidence. Do not modify files.",
          kind: "research",
          capability: hasCapability(CAPABILITY.RESEARCH)
            ? CAPABILITY.RESEARCH
            : CAPABILITY.CODE_REVIEW,
          dependencies: [],
          order: 0,
        },
      ],
    };
  }

  const subtasks: ExecutionPlan["subtasks"] = [];
  if (classification.kind === "multi") {
    subtasks.push({
      key: "implement_frontend",
      title: "Implement frontend changes",
      description: `Implement the frontend portion of: ${command}`,
      kind: "code_change",
      capability: CAPABILITY.FRONTEND,
      dependencies: [],
      order: 0,
    });
    subtasks.push({
      key: "implement_backend",
      title: "Implement backend changes",
      description: `Implement the backend portion of: ${command}`,
      kind: "code_change",
      capability: CAPABILITY.BACKEND,
      dependencies: [],
      order: 1,
    });
    subtasks.push({
      key: "review",
      title: "Review the implementation",
      description: "Review all prepared diffs for correctness, regressions and missing cases.",
      kind: "review",
      capability: CAPABILITY.CODE_REVIEW,
      dependencies: ["implement_frontend", "implement_backend"],
      order: 2,
    });
  } else {
    subtasks.push({
      key: "implement",
      title: "Implement the change",
      description: command,
      kind: "code_change",
      capability: classification.suggestedCapabilities[0] ?? CAPABILITY.FRONTEND,
      dependencies: [],
      order: 0,
    });
    subtasks.push({
      key: "review",
      title: "Review the change",
      description: "Review the prepared diff for correctness, regressions and missing cases.",
      kind: "review",
      capability: CAPABILITY.CODE_REVIEW,
      dependencies: ["implement"],
      order: 1,
    });
  }

  if (hasCapability(CAPABILITY.BROWSER_TESTING)) {
    subtasks.push({
      key: "qa",
      title: "Verify in a browser",
      description:
        "Run the app after changes are applied and verify responsiveness, console errors and network failures.",
      kind: "qa",
      capability: CAPABILITY.BROWSER_TESTING,
      dependencies: ["review"],
      order: subtasks.length,
    });
  }

  return {
    version: 1,
    goal,
    strategy: subtasks.length > 1 ? "dag" : "single",
    requiresApproval: true,
    maxConcurrency: 2,
    subtasks,
  };
}
