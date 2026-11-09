/**
 * Model tier per role (plan 022). Pure TypeScript (validator in contractValidators.ts),
 * shared by the backend (schema, project settings), the worker (resolver,
 * estimator) and the web UI (Manage project, runs breakdown).
 *
 * A project may set `modelTiers: { planner?, reviewer?, worker? }`, each an
 * `llmModels` row id. Precedence when resolving an agent's model:
 *   explicit agent assignment (llmProviderId / llmModelId) > tier > default.
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

export interface TierAssignable {
  role?: string;
  llmProviderId?: string;
  llmModelId?: string;
}

/**
 * The assignment the resolver should use for one agent. An agent with its
 * own provider/model keeps it (explicit beats tier); otherwise the tier's
 * model becomes its preferred model, and the resolver's normal fallback
 * (fallback assignment → pool) still applies when that model is down.
 */
export function applyModelTier<T extends TierAssignable>(
  agent: T | undefined,
  tiers: ModelTiers | undefined
): { assignment: T | undefined; source: "agent" | "tier" | "default"; tier: ModelTierKey | null } {
  const tier = tierForRole(agent?.role);
  if (agent && (agent.llmModelId || agent.llmProviderId)) return { assignment: agent, source: "agent", tier };
  const model = tier ? tiers?.[tier] : undefined;
  if (!model) return { assignment: agent, source: "default", tier };
  return { assignment: { ...(agent ?? ({} as T)), llmModelId: model }, source: "tier", tier };
}
