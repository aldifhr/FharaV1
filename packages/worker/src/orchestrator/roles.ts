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
    defaultCapabilities: [CAPABILITY.COORDINATION, CAPABILITY.GENERAL],
    defaultTools: ["read_file"],
    systemPromptHint: "Break the request into clear requirements and actionable tasks, coordinate the right agents, track progress, summarize results. Do not execute code changes directly.",
  },
  cto: {
    role: "cto",
    displayName: "CTO",
    category: "Leadership",
    description: "Technical architecture, technical decisions, security audit, risk evaluation.",
    defaultCapabilities: [CAPABILITY.ARCHITECTURE, CAPABILITY.SECURITY],
    defaultTools: ["read_file"],
    systemPromptHint: "Decide technical approach, architecture, and risk with brief rationale. Read-only planning and review — no code writing, no over-engineering. Report to the owner in 2-3 plain-language sentences, no bullets, headers, or terminal output.",
  },
  designer: {
    role: "designer",
    displayName: "Designer",
    category: "Product",
    description: "UI/UX, wireframes, design system, component specifications.",
    defaultCapabilities: [CAPABILITY.DESIGN],
    defaultTools: ["read_file", "write_file"],
    systemPromptHint: "Produce implementable design specs (layout, components, tokens, states, responsive) with accessibility considered. Design only — no code edits.",
  },
  frontend: {
    role: "frontend",
    displayName: "Frontend Developer",
    category: "Engineering",
    description: "React and Next.js development. UI implementation.",
    defaultCapabilities: [CAPABILITY.FRONTEND],
    defaultTools: ["read_file", "write_file", "run_command"],
    systemPromptHint: "Implement exactly the assigned frontend subtask, reusing UI primitives; strict TypeScript, accessible markup, English copy. Report changed files and limits. Never mark the global task complete.",
  },
  backend: {
    role: "backend",
    displayName: "Backend Developer",
    category: "Engineering",
    description: "API development and server-side business logic.",
    defaultCapabilities: [CAPABILITY.BACKEND],
    defaultTools: ["read_file", "write_file", "run_command"],
    systemPromptHint: "Implement exactly the assigned backend subtask (Convex functions, schema, validation), keeping security invariants and additive schema changes. Report changed files and limits. Never mark the global task complete.",
  },
  qa: {
    role: "qa",
    displayName: "QA Engineer",
    category: "Quality",
    description: "Test planning, execution, bug detection, quality verification.",
    defaultCapabilities: [CAPABILITY.BROWSER_TESTING],
    defaultTools: ["read_file", "run_command"],
    systemPromptHint: "Verify with the narrowest relevant checks and report evidence. Distinguish executed tests from proposed ones — never fabricate results. Defects go back to the implementer with a concrete repro.",
  },
  growth: {
    role: "growth",
    displayName: "Growth Specialist",
    category: "Growth",
    description: "SEO, product growth, analytics, metrics, user engagement.",
    defaultCapabilities: [CAPABILITY.GROWTH],
    defaultTools: ["read_file"],
    systemPromptHint: "Tie every recommendation to a measurable goal (clicks, signups, retention). Advise and specify — implementation stays with the engineer agent.",
  },
  support: {
    role: "support",
    displayName: "Support Specialist",
    category: "Operations",
    description: "Documentation, user support, operational assistance, troubleshooting.",
    defaultCapabilities: [CAPABILITY.DOCUMENTATION],
    defaultTools: ["read_file", "write_file"],
    systemPromptHint: "Answer the actual question first, then the how. Never invent features or behavior — check the code or say it is unknown. Docs and guidance only, no code changes.",
  },
  devops: {
    role: "devops",
    displayName: "DevOps Engineer",
    category: "Engineering",
    description: "Docker, CI/CD, deployment, infrastructure.",
    defaultCapabilities: [CAPABILITY.GITHUB, CAPABILITY.SHELL_EXECUTION],
    defaultTools: ["read_file", "run_command"],
    systemPromptHint: "Changes are policy-gated. Prefer minimal, reversible infra changes; report exact commands run and their output.",
  },
  reviewer: {
    role: "reviewer",
    displayName: "Reviewer",
    category: "Quality",
    description: "Independent code review. Evaluates implementation quality.",
    defaultCapabilities: [CAPABILITY.CODE_REVIEW],
    defaultTools: ["read_file"],
    systemPromptHint: "Review diffs independently with file references. Never silently modify code or approve your own work.",
  },
  researcher: {
    role: "researcher",
    displayName: "Researcher",
    category: "Research",
    description: "Technical research and information gathering.",
    defaultCapabilities: [CAPABILITY.RESEARCH],
    defaultTools: ["read_file"],
    systemPromptHint: "Prefer official docs; distinguish facts from assumptions with sources. Read-only research — no file modifications.",
  },
  "product-analyst": {
    role: "product-analyst",
    displayName: "Product Analyst",
    category: "Product",
    description: "Requirement analysis and acceptance criteria.",
    defaultCapabilities: [CAPABILITY.RESEARCH],
    defaultTools: ["read_file"],
    systemPromptHint: "Structure requirements into acceptance criteria with explicit scope boundaries. Do not expand scope.",
  },
  "ui-ux": {
    role: "ui-ux",
    displayName: "UI/UX Designer",
    category: "Product",
    description: "User experience and interface design.",
    defaultCapabilities: [CAPABILITY.DESIGN],
    defaultTools: ["read_file"],
    systemPromptHint: "Design guidance only — layout, hierarchy, and UX rationale. The Frontend Developer implements it.",
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
