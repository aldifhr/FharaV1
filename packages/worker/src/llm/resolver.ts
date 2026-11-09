import {
  createGlobalLLMProvider,
  getGlobalLLMConfig,
  type GlobalLLMConfig,
  type LLMProvider,
} from "@/llm";
import type { AgentDefinition } from "@/types";
import { decryptApiKey } from "./crypto";
import { providerHealth, type ProviderHealthRegistry } from "./health";
import { applyModelTier, type ModelTiers } from "@/api/convex/lib/modelTiers";
import {
  describeNeeds,
  hasNeeds,
  missingNeeds,
  resolveModelCapabilities,
  type CapabilityNeeds,
  type CapabilityOverrideRow,
  type ModelCapabilities,
} from "@/api/convex/lib/modelCapabilities";

/**
 * LLM Resolver (spec §4) — turns the backend provider pool (connections +
 * model registry) into a per-agent LLM choice.
 *
 * Selection order for an agent (PLAN Phase 2):
 *   1. The agent's own assignment (llmProviderId/llmModelId).
 *   2. The agent's fallback assignment (llmFallbackProviderId/...ModelId).
 *   3. The pool: connections whose `modelPatterns` allow the model
 *      (patterns are finally CONSUMED here), lowest priority first;
 *      among equal priorities the choice is weighted by `weight`
 *      (also finally consumed) unless the agent's selection policy is
 *      "priority" (deterministic) — policy "fixed" never leaves steps 1–2.
 * Connections whose circuit is open (health registry) are excluded; if
 * that exhausts every candidate the resolver throws an explicit error
 * naming the providers instead of silently returning something wrong.
 *
 * Credentials: pool rows carry only `apiKeyCiphertext`; `materializePool`
 * decrypts it (hard error naming the provider on failure) or falls back to
 * the env var named by the connection's `apiKeyEnv`. Plaintext key fields
 * are never read.
 */

/** Model registry entry as delivered in the backend pool payload. */
export interface PoolModel {
  _id?: string;
  modelId: string;
  displayName?: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  inputPricePer1k?: number;
  outputPricePer1k?: number;
  isAvailable: boolean;
  legacy?: boolean;
}

/** Raw connection row as delivered by the backend (getRunContext/getForProject). */
export interface PoolConnectionRow {
  _id: string;
  name: string;
  provider: string;
  /** Transitional compat: first available modelId. */
  model?: string;
  baseUrl: string;
  apiKeyEnv: string;
  /** @deprecated Legacy plaintext key. Read only as fallback until migration. */
  apiKey?: string;
  apiKeyCiphertext?: string;
  priority: number;
  weight: number;
  modelPatterns?: string[];
  isEnabled?: boolean;
  models?: PoolModel[];
}

/** A connection with its credential materialized (decrypted or env-sourced). */
export interface PoolConnection {
  _id: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKeyEnv: string;
  apiKey: string;
  priority: number;
  weight: number;
  modelPatterns?: string[];
  models: PoolModel[];
}

export interface ResolvedLlm {
  connectionId: string;
  connectionName: string;
  provider: string;
  baseUrl: string;
  /** Model identifier sent to the provider API. */
  model: string;
  /** llmModels registry row id, when the model came from the registry. */
  modelRowId?: string;
  /** Registry pricing for the model (Phase 5 cost attribution). */
  inputPricePer1k?: number;
  outputPricePer1k?: number;
  apiKey: string;
  /** Ready-to-use config for createGlobalLLMProvider. */
  config: GlobalLLMConfig;
}

export interface AgentResolution {
  primary: ResolvedLlm;
  /** Ordered alternatives for in-task fallback (excludes the primary). */
  fallbackChain: ResolvedLlm[];
  /** Capability routing (plan 027): the chosen model and why. */
  routing: ModelRoutingInfo;
}

export interface ResolveNeed {
  modelId?: string;
  requireTools?: boolean;
  requireReasoning?: boolean;
  /** Plan 027: what this call site needs from its model (registry-checked). */
  capabilities?: CapabilityNeeds;
  /** Call site label for routing records / warnings ("planner", "executor"…). */
  callRole?: string;
}

