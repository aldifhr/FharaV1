/**
 * The one LLM chain (P1d / L4): every call (planner, decision advisor,
 * executor, reviewer, chat, memory, commit) walks the same ordered list.
 *
 * Source: the global mode (fallback | round robin) and the ordered model
 * list in Settings → LLM & Models. Nothing per agent: the per-agent
 * assignment, fallback, selection policy and runtime were retired in L4.
 *
 * One optional override: with FHARA_LLM_ROLE_OVERRIDE on, the project's
 * model for the call's role (projects.modelTiers planner / reviewer /
 * worker) goes first and the global list follows as the fallback. With the
 * toggle off (the default) tiers are ignored everywhere.
 *
 * Pure module (no Convex import): backend chat (lib/chat/llm.ts), the
 * Reviewer action and the worker resolver (packages/worker/src/llm/resolver.ts)
 * all order through `orderChain`, so the same pool gives the same chain.
 */
import { applySelectionMode, orderPoolPairs, type OrderableConnection, type PoolPair } from "./llmOrder";
import type { StickyCursor } from "./llmRotation";
import type { LlmSelectionMode } from "./llmSelection";
import { tierForRole, type ModelTierKey, type ModelTiers } from "./modelTiers";

export interface ChainOptions<C extends OrderableConnection> {
  /** The global mode: fallback keeps the list, round robin rotates its start. */
  mode?: LlmSelectionMode;
  /** Sticky rotation cursor for round robin. */
  cursor: StickyCursor;
  /** The model row (llmModels id) the role override puts first; undefined = none. */
  tierModelRowId?: string;
  /** Extra filter (a model the call needs, a healthy connection). */
  accept?: (pair: PoolPair<C>) => boolean;
}

const pairKey = (pair: { connection: { _id: string }; model: { modelId: string } }) =>
  `${String(pair.connection._id)}::${pair.model.modelId}`;

/**
 * The ordered chain for one call: the global model list (Settings order),
 * rotated in round robin; with a tier model, that model first and the rest
 * of the list after it in list order (the tier is an explicit choice, so it
 * is not rotated away). No repeats. A tier model the pool does not serve is
 * ignored, which is the same as no tier.
 */
export function orderChain<C extends OrderableConnection>(pool: readonly C[], options: ChainOptions<C>): PoolPair<C>[] {
  const ordered = orderPoolPairs(pool, options.accept);
  const tierId = options.tierModelRowId;
  const head = tierId ? ordered.filter((pair) => String(pair.model._id ?? "") === String(tierId)) : [];
  if (head.length === 0) return applySelectionMode(ordered, options.mode, options.cursor);
  const seen = new Set(head.map(pairKey));
  return [...head, ...ordered.filter((pair) => !seen.has(pairKey(pair)))];
}

/**
 * The tier a call resolves on: the planner and decision calls run on the
 * planner tier and the review call on the reviewer tier whoever serves
 * them; every other call uses the agent's role.
 */
export function tierForCall(callRole: string | undefined, agentRole: string | undefined): ModelTierKey | null {
  if (callRole === "planner" || callRole === "decision") return "planner";
  if (callRole === "reviewer") return "reviewer";
  return tierForRole(agentRole);
}

/** The model row the override puts first, or undefined when the toggle is off or no tier applies. */
export function overrideModelFor(
  roleOverride: boolean | undefined,
  tiers: ModelTiers | undefined,
  callRole: string | undefined,
  agentRole: string | undefined
): string | undefined {
  if (!roleOverride || !tiers) return undefined;
  const tier = tierForCall(callRole, agentRole);
  return tier ? tiers[tier] : undefined;
}
