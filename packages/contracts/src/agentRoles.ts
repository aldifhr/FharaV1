import * as Schema from "effect/Schema";

/**
 * Display summary of the fixed agent roles (no prompts). The server registry in
 * `apps/server/src/roles/registry.ts` is the source; a server test keeps the two equal.
 */
export const AGENT_ROLE_IDS = [
  "cto",
  "designer",
  "frontend",
  "backend",
  "qa",
  "reviewer",
  "devops",
  "researcher",
  "support",
] as const;
export type AgentRoleId = (typeof AGENT_ROLE_IDS)[number];

/** Wire schema for the fixed role ids. */
export const AgentRoleIdSchema = Schema.Literals(AGENT_ROLE_IDS);

/** Wire id of a user-created agent, always namespaced under `custom:`. */
export const CustomAgentId = Schema.String.check(Schema.isPattern(/^custom:\S+$/));
export type CustomAgentId = typeof CustomAgentId.Type;

/** A role reference: a fixed role id or a custom agent id. */
export const AgentRoleRefSchema = Schema.Union([AgentRoleIdSchema, CustomAgentId]);
export type AgentRoleRef = typeof AgentRoleRefSchema.Type;

export interface AgentRoleSummary {
  readonly id: AgentRoleId;
  readonly displayName: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly writeScope: ReadonlyArray<string>;
}

export const AGENT_ROLE_SUMMARIES = [
  {
    id: "cto",
    displayName: "CTO",
    description: "Plans the work, makes architecture decisions and splits tasks across roles.",
    readOnly: true,
    writeScope: [],
  },
  {
    id: "designer",
    displayName: "UI/UX Designer",
    description: "Designs user flows, layouts, UI copy and accessibility.",
    readOnly: true,
    writeScope: [],
  },
  {
    id: "frontend",
    displayName: "Frontend",
    description: "Builds UI screens and components in the web app and shared UI package.",
    readOnly: false,
    writeScope: ["apps/web/**", "packages/ui/**"],
  },
  {
    id: "backend",
    displayName: "Backend",
    description: "Builds server logic, APIs, contracts, persistence and shared packages.",
    readOnly: false,
    writeScope: ["apps/server/**", "packages/**", "!packages/ui/**"],
  },
  {
    id: "qa",
    displayName: "QA",
    description: "Writes and runs tests, reproduces bugs and reports quality issues.",
    readOnly: false,
    writeScope: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "e2e/**"],
  },
  {
    id: "reviewer",
    displayName: "Reviewer",
    description: "Reviews diffs for correctness, scope, security and test coverage.",
    readOnly: true,
    writeScope: [],
  },
  {
    id: "devops",
    displayName: "DevOps",
    description: "Owns CI, build tooling, scripts, containers and deployment config.",
    readOnly: false,
    writeScope: [
      ".github/**",
      "scripts/**",
      "Dockerfile*",
      "*.config.*",
      "turbo.json",
      "package.json",
    ],
  },
  {
    id: "researcher",
    displayName: "Researcher",
    description: "Investigates libraries, APIs and prior art and summarizes options with sources.",
    readOnly: true,
    writeScope: [],
  },
  {
    id: "support",
    displayName: "Support",
    description: "Answers questions and maintains docs; the default when no other role fits.",
    readOnly: false,
    writeScope: ["**/*.md", "docs/**"],
  },
] as const satisfies ReadonlyArray<AgentRoleSummary>;
