/**
 * Model tier per role (plan 022). Pure TypeScript (validator in contractValidators.ts),
 * shared by the backend (schema, project settings), the worker (resolver,
 * estimator) and the web UI (Manage project, runs breakdown).
 *
 * A project may set `modelTiers: { planner?, reviewer?, worker? }`, each an
 * `llmModels` row id. L4: tiers are read only with FHARA_LLM_ROLE_OVERRIDE
 * on; then the role's model goes first and the global model list follows
 * (lib/llmChain.ts). With the toggle off they are ignored everywhere.
 * The CTO plans on the planner tier, the reviewer reviews on the reviewer
 * tier ("strong" tiers), every other role works on the worker tier.
 */

export const MODEL_TIER_KEYS = ["planner", "reviewer", "worker"] as const;
export type ModelTierKey = (typeof MODEL_TIER_KEYS)[number];

export type ModelTiers = Partial<Record<ModelTierKey, string>>;

export const MODEL_TIER_LABELS: Record<ModelTierKey, string> = {
  planner: "Planner (CTO)",
  reviewer: "Reviewer",
  worker: "Workers",
};

export const MODEL_TIER_HINTS: Record<ModelTierKey, string> = {
  planner: "Strong model for planning and decisions",
  reviewer: "Strong model for read-only review",
  worker: "Frontend, Backend, QA, DevOps, Designer, Support, Researcher",
};

const WORKER_ROLES = new Set(["frontend", "backend", "qa", "devops", "designer", "support", "researcher"]);

/** The tier a role resolves on; null for a role outside the fixed team. */
export function tierForRole(role: string | undefined | null): ModelTierKey | null {
  const key = (role ?? "").trim().toLowerCase();
  if (key === "cto" || key === "orchestrator") return "planner";
  if (key === "reviewer") return "reviewer";
  if (WORKER_ROLES.has(key)) return "worker";
  return null;
}

/** Normalise a stored value: only non-empty string ids survive. */
export function normalizeModelTiers(value: unknown): ModelTiers {
  if (!value || typeof value !== "object") return {};
  const out: ModelTiers = {};
  for (const key of MODEL_TIER_KEYS) {
    const id = (value as Record<string, unknown>)[key];
    if (typeof id === "string" && id.trim()) out[key] = id;
  }
  return out;
}
