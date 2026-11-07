/**
 * Plan 008 — Role & Agent System.
 *
 * Roles are configuration (capabilities + instructions + tool defaults)
 * executed by the Agent Runtime when invoked, NOT permanent workers.
 * There is exactly one Orchestrator (role `cto`). The registry here is a
 * worker-side mirror of backend `agents` rows (name/role/capabilities/
 * supportedTools/isEnabled); the DB remains the persisted registry — no
 * second registry is created.
 */
import { CAPABILITY } from "./types";
import { capabilitiesOf } from "./capabilities";
import type { AgentDefinition } from "./types";

export type AgentRole =
  | "cto"
  | "developer"
  | "qa"
  | "reviewer"
  | "researcher"
  | "technical-writer"
  | "architect"
  | "devops"
  | "security"
  | "database"
  | "ui-ux"
  | "product-analyst"
  | "frontend"
  | "backend"
  | "general";

export interface RoleDefinition {
  role: AgentRole;
  displayName: string;
  description: string;
  defaultCapabilities: string[];
  defaultTools: string[];
  systemPromptHint: string;
}

export const ROLE_DEFINITIONS: Record<AgentRole, RoleDefinition> = {
  cto: {
    role: "cto",
    displayName: "Chief Technology Officer (Orchestrator)",
    description: "Central task controller. Owns lifecycle, never executes hands-on code.",
    defaultCapabilities: [CAPABILITY.ARCHITECTURE, CAPABILITY.RESEARCH, CAPABILITY.GENERAL],
    defaultTools: ["read_file"],
    systemPromptHint: "Decide scope, plan, and acceptance criteria. Do not implement. Assess before delegating.",
  },
  developer: {
    role: "developer",
    displayName: "Developer",
    description: "Software implementation and code modification.",
    defaultCapabilities: [CAPABILITY.FRONTEND, CAPABILITY.BACKEND],
    defaultTools: ["read_file", "write_file", "run_command"],
    systemPromptHint: "Work within assigned scope. Report changed files and limitations. Never mark the global task complete.",
  },
  qa: {
    role: "qa",
    displayName: "QA Engineer",
    description: "Testing and quality verification.",
    defaultCapabilities: [CAPABILITY.BROWSER_TESTING],
    defaultTools: ["read_file", "run_command"],
    systemPromptHint: "Distinguish executed from proposed tests. Never fabricate results. Report failures with evidence.",
  },
  reviewer: {
    role: "reviewer",
    displayName: "Reviewer",
    description: "Independent code and implementation review.",
    defaultCapabilities: [CAPABILITY.CODE_REVIEW],
    defaultTools: ["read_file"],
    systemPromptHint: "Review diffs. Provide file references. Never silently modify code or approve own work.",
  },
  researcher: {
    role: "researcher",
    displayName: "Researcher",
    description: "Technical research and information gathering.",
    defaultCapabilities: [CAPABILITY.RESEARCH],
    defaultTools: ["read_file"],
    systemPromptHint: "Prefer official docs. Distinguish facts from assumptions. No file modifications.",
  },
  "technical-writer": {
    role: "technical-writer",
    displayName: "Technical Writer",
    description: "Technical documentation and reporting.",
    defaultCapabilities: ["documentation"],
    defaultTools: ["read_file"],
    systemPromptHint: "Document only what is implemented. Never claim unimplemented features are done.",
  },
  architect: {
    role: "architect",
    displayName: "Architect",
    description: "System architecture design. Specialist, not a second Orchestrator.",
    defaultCapabilities: [CAPABILITY.ARCHITECTURE],
    defaultTools: ["read_file"],
    systemPromptHint: "Design within the Orchestrator's plan. Decisions finalize with the CTO.",
  },
  devops: {
    role: "devops",
    displayName: "DevOps Engineer",
    description: "CI/CD, Docker, deployment, infra.",
    defaultCapabilities: [CAPABILITY.SHELL_EXECUTION, CAPABILITY.BACKEND],
    defaultTools: ["read_file", "run_command"],
    systemPromptHint: "Changes are policy-gated. Report infra evidence.",
  },
  security: {
    role: "security",
    displayName: "Security Engineer",
    description: "Threat analysis, vulnerability assessment.",
    defaultCapabilities: [CAPABILITY.SECURITY, CAPABILITY.CODE_REVIEW],
    defaultTools: ["read_file"],
    systemPromptHint: "Read-only by default. Severity + file refs required.",
  },
  database: {
    role: "database",
    displayName: "Database Engineer",
    description: "Schema design, query optimization, migrations.",
    defaultCapabilities: [CAPABILITY.BACKEND],
    defaultTools: ["read_file"],
    systemPromptHint: "Migrations are additive and reversible. No destructive changes without plan.",
  },
  "ui-ux": {
    role: "ui-ux",
    displayName: "UI/UX Designer",
    description: "User experience, flows, design system.",
    defaultCapabilities: [CAPABILITY.FRONTEND],
    defaultTools: ["read_file"],
    systemPromptHint: "Design guidance only; Developer implements.",
  },
  "product-analyst": {
    role: "product-analyst",
    displayName: "Product Analyst",
    description: "Requirement analysis, acceptance criteria, scope.",
    defaultCapabilities: [CAPABILITY.RESEARCH],
    defaultTools: ["read_file"],
    systemPromptHint: "Structure requirements. Do not expand scope.",
  },
  frontend: {
    role: "frontend",
    displayName: "Frontend Developer",
    description: "Alias to Developer for frontend lane.",
    defaultCapabilities: [CAPABILITY.FRONTEND],
    defaultTools: ["read_file", "write_file", "run_command"],
    systemPromptHint: "Frontend implementation within assigned scope.",
  },
  backend: {
    role: "backend",
    displayName: "Backend Developer",
    description: "Alias to Developer for backend lane.",
    defaultCapabilities: [CAPABILITY.BACKEND],
    defaultTools: ["read_file", "write_file", "run_command"],
    systemPromptHint: "Backend implementation within assigned scope.",
  },
  general: {
    role: "general",
    displayName: "Generalist",
    description: "Fallback general-purpose agent.",
    defaultCapabilities: [CAPABILITY.GENERAL],
    defaultTools: ["read_file"],
    systemPromptHint: "General tasks within scope.",
  },
};

