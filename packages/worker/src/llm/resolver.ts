import {
  createGlobalLLMProvider,
  getGlobalLLMConfig,
  type GlobalLLMConfig,
  type LLMProvider,
} from "@/llm";
import type { AgentDefinition } from "@/orchestrator/types";
import { decryptApiKey } from "./crypto";
import { providerHealth, type ProviderHealthRegistry } from "./health";

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
}

export interface ResolveNeed {
  modelId?: string;
  requireTools?: boolean;
  requireReasoning?: boolean;
}

export type AgentLlmAssignment = Pick<
  AgentDefinition,
  | "llmProviderId"
  | "llmModelId"
  | "llmFallbackProviderId"
  | "llmFallbackModelId"
  | "llmSelectionPolicy"
> & { name?: string };

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
  options: { random?: () => number } = {}
): AgentResolution {
  const random = options.random ?? Math.random;

  // Empty pool: preserve the historical env-based behavior (Settings has
  // no providers configured; the worker env is the configuration).
  if (pool.length === 0) {
    const config = getGlobalLLMConfig();
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

  // Primary selection: first non-empty healthy tier; lowest priority in
  // it; among equal priorities, weight decides (unless policy="priority").
  let primaryPair: CandidatePair | undefined;
  for (const tier of healthyTiers) {
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

  return { primary: toResolved(primaryPair), fallbackChain };
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
export class TaskLlmResolver {
  constructor(
    private readonly pool: PoolConnection[],
    private readonly health: ProviderHealthRegistry = providerHealth,
    private readonly options: { random?: () => number } = {}
  ) {}

  resolutionFor(
    agent?: AgentLlmAssignment,
    need: ResolveNeed = {}
  ): AgentResolution {
    return resolveForAgent(agent, need, this.pool, this.health, this.options);
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
    const resolution = this.resolutionFor(agent, need);
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

  /** Task-level default (agent-less callers: planner fallback, Stagehand). */
  defaultConfig(): GlobalLLMConfig {
    return this.configFor(undefined);
  }
}

/**
 * Thin wrapper kept for the call sites that historically used a single
 * task config: the task default is simply the resolver's agent-less
 * primary over the materialized pool.
 */
export function resolveTaskLlmConfig(pool: PoolConnection[]): GlobalLLMConfig {
  return new TaskLlmResolver(pool).defaultConfig();
}
