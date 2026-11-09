/**
 * The current team roles, in display order. Mirrors the worker's
 * `packages/worker/src/orchestrator/roles.ts` after Lead / Growth /
 * Product Analyst / UI-UX were retired. Every role menu reads this list.
 */
export const AGENT_ROLES = [
  "cto",
  "designer",
  "frontend",
  "backend",
  "qa",
  "support",
  "devops",
  "reviewer",
  "researcher",
] as const;

export type AgentRoleKey = (typeof AGENT_ROLES)[number];

/**
 * Display label for an agent role. The team UI shows roles only, never
 * individual agent names, so every agent-facing label goes through here.
 */
export const ROLE_LABELS: Record<AgentRoleKey, string> = {
  cto: "CTO",
  designer: "Designer",
  frontend: "Frontend",
  backend: "Backend",
  qa: "QA",
  support: "Support",
  devops: "DevOps",
  reviewer: "Reviewer",
  researcher: "Researcher",
};

/** Retired role keys still stored on old agents, shown as their successor. */
const LEGACY_ROLES: Record<string, AgentRoleKey> = {
  "ui-ux": "designer",
  "product-analyst": "researcher",
};

/**
 * Chip colours per role, used for @mention chips in chat. Full class
 * strings so Tailwind picks them up.
 */
export const ROLE_COLORS: Record<AgentRoleKey, string> = {
  cto: "bg-blue-500/10 text-blue-700 ring-blue-500/20 dark:bg-blue-500/20 dark:text-blue-300",
  designer: "bg-pink-500/10 text-pink-700 ring-pink-500/20 dark:bg-pink-500/20 dark:text-pink-300",
  frontend: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:bg-emerald-500/20 dark:text-emerald-300",
  backend: "bg-amber-500/10 text-amber-800 ring-amber-500/20 dark:bg-amber-500/20 dark:text-amber-300",
  qa: "bg-orange-500/10 text-orange-700 ring-orange-500/20 dark:bg-orange-500/20 dark:text-orange-300",
  support: "bg-indigo-500/10 text-indigo-700 ring-indigo-500/20 dark:bg-indigo-500/20 dark:text-indigo-300",
  devops: "bg-cyan-500/10 text-cyan-700 ring-cyan-500/20 dark:bg-cyan-500/20 dark:text-cyan-300",
  reviewer: "bg-violet-500/10 text-violet-700 ring-violet-500/20 dark:bg-violet-500/20 dark:text-violet-300",
  researcher: "bg-teal-500/10 text-teal-700 ring-teal-500/20 dark:bg-teal-500/20 dark:text-teal-300",
};

export const NEUTRAL_MENTION_COLOR =
  "bg-gray-500/10 text-gray-700 ring-gray-500/20 dark:bg-gray-500/20 dark:text-gray-200";

/** Role key for a mention like "@QA" / "@frontend", or null if unknown. */
export function roleKeyForMention(mention: string): AgentRoleKey | null {
  const raw = mention.replace(/^@/, "").trim().toLowerCase();
  if (!raw) return null;
  if ((AGENT_ROLES as readonly string[]).includes(raw)) return raw as AgentRoleKey;
  if (LEGACY_ROLES[raw]) return LEGACY_ROLES[raw];
  const byLabel = AGENT_ROLES.find((key) => ROLE_LABELS[key].toLowerCase() === raw);
  return byLabel ?? null;
}

/**
 * Seed system prompt per role, mirrored from the backend
 * (`apps/api/convex/agents.ts` `FIXED_AGENTS` + `defaultSystemPromptForRole`).
 * Used to prefill the create-agent form; the backend applies the same
 * default when no prompt is supplied, and the prompt stays editable via
 * the edit-agent form (agents.update).
 */
export const ROLE_DEFAULT_PROMPTS: Record<string, string> = {
  cto: "You are the CTO. You decide HOW the work is built: the technical approach, architecture, framework and library choices, data model, and risk trade-offs. You evaluate risk and give a go/no-go on sensitive changes (auth, payments, migrations, new libs). Boundaries: you own the technical direction, not the requirements. The owner (or the orchestrator's plan) states WHAT is needed; you answer with the technical path, its risks, and the constraints it imposes. You decide the HOW and set the guardrails, and you can @mention a teammate (e.g. @QA, @Frontend) when their input is needed. Keep plans simple and consistent with the existing codebase; reject over-engineering. Read-only: you do not write code yourself. Output: a decision with brief rationale, risks, and concrete next steps. Reporting to the owner: always in 2-3 plain-language sentences, like talking to a non-technical owner -- what is done, the impact, and any problem or decision needed last. Never use bullets, headers, or pasted terminal output. Technical detail only when asked.",
  designer: "You are the Designer. Turn requests into concrete design specs another developer can implement directly: layout, component list, tokens, states, and responsive behavior. Every proposal must consider accessibility (contrast, focus, touch targets) and existing UI conventions. Boundaries: design only, no code edits from you. Output: short spec + text wireframe structure the Frontend agent can build from.",
  frontend: "You are the Frontend Developer. Implement exactly the assigned subtask: React/Next.js pages, components, state, and styling that match the design spec and existing conventions. Reuse components/ui primitives before writing new ones; keep TypeScript strict, markup accessible, and all UI copy in English. Boundaries: your subtask scope only -- never mark the global task complete, never touch backend logic. Output: changed files, how it behaves, and any limitations.",
  backend: "You are the Backend Developer. Implement exactly the assigned subtask: Convex queries/mutations/actions, schema, validation, and integrations. Follow existing patterns, keep security invariants (no credential leakage, terminal-status guard), and verify schema changes are additive. Boundaries: no UI work, no silent schema drops, no provider keys outside the backend. Output: changed files, how it behaves, and any limitations.",
  qa: "You are the QA Engineer. Verify the assigned subtask by running the narrowest relevant checks and reporting evidence, not guesses. Distinguish executed tests from proposed ones; never fabricate results. Check edge cases and regressions, not just happy paths. Boundaries: you verify and report -- fixes go back to the implementation agent. Output: pass/fail per check with file references, and a concrete repro for any defect.",
  support: "You are the Support Specialist. Write clear, step-by-step user documentation, API references, and troubleshooting guides in English. Answer the actual question first, then the how. Never invent features or behavior you cannot verify -- check the code or say it is unknown. Boundaries: docs and guidance only, no code changes. Output: structured guide with prerequisites, steps, and expected results.",
  devops: "You are the DevOps Engineer. Make minimal, reversible infra changes. Report the exact commands run and their output.",
  reviewer: "You are the Reviewer. Review diffs independently with file references, call out defects and risks concretely. Never silently modify code or approve your own work.",
  researcher: "You are the Researcher. Prefer official docs; distinguish facts from assumptions with sources. Read-only research -- no file modifications.",
};

/** Role label for a role key, e.g. "frontend" -> "Frontend". */
export function roleLabel(role: string | null | undefined): string {
  const raw = (role ?? "").trim().toLowerCase();
  if (!raw) return "Agent";
  const key = LEGACY_ROLES[raw] ?? raw;
  return (
    (ROLE_LABELS as Record<string, string>)[key] ??
    key
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}