export function normalizeRole(role: string): AgentRole {
  const r = role.trim().toLowerCase();
  if (r === "architect") return "architect"; // legacy DB value — kept, not orchestrator
  if (r === "cto" || r === "orchestrator" || r === "lead" || r === "planner") return "cto";
  if (r === "developer" || r === "frontend developer" || r === "backend developer" || r === "frontend" || r === "backend") return r === "frontend" ? "frontend" : r === "backend" ? "backend" : "developer";
  if (r === "qa" || r === "qa engineer") return "qa";
  if (r === "reviewer" || r === "code-review" || r === "code review") return "reviewer";
  if (r === "researcher" || r === "research") return "researcher";
  if (r === "technical-writer" || r === "technical writer" || r === "documentation" || r === "writer") return "technical-writer";
  if (r === "devops" || r === "dev ops") return "devops";
  if (r === "security" || r === "security auditor" || r === "security engineer") return "security";
  if (r === "database" || r === "database engineer" || r === "db") return "database";
  if (r === "ui-ux" || r === "ux" || r === "designer" || r === "ui/ux designer") return "ui-ux";
  if (r === "product-analyst" || r === "product" || r === "analyst") return "product-analyst";
  if (r === "frontend") return "frontend";
  if (r === "backend") return "backend";
  if (r === "general" || r === "") return "general";
  return "general";
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
  // Simple single-capability task → first matching enabled agent only.
  if (required.length <= 1 && input.taskComplexity !== "complex") {
    const first = enabled.find((a) =>
      required.every((c) => capabilitiesOf(a).includes(c))
    );
    return first ? [first] : [];
  }
  // Complex multi-capability: one per required capability (max 5), deduped.
  const picked: AgentDefinition[] = [];
  for (const cap of required.slice(0, 5)) {
    const agent = enabled.find(
      (a) => capabilitiesOf(a).includes(cap) && !picked.includes(a)
    );
    if (agent) picked.push(agent);
  }
  return picked;
}