/**
 * Why a model was chosen (plan 027). `fallback` = no candidate satisfied
 * the needs, so the pick is the pre-registry behaviour (and a warning event
 * is due); `skipped` lists earlier-preferred models passed over for a
 * missing capability.
 */
export interface ModelRoutingInfo {
  model: string;
  connection: string;
  callRole?: string;
  needs: CapabilityNeeds;
  satisfied: boolean;
  fallback: boolean;
  missing: string[];
  skipped: Array<{ model: string; connection: string; missing: string[] }>;
  reason: string;
}

/** Capability lookup for one pool pair (resolver option). */
export type CapabilityLookup = (connection: PoolConnection, model: PoolModel) => ModelCapabilities;

/**
 * Capability routing switch: on unless MODEL_CAPABILITY_ROUTING=0/false/off.
 * Off = needs are recorded but never change the pick.
 */
export function capabilityRoutingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env.MODEL_CAPABILITY_ROUTING ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

/** Build the lookup from stored overrides (+ the pool row's registry fields). */
export function capabilityLookupFrom(
  overrides: CapabilityOverrideRow[] | undefined,
  projectId: string | undefined
): CapabilityLookup {
  const cache = new Map<string, ModelCapabilities>();
  return (connection, model) => {
    const key = `${connection._id}::${model.modelId}`;
    let caps = cache.get(key);
    if (!caps) {
      caps = resolveModelCapabilities(model.modelId, {
        overrides,
        projectId,
        registry: {
          contextWindow: model.contextWindow,
          supportsTools: model.supportsTools,
          inputPricePer1k: model.inputPricePer1k,
          outputPricePer1k: model.outputPricePer1k,
        },
      }).capabilities;
      cache.set(key, caps);
    }
    return caps;
  };
}

export type AgentLlmAssignment = Pick<
  AgentDefinition,
  | "llmProviderId"
  | "llmModelId"
  | "llmFallbackProviderId"
  | "llmFallbackModelId"
  | "llmSelectionPolicy"
> & { name?: string; role?: string };

/** Glob match for model patterns: only `*` is special (e.g. `gpt-4*`). */
export function matchesModelPattern(pattern: string, modelId: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(modelId);
}

function modelMatchesNeed(model: PoolModel, need: ResolveNeed): boolean {
  if (need.modelId && model.modelId !== need.modelId) return false;
  if (need.requireTools && model.supportsTools === false) return false;
  if (need.requireReasoning && model.supportsReasoning === false) return false;
  return true;
}

function connectionServesModel(connection: PoolConnection, model: PoolModel): boolean {
  const patterns = connection.modelPatterns;
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((pattern) => matchesModelPattern(pattern, model.modelId));
}

/**
 * Materialize raw pool rows: drop disabled connections, synthesize a model
 * list from the legacy `model` column for unmigrated rows, and resolve each
 * connection's key — decrypting the ciphertext (hard error naming the
 * provider on failure) or reading the env var named by `apiKeyEnv`.
 */
export async function materializePool(
  rows: PoolConnectionRow[] | undefined,
  env: Record<string, string | undefined> = process.env
): Promise<PoolConnection[]> {
  const pool: PoolConnection[] = [];
  for (const row of rows ?? []) {
    if (row.isEnabled === false) continue;
    const models =
      row.models && row.models.length > 0
        ? row.models
        : row.model
          ? [{ modelId: row.model, isAvailable: true, legacy: true }]
          : [];
    let apiKey = "";
    if (row.apiKeyCiphertext) {
      apiKey = await decryptApiKey(row.apiKeyCiphertext, row.name);
    } else if (row.apiKey) {
      // Legacy plaintext fallback: providers saved before encryption was
      // wired up keep their key in this column; the pool must keep serving
      // them until the migration rotates the credential into ciphertext.
      apiKey = row.apiKey.trim();
    } else if (row.apiKeyEnv) {
      apiKey = env[row.apiKeyEnv] ?? "";
    }
    pool.push({
      _id: row._id,
      name: row.name,
      provider: row.provider,
      baseUrl: row.baseUrl,
      apiKeyEnv: row.apiKeyEnv,
      apiKey,
      priority: row.priority,
      weight: row.weight,
      modelPatterns: row.modelPatterns,
      models,
    });
  }
  pool.sort((a, b) => a.priority - b.priority);
  return pool;
}

