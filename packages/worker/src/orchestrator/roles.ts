/**
 * Organization role registry (Plan 008) — exactly the roles in the
 * Organization spec §2–§3:
 *  - cto (Leadership, mandatory Orchestrator)
 *  - frontend, backend, devops (Engineering)
 *  - qa, reviewer (Quality)
 *  - researcher (Research)
 *  - product-analyst, ui-ux (Product)
 *
 * Roles are configuration (capabilities + tool defaults) executed by the
 * Agent Runtime on demand — never permanent workers. `architecture` etc.
 * are capabilities, not extra roles.
 */
import { CAPABILITY } from "./types";
import { capabilitiesOf } from "./capabilities";
import type { AgentDefinition } from "./types";

export type AgentRole =
  | "cto"
  | "frontend"
  | "backend"
  | "devops"
  | "qa"
  | "reviewer"
  | "researcher"
  | "product-analyst"
  | "ui-ux";

export interface RoleDefinition {
  role: AgentRole;
  displayName: string;
  category: string;
  description: string;
  defaultCapabilities: string[];
  defaultTools: string[];
  systemPromptHint: string;
}

export const ROLE_DEFINITIONS: Record<AgentRole, RoleDefinition> = {
  cto: {
    role: "cto",
    displayName: "CTO",
    category: "Leadership",
    description: "Central task controller. Owns lifecycle, never executes hands-on code.",
    defaultCapabilities: [CAPABILITY.ARCHITECTURE, CAPABILITY.RESEARCH, CAPABILITY.GENERAL],
    defaultTools: ["read_file"],
    systemPromptHint: "Decide scope, plan, and acceptance criteria. Do not implement. Assess before delegating.",
  },
  frontend: {
    role: "frontend",
    displayName: "Frontend Developer",
    category: "Engineering",
    description: "React and Next.js development. UI implementation.",
    defaultCapabilities: [CAPABILITY.FRONTEND],
    defaultTools: ["read_file", "write_file", "run_command"],
    systemPromptHint: "Work within assigned scope. Report changed files and limitations. Never mark the global task complete.",
  },
  backend: {
    role: "backend",
    displayName: "Backend Developer",
    category: "Engineering",
    description: "API development and server-side business logic.",
    defaultCapabilities: [CAPABILITY.BACKEND],
    defaultTools: ["read_file", "write_file", "run_command"],
    systemPromptHint: "Work within assigned scope. Report changed files and limitations. Never mark the global task complete.",
  },
  devops: {
    role: "devops",
    displayName: "DevOps Engineer",
    category: "Engineering",
    description: "Docker, CI/CD, deployment, infrastructure.",
    defaultCapabilities: [CAPABILITY.SHELL_EXECUTION, CAPABILITY.BACKEND],
    defaultTools: ["read_file", "run_command"],
    systemPromptHint: "Changes are policy-gated. Report infra evidence.",
  },
  qa: {
    role: "qa",
    displayName: "QA Engineer",
    category: "Quality",
    description: "Test planning and execution. Validates behavior.",
    defaultCapabilities: [CAPABILITY.BROWSER_TESTING],
    defaultTools: ["read_file", "run_command"],
    systemPromptHint: "Distinguish executed from proposed tests. Never fabricate results. Report failures with evidence.",
  },
  reviewer: {
    role: "reviewer",
    displayName: "Reviewer",
    category: "Quality",
    description: "Independent code review. Evaluates implementation quality.",
    defaultCapabilities: [CAPABILITY.CODE_REVIEW],
    defaultTools: ["read_file"],
    systemPromptHint: "Review diffs. Provide file references. Never silently modify code or approve own work.",
  },
  researcher: {
    role: "researcher",
    displayName: "Researcher",
    category: "Research",
    description: "Technical research and information gathering.",
    defaultCapabilities: [CAPABILITY.RESEARCH],
    defaultTools: ["read_file"],
    systemPromptHint: "Prefer official docs. Distinguish facts from assumptions. No file modifications.",
  },
  "product-analyst": {
    role: "product-analyst",
    displayName: "Product Analyst",
    category: "Product",
    description: "Requirement analysis and acceptance criteria.",
    defaultCapabilities: [CAPABILITY.RESEARCH],
    defaultTools: ["read_file"],
    systemPromptHint: "Structure requirements. Do not expand scope.",
  },
  "ui-ux": {
    role: "ui-ux",
    displayName: "UI/UX Designer",
    category: "Product",
    description: "User experience and interface design.",
    defaultCapabilities: [CAPABILITY.FRONTEND],
    defaultTools: ["read_file"],
    systemPromptHint: "Design guidance only; Frontend Developer implements.",
  },
};

export function normalizeRole(role: string): AgentRole {
  const r = role.trim().toLowerCase();
  if (r === "cto" || r === "orchestrator" || r === "lead" || r === "planner" || r === "architect") return "cto";
  if (r === "frontend" || r === "frontend developer" || r === "frontend-developer" || r === "developer") return "frontend";
  if (r === "backend" || r === "backend developer" || r === "backend-developer") return "backend";
  if (r === "devops" || r === "dev ops" || r === "devops engineer") return "devops";
  if (r === "qa" || r === "qa engineer") return "qa";
  if (r === "reviewer" || r === "code-review" || r === "code review") return "reviewer";
  if (r === "researcher" || r === "research") return "researcher";
  if (r === "technical-writer" || r === "technical writer" || r === "documentation" || r === "writer") return "researcher";
  if (r === "security" || r === "security auditor" || r === "security engineer" || r === "database" || r === "database engineer" || r === "db") return "backend";
  if (r === "ui-ux" || r === "ux" || r === "designer" || r === "ui/ux designer") return "ui-ux";
  if (r === "product-analyst" || r === "product" || r === "analyst" || r === "product analyst") return "product-analyst";
  if (r === "general" || r === "") return "frontend";
  return "frontend";
}

export function roleForAgent(agent: AgentDefinition): AgentRole {
  return normalizeRole(agent.role);
}

export function defaultToolsForRole(role: AgentRole): string[] {
  return ROLE_DEFINITIONS[role]?.defaultTools ?? ["read_file"];
}

export function canSelect(role: AgentRole, required: string[]): boolean {
  const caps = new Set(ROLE_DEFINITIONS[role]?.defaultCapabilities ?? []);
  return required.every((c) => caps.has(c.trim().toLowerCase()));
}

export function selectAgentsForTask(input: {
  agents: AgentDefinition[];
  requiredCapabilities: string[];
  taskComplexity?: "simple" | "complex";
}): AgentDefinition[] {
  const enabled = input.agents.filter((a) => a.isEnabled !== false);
  if (enabled.length === 0) return [];
  const required = input.requiredCapabilities.map((c) => c.trim().toLowerCase());
  if (required.length <= 1 && input.taskComplexity !== "complex") {
    const first = enabled.find((a) =>
      required.every((c) => capabilitiesOf(a).includes(c))
    );
    return first ? [first] : [];
  }
  const picked: AgentDefinition[] = [];
  for (const cap of required.slice(0, 5)) {
    const agent = enabled.find(
      (a) => capabilitiesOf(a).includes(cap) && !picked.includes(a)
    );
    if (agent) picked.push(agent);
  }
  return picked;
}
