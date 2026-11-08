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
  | "lead"
  | "cto"
  | "designer"
  | "frontend"
  | "backend"
  | "qa"
  | "growth"
  | "support"
  | "devops"
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
  lead: {
    role: "lead",
    displayName: "Lead",
    category: "Leadership",
    description: "Project coordination, task analysis, delegation, collaboration tracking.",
    defaultCapabilities: [CAPABILITY.COORDINATION, CAPABILITY.ARCHITECTURE, CAPABILITY.RESEARCH, CAPABILITY.GENERAL],
    defaultTools: ["read_file"],
    systemPromptHint: "Understand user request, break into actionable subtasks, coordinate specialized agents, track progress.",
  },
  cto: {
    role: "cto",
    displayName: "CTO",
    category: "Leadership",
    description: "Technical architecture, technical decisions, code review, risk evaluation.",
    defaultCapabilities: [CAPABILITY.ARCHITECTURE, CAPABILITY.CODE_REVIEW, CAPABILITY.SECURITY, CAPABILITY.RESEARCH],
    defaultTools: ["read_file"],
    systemPromptHint: "Review technical requirements, evaluate system architecture decisions, identify technical risks, and perform thorough code reviews.",
  },
  designer: {
    role: "designer",
    displayName: "Designer",
    category: "Product",
    description: "UI/UX, wireframes, design system, component specifications.",
    defaultCapabilities: [CAPABILITY.DESIGN, CAPABILITY.FRONTEND],
    defaultTools: ["read_file", "write_file"],
    systemPromptHint: "Create user interface specifications, wireframe concepts, component hierarchies, and design proposals.",
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
    defaultCapabilities: [CAPABILITY.BACKEND, CAPABILITY.SHELL_EXECUTION],
    defaultTools: ["read_file", "write_file", "run_command"],
    systemPromptHint: "Work within assigned scope. Report changed files and limitations. Never mark the global task complete.",
  },
  qa: {
    role: "qa",
    displayName: "QA Engineer",
    category: "Quality",
    description: "Test planning, execution, bug detection, quality verification.",
    defaultCapabilities: [CAPABILITY.BROWSER_TESTING, CAPABILITY.CODE_REVIEW],
    defaultTools: ["read_file", "run_command"],
    systemPromptHint: "Distinguish executed from proposed tests. Never fabricate results. Report failures with evidence.",
  },
  growth: {
    role: "growth",
    displayName: "Growth Specialist",
    category: "Growth",
    description: "SEO, product growth, analytics, metrics, user engagement.",
    defaultCapabilities: [CAPABILITY.GROWTH, CAPABILITY.RESEARCH],
    defaultTools: ["read_file"],
    systemPromptHint: "Optimize user flows, review SEO and metadata, define analytics telemetry, and identify product opportunities.",
  },
  support: {
    role: "support",
    displayName: "Support Specialist",
    category: "Operations",
    description: "Documentation, user support, operational assistance, troubleshooting.",
    defaultCapabilities: [CAPABILITY.DOCUMENTATION, CAPABILITY.RESEARCH, CAPABILITY.GENERAL],
    defaultTools: ["read_file", "write_file"],
    systemPromptHint: "Produce clear documentation, API guides, runbooks, and troubleshooting steps.",
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
    defaultCapabilities: [CAPABILITY.DESIGN, CAPABILITY.FRONTEND],
    defaultTools: ["read_file"],
    systemPromptHint: "Design guidance only; Frontend Developer implements.",
  },
};

export function normalizeRole(role: string): AgentRole {
  const r = role.trim().toLowerCase();
  if (r === "lead" || r === "project lead" || r === "team lead" || r === "coordinator") return "lead";
  if (r === "cto" || r === "orchestrator" || r === "planner" || r === "architect") return "cto";
  if (r === "designer" || r === "ui-ux" || r === "ux" || r === "ui/ux" || r === "ui/ux designer") return "designer";
  if (r === "frontend" || r === "frontend developer" || r === "frontend-developer" || r === "developer") return "frontend";
  if (r === "backend" || r === "backend developer" || r === "backend-developer") return "backend";
  if (r === "qa" || r === "qa engineer" || r === "tester") return "qa";
  if (r === "growth" || r === "growth specialist" || r === "marketing" || r === "seo") return "growth";
  if (r === "support" || r === "support specialist" || r === "documentation" || r === "technical-writer" || r === "writer") return "support";
  if (r === "devops" || r === "dev ops" || r === "devops engineer") return "devops";
  if (r === "reviewer" || r === "code-review" || r === "code review") return "reviewer";
  if (r === "researcher" || r === "research") return "researcher";
  if (r === "product-analyst" || r === "product" || r === "analyst" || r === "product analyst") return "product-analyst";
  if (r === "security" || r === "security auditor" || r === "security engineer" || r === "database" || r === "database engineer" || r === "db") return "backend";
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