interface CandidatePair {
  connection: PoolConnection;
  model: PoolModel;
  tier: number;
}

function toResolved(pair: CandidatePair): ResolvedLlm {
  const { connection, model } = pair;
  return {
    connectionId: connection._id,
    connectionName: connection.name,
    provider: connection.provider,
    baseUrl: connection.baseUrl,
    model: model.modelId,
    modelRowId: model._id,
    inputPricePer1k: model.inputPricePer1k,
    outputPricePer1k: model.outputPricePer1k,
    apiKey: connection.apiKey,
    config: {
      provider: connection.provider,
      model: model.modelId,
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
    },
  };
}

/** Weighted index pick: `random` in [0,1); non-positive weights count as 0. */
export function pickWeightedIndex(weights: number[], random: number): number {
  const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
  if (total <= 0) return 0;
  let cursor = random * total;
  for (let i = 0; i < weights.length; i++) {
    cursor -= Math.max(0, weights[i]);
    if (cursor < 0) return i;
  }
  return weights.length - 1;
}

function assignmentTier(
  pairs: CandidatePair[],
  providerId: string | undefined,
  modelRowId: string | undefined,
  tier: number
): CandidatePair[] {
  if (!providerId && !modelRowId) return [];
  return pairs
    .filter(
      (pair) =>
        (!providerId || pair.connection._id === providerId) &&
        (!modelRowId || pair.model._id === modelRowId)
    )
    .map((pair) => ({ ...pair, tier }));
}

/**
 * Resolve the LLM for one agent. Pure with respect to the pool + health
 * registry (decryption happened in materializePool), so it is directly
 * unit-testable. Throws an explicit error naming the candidate providers
 * when nothing can serve the agent.
 */
export function resolveForAgent(
  agent: AgentLlmAssignment | undefined,
  need: ResolveNeed,
  pool: PoolConnection[],
  health: ProviderHealthRegistry,
  options: { random?: () => number; capabilityOf?: CapabilityLookup; capabilityRouting?: boolean } = {}
): AgentResolution {
  const random = options.random ?? Math.random;
  const needs = need.capabilities ?? {};
  const routeByNeeds = options.capabilityRouting !== false && hasNeeds(needs) && Boolean(options.capabilityOf);
  const missingFor = (pair: { connection: PoolConnection; model: PoolModel }): string[] =>
    options.capabilityOf && hasNeeds(needs) ? missingNeeds(options.capabilityOf(pair.connection, pair.model), needs) : [];

  // Empty pool: preserve the historical env-based behavior (Settings has
  // no providers configured; the worker env is the configuration).
  if (pool.length === 0) {
    const config = getGlobalLLMConfig();
    const envConnection: PoolConnection = {
      _id: "", name: "(worker env)", provider: config.provider, baseUrl: config.baseUrl,
      apiKeyEnv: "", apiKey: config.apiKey, priority: 0, weight: 1, models: [],
    };
    const missing = missingFor({ connection: envConnection, model: { modelId: config.model, isAvailable: true } });
    return {
      primary: {
        connectionId: "",
        connectionName: "(worker env)",
        provider: config.provider,
        baseUrl: config.baseUrl,
        model: config.model,
        apiKey: config.apiKey,
        config,
      },
      fallbackChain: [],
      routing: {
        model: config.model,
        connection: "(worker env)",
        callRole: need.callRole,
        needs,
        satisfied: missing.length === 0,
        fallback: missing.length > 0,
        missing,
        skipped: [],
        reason:
          missing.length === 0
            ? `worker env model${hasNeeds(needs) ? ` satisfies ${describeNeeds(needs)}` : ""}`
            : `worker env model is the only choice; it lacks ${missing.join(", ")} (kept, warning)`,
      },
    };
  }

  const allPairs: CandidatePair[] = [];
  for (const connection of pool) {
    for (const model of connection.models) {
      if (!model.isAvailable) continue;
      if (!modelMatchesNeed(model, need)) continue;
      if (!connectionServesModel(connection, model)) continue;
      allPairs.push({ connection, model, tier: 2 });
    }
  }

  const tiers: CandidatePair[][] = [[], [], []];
  tiers[0] = assignmentTier(allPairs, agent?.llmProviderId, agent?.llmModelId, 0);
  tiers[1] = assignmentTier(
    allPairs,
    agent?.llmFallbackProviderId,
    agent?.llmFallbackModelId,
    1
  );
  const assignedKeys = new Set(
    [...tiers[0], ...tiers[1]].map((p) => `${p.connection._id}::${p.model.modelId}`)
  );
  tiers[2] = allPairs.filter(
    (p) => !assignedKeys.has(`${p.connection._id}::${p.model.modelId}`)
  );

  const policy = agent?.llmSelectionPolicy;
  const consideredTiers = policy === "fixed" ? [tiers[0], tiers[1]] : tiers;

  // Health filter: circuit-open connections are excluded. If exclusion
  // empties a tier, fall through to the next; if it empties everything,
  // that is an explicit error, not a silent pick of a dead provider.
  const healthyTiers = consideredTiers.map((tier) =>
    tier.filter((pair) => health.isAvailable(pair.connection._id))
  );
  const totalCandidates = consideredTiers.reduce((n, t) => n + t.length, 0);
  const healthyTotal = healthyTiers.reduce((n, t) => n + t.length, 0);

  const candidateNames = [...new Set(pool.map((c) => `"${c.name}"`))].join(", ");
  const agentLabel = agent?.name ? ` for agent "${agent.name}"` : "";
  if (totalCandidates === 0) {
    throw new Error(
      `No LLM provider can serve${agentLabel}: no enabled connection offers a matching model (need: ${JSON.stringify(need)}). Candidates: ${candidateNames || "(none)"}.`
    );
  }
  if (healthyTotal === 0) {
    throw new Error(
      `No LLM provider available${agentLabel}: every candidate connection is temporarily excluded by the circuit breaker after repeated transient failures. Candidates: ${candidateNames}.`
    );
  }

  // Plan 027: capability needs. When some healthy candidate satisfies the
  // call site's needs, only those are eligible for the primary (tier order
  // kept, so the first satisfying model wins). When none does, selection
  // falls back to the pre-registry behaviour and the routing record says
  // so (the caller emits a warning event) — a working setup never fails
  // here because of the registry.
  const skipped: ModelRoutingInfo["skipped"] = [];
  let selectionTiers = healthyTiers;
  let capabilityFallback = false;
  if (routeByNeeds) {
    const satisfying = healthyTiers.map((tier) => tier.filter((pair) => missingFor(pair).length === 0));
    if (satisfying.some((tier) => tier.length > 0)) {
      const firstTier = satisfying.findIndex((tier) => tier.length > 0);
      for (const tier of healthyTiers.slice(0, firstTier + 1)) {
        for (const pair of tier) {
          const missing = missingFor(pair);
          if (missing.length > 0 && !skipped.some((s) => s.model === pair.model.modelId && s.connection === pair.connection.name)) {
            skipped.push({ model: pair.model.modelId, connection: pair.connection.name, missing });
          }
        }
      }
      selectionTiers = satisfying;
    } else {
      capabilityFallback = true;
    }
  }

  // Primary selection: first non-empty healthy tier; lowest priority in
  // it; among equal priorities, weight decides (unless policy="priority").
  let primaryPair: CandidatePair | undefined;
  for (const tier of selectionTiers) {
    if (tier.length === 0) continue;
    const minPriority = Math.min(...tier.map((p) => p.connection.priority));
    const topPairs = tier.filter((p) => p.connection.priority === minPriority);
    const connections: PoolConnection[] = [];
    for (const pair of topPairs) {
      if (!connections.some((c) => c._id === pair.connection._id)) {
        connections.push(pair.connection);
      }
    }
    let chosen = connections[0];
    if (connections.length > 1 && policy !== "priority") {
      const index = pickWeightedIndex(
        connections.map((c) => c.weight),
        random()
      );
      chosen = connections[index];
    }
    primaryPair = topPairs.find((p) => p.connection._id === chosen._id);
    break;
  }
  if (!primaryPair) {
    // Unreachable given healthyTotal > 0, but keep the failure explicit.
    throw new Error(`No LLM provider available${agentLabel}. Candidates: ${candidateNames}.`);
  }

  // Fallback chain: every other healthy candidate, ordered by tier, then
  // priority, then weight (heavier first), for deterministic behavior.
  // With capability routing, satisfying candidates come first; the rest
  // stay at the end so an in-task failover never loses a working model.
  const satisfiesRank = (p: CandidatePair) => (routeByNeeds && !capabilityFallback && missingFor(p).length > 0 ? 1 : 0);
  const chainPairs = healthyTiers
    .flat()
    .filter(
      (p) =>
        !(
          p.connection._id === primaryPair!.connection._id &&
          p.model.modelId === primaryPair!.model.modelId
        )
    )
    .sort(
      (a, b) =>
        satisfiesRank(a) - satisfiesRank(b) ||
        a.tier - b.tier ||
        a.connection.priority - b.connection.priority ||
        b.connection.weight - a.connection.weight
    );
  const seen = new Set<string>();
  const fallbackChain: ResolvedLlm[] = [];
  for (const pair of chainPairs) {
    const key = `${pair.connection._id}::${pair.model.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fallbackChain.push(toResolved(pair));
  }

  const primaryMissing = missingFor(primaryPair);
  const label = `${primaryPair.model.modelId} on ${primaryPair.connection.name}`;
  let reason: string;
  if (!hasNeeds(needs)) reason = `${label}: pool order (no capability needs)`;
  else if (!options.capabilityOf) reason = `${label}: pool order (no capability registry)`;
  else if (options.capabilityRouting === false) {
    reason = `${label}: pool order (capability routing off)${primaryMissing.length ? `; lacks ${primaryMissing.join(", ")}` : ""}`;
  } else if (capabilityFallback) {
    reason = `${label}: no candidate satisfies ${describeNeeds(needs)}; kept the usual pick (lacks ${primaryMissing.join(", ") || "nothing"})`;
  } else if (skipped.length > 0) {
    reason = `${label}: first model with ${describeNeeds(needs)}; skipped ${skipped.map((s) => `${s.model} (${s.missing.join(", ")})`).join(", ")}`;
  } else {
    reason = `${label}: satisfies ${describeNeeds(needs)}`;
  }
  return {
    primary: toResolved(primaryPair),
    fallbackChain,
    routing: {
      model: primaryPair.model.modelId,
      connection: primaryPair.connection.name,
      callRole: need.callRole,
      needs,
      satisfied: primaryMissing.length === 0,
      fallback: capabilityFallback,
      missing: primaryMissing,
      skipped,
      reason,
    },
  };
}

/** A resolved provider ready to call: config + constructed provider + identity. */
export interface ResolvedProviderHandle {
  connectionId: string;
  connectionName: string;
  config: GlobalLLMConfig;
  provider: LLMProvider;
  /** llmModels registry row id + pricing of the served model (Phase 5). */
  modelRowId?: string;
  inputPricePer1k?: number;
  outputPricePer1k?: number;
}

/**
 * A provider that constructs its real client on first use. Construction
 * can throw (e.g. a connection whose key resolves to empty); deferring it
 * keeps resolution pure and surfaces the error at call time, exactly
 * where the pre-resolver code constructed providers (inside the call).
 */
function lazyProvider(config: GlobalLLMConfig): LLMProvider {
  let real: LLMProvider | undefined;
  const get = () => (real ??= createGlobalLLMProvider(config));
  return {
    complete: (messages, model, opts) => get().complete(messages, model, opts),
    stream: (messages, onChunk, model, opts) => {
      const provider = get();
      if (provider.stream) return provider.stream(messages, onChunk, model, opts);
      return provider.complete(messages, model, opts).then((result) => {
        if (result.content) onChunk(result.content);
        return result;
      });
    },
  };
}

/**
 * Per-task resolver facade: holds the materialized pool + the shared
 * health registry and hands out per-agent configs and provider chains.
 */
export interface TaskLlmResolverOptions {
  random?: () => number;
  tiers?: ModelTiers;
  /** Plan 027: stored capability overrides (global + this project's). */
  capabilityOverrides?: CapabilityOverrideRow[];
  projectId?: string;
  /** Defaults to capabilityRoutingEnabled() (env MODEL_CAPABILITY_ROUTING). */
  capabilityRouting?: boolean;
  /**
   * Called once per distinct (callRole, model, missing) when no candidate
   * satisfied a call site's needs — the runner logs a warning event.
   */
  onCapabilityFallback?: (routing: ModelRoutingInfo, agent?: AgentLlmAssignment) => void;
}

export class TaskLlmResolver {
  private readonly capabilityOf: CapabilityLookup;
  private readonly warned = new Set<string>();

  constructor(
    private readonly pool: PoolConnection[],
    private readonly health: ProviderHealthRegistry = providerHealth,
    private readonly options: TaskLlmResolverOptions = {}
  ) {
    this.capabilityOf = capabilityLookupFrom(options.capabilityOverrides, options.projectId);
  }

  /**
   * Plan 022 precedence: an explicit agent assignment beats the project's
   * model tier for the agent's role, which beats the default pool order.
   * A tier model that is not in the pool resolves like no tier at all.
   */
  assignmentFor(agent?: AgentLlmAssignment): AgentLlmAssignment | undefined {
    const tiered = applyModelTier(agent, this.options.tiers);
    if (tiered.source !== "tier") return agent;
    const modelRowId = tiered.assignment?.llmModelId;
    const served = this.pool.some((connection) => connection.models.some((model) => model._id === modelRowId));
    return served ? tiered.assignment : agent;
  }

  resolutionFor(
    agent?: AgentLlmAssignment,
    need: ResolveNeed = {}
  ): AgentResolution {
    const resolution = resolveForAgent(this.assignmentFor(agent), need, this.pool, this.health, {
      random: this.options.random,
      capabilityOf: this.capabilityOf,
      capabilityRouting: this.options.capabilityRouting ?? capabilityRoutingEnabled(),
    });
    if (resolution.routing.fallback && this.options.onCapabilityFallback) {
      const key = `${resolution.routing.callRole ?? ""}::${resolution.routing.model}::${resolution.routing.missing.join(",")}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        try {
          this.options.onCapabilityFallback(resolution.routing, agent);
        } catch {
          // A warning sink must never break resolution.
        }
      }
    }
    return resolution;
  }

  configFor(agent?: AgentLlmAssignment, need: ResolveNeed = {}): GlobalLLMConfig {
    return this.resolutionFor(agent, need).primary.config;
  }

  /**
   * Provider handles for one agent: primary first, then the fallback chain
   * (used by runLlmCallWithFallback). Providers are constructed lazily —
   * a connection with an unusable config fails explicitly at call time,
   * not during resolution.
   */
  handlesFor(agent?: AgentLlmAssignment, need: ResolveNeed = {}): ResolvedProviderHandle[] {
    return handlesFromResolution(this.resolutionFor(agent, need));
  }

  /**
   * The model an agent's first call would use, picked WITHOUT the weighted
   * random draw (first candidate of the winning tier), for the Task
   * Estimator. Deterministic for a given pool + health state. Null when
   * nothing can serve the agent.
   */
  expectedModelFor(
    agent?: AgentLlmAssignment,
    need: ResolveNeed = {}
  ): { model: string; inputPricePer1k?: number; outputPricePer1k?: number; satisfied?: boolean } | null {
    try {
      const { primary, routing } = resolveForAgent(this.assignmentFor(agent), need, this.pool, this.health, {
        random: () => 0,
        capabilityOf: this.capabilityOf,
        capabilityRouting: this.options.capabilityRouting ?? capabilityRoutingEnabled(),
      });
      return {
        model: primary.model,
        inputPricePer1k: primary.inputPricePer1k,
        outputPricePer1k: primary.outputPricePer1k,
        satisfied: routing.satisfied,
      };
    } catch {
      return null;
    }
  }

  /** Task-level default (agent-less callers: planner fallback, Stagehand). */
  defaultConfig(): GlobalLLMConfig {
    return this.configFor(undefined);
  }
}

/** Handles (primary first, then the fallback chain) for a resolution. */
export function handlesFromResolution(resolution: AgentResolution): ResolvedProviderHandle[] {
  return [resolution.primary, ...resolution.fallbackChain].map((entry) => ({
    connectionId: entry.connectionId,
    connectionName: entry.connectionName,
    config: entry.config,
    provider: lazyProvider(entry.config),
    modelRowId: entry.modelRowId,
    inputPricePer1k: entry.inputPricePer1k,
    outputPricePer1k: entry.outputPricePer1k,
  }));
}
