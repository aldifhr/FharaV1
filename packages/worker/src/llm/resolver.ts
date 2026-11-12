import {
  createGlobalLLMProvider,
  getGlobalLLMConfig,
  type GlobalLLMConfig,
  type LLMProvider,
} from "@/llm";
import { decryptApiKey } from "./crypto";
import { providerHealth, type ProviderHealthRegistry } from "./health";
import { fixedRotationCursor, rotationCursor, type RotationCursor } from "./roundRobin";
import type { ModelTiers } from "@/api/convex/lib/modelTiers";
import { orderChain, overrideModelFor } from "@/api/convex/lib/llmChain";
import type { LlmSelectionMode } from "@/api/convex/lib/llmSelection";
import { matchesModelPattern, orderPoolPairs } from "@/api/convex/lib/llmOrder";
import { isOpencodeConnection, withoutOpencode } from "@/api/convex/lib/opencodeProvider";
import { registerSecretValues } from "@/utils/redact";

export { matchesModelPattern };

/**
 * LLM Resolver (spec §4) — turns the backend provider pool (connections +
 * model registry) into the ordered chain for one call.
 *
 * L4 (P1d): one source. The global mode and the ordered model list
 * (Settings → LLM & Models, llmModels.position) decide the chain for every
 * call — planner, decision advisor, executor, reviewer, memory, commit —
 * through the shared orderChain (lib/llmChain.ts), which backend chat and
 * the Reviewer action use too. Per-agent assignments, fallbacks, selection
 * policies and runtimes are retired. The one optional override is
 * FHARA_LLM_ROLE_OVERRIDE: on, the project's model for the call's role
 * (projects.modelTiers) goes first and the global list follows.
 * Connections whose circuit is open (health registry) are excluded; if
 * that exhausts every candidate the resolver throws an explicit error
 * naming the providers instead of silently returning something wrong. An
 * empty pool falls back to the worker env (LLM_*).
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
  /** Place in the one model list (lib/llmOrder.ts). */
  position?: number;
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
  /** The chosen model and why. */
  routing: ModelRoutingInfo;
}

export interface ResolveNeed {
  modelId?: string;
  /** Call site label for routing records / warnings ("planner", "executor"…). */
  callRole?: string;
}

/** Why a model was chosen. */
export interface ModelRoutingInfo {
  model: string;
  connection: string;
  callRole?: string;
  reason: string;
}

/**
 * What the resolver reads from an agent (L4): its name (error messages) and
 * its role (the role override's tier). Per-agent model fields are retired
 * and never read, so an agent that still carries them resolves the global
 * chain.
 */
export interface AgentLlmAssignment {
  name?: string;
  role?: string;
}

function modelMatchesNeed(model: PoolModel, need: ResolveNeed): boolean {
  if (need.modelId && model.modelId !== need.modelId) return false;
  return true;
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
    // L2: a provider key is a known secret from now on (masked everywhere).
    if (apiKey) registerSecretValues([apiKey]);
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

/** The worker env as the only "connection" (no providers in Settings). */
function envResolution(need: ResolveNeed): AgentResolution {
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
    routing: { model: config.model, connection: "(worker env)", callRole: need.callRole, reason: "worker env model (no providers configured)" },
  };
}

/**
 * Resolve the chain for one call (L4): the global model list through the
 * shared orderChain (lib/llmChain.ts, the same order backend chat and the
 * Reviewer use), rotated in round robin; with the role override on, the
 * tier model first. Pure with respect to the pool + health registry
 * (decryption happened in materializePool). Throws an explicit error
 * naming the candidate providers when nothing can serve the call.
 */
export function resolveForAgent(
  agent: AgentLlmAssignment | undefined,
  need: ResolveNeed,
  pool: PoolConnection[],
  health: ProviderHealthRegistry,
  options: {
    rotation?: RotationCursor;
    /** Plan 032: the app-wide selection mode from the run context. */
    globalMode?: LlmSelectionMode;
    /** L4: the model row the role override puts first (undefined = toggle off / no tier). */
    tierModelRowId?: string;
    /**
     * Plan 038: keep the OpenCode row's entries in the chain. Only the
     * subtask route (executionRouteFor) sets it; every API call resolves
     * over the HTTP connections alone.
     */
    includeOpencode?: boolean;
  } = {}
): AgentResolution {
  const rotation = options.rotation ?? rotationCursor;
  if (!options.includeOpencode) pool = withoutOpencode(pool);
  // Empty pool: the worker env is the configuration (Settings has no providers).
  if (pool.length === 0) return envResolution(need);

  const matches = (pair: CandidatePair) => modelMatchesNeed(pair.model, need);
  const candidates = orderPoolPairs(pool, matches);
  const candidateNames = [...new Set(pool.map((c) => `"${c.name}"`))].join(", ");
  const agentLabel = agent?.name ? ` for agent "${agent.name}"` : "";
  if (candidates.length === 0) {
    throw new Error(
      `No LLM provider can serve${agentLabel}: no enabled connection offers a matching model (need: ${JSON.stringify(need)}). Candidates: ${candidateNames || "(none)"}.`
    );
  }
  // Health filter: circuit-open connections are excluded before the mode
  // rotates the list; if that empties it, the error is explicit.
  const chain = orderChain(pool, {
    mode: options.globalMode,
    cursor: rotation,
    tierModelRowId: options.tierModelRowId,
    accept: (pair) => matches(pair) && health.isAvailable(pair.connection._id),
  });
  const [primaryPair, ...rest] = chain;
  if (!primaryPair) {
    throw new Error(
      `No LLM provider available${agentLabel}: every candidate connection is temporarily excluded by the circuit breaker after repeated transient failures. Candidates: ${candidateNames}.`
    );
  }
  const viaTier = Boolean(options.tierModelRowId) && primaryPair.model._id === options.tierModelRowId;
  const label = `${primaryPair.model.modelId} on ${primaryPair.connection.name}`;
  return {
    primary: toResolved(primaryPair),
    fallbackChain: rest.map(toResolved),
    routing: {
      model: primaryPair.model.modelId,
      connection: primaryPair.connection.name,
      callRole: need.callRole,
      reason: `${label}: ${viaTier ? "project role model (override on), then the model list" : "model list order"}`,
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
 * health registry and hands out the chain for each call.
 */
export interface TaskLlmResolverOptions {
  /** Rotation cursor for round robin (default: process-wide). */
  rotation?: RotationCursor;
  /** Plan 032: the app-wide selection mode ("fallback" | "round_robin"). */
  globalMode?: LlmSelectionMode;
  /** Plan 022: the project's model per role; read only when roleOverride is on. */
  tiers?: ModelTiers;
  /** L4: FHARA_LLM_ROLE_OVERRIDE. Off (default): tiers are ignored. */
  roleOverride?: boolean;
}

export class TaskLlmResolver {
  constructor(
    private readonly pool: PoolConnection[],
    private readonly health: ProviderHealthRegistry = providerHealth,
    private readonly options: TaskLlmResolverOptions = {}
  ) {}

  /** L4: the model row the role override puts first for this call, if any. */
  tierModelFor(agent: AgentLlmAssignment | undefined, need: ResolveNeed = {}): string | undefined {
    return overrideModelFor(this.options.roleOverride, this.options.tiers, need.callRole, agent?.role);
  }

  private resolve(
    agent: AgentLlmAssignment | undefined,
    need: ResolveNeed,
    extra: { rotation?: RotationCursor; includeOpencode?: boolean } = {}
  ): AgentResolution {
    return resolveForAgent(agent, need, this.pool, this.health, {
      rotation: extra.rotation ?? this.options.rotation,
      globalMode: this.options.globalMode,
      tierModelRowId: this.tierModelFor(agent, need),
      ...(extra.includeOpencode ? { includeOpencode: true } : {}),
    });
  }

  resolutionFor(agent?: AgentLlmAssignment, need: ResolveNeed = {}): AgentResolution {
    return this.resolve(agent, need);
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
   * The model an agent's first call would use, picked without consuming
   * a round-robin rotation, for the Task Estimator. Deterministic for a
   * given pool + health state. Null when nothing can serve the agent.
   */
  expectedModelFor(
    agent?: AgentLlmAssignment,
    need: ResolveNeed = {}
  ): { model: string; inputPricePer1k?: number; outputPricePer1k?: number } | null {
    try {
      // The estimator must not consume a rotation.
      const { primary } = this.resolve(agent, need, { rotation: fixedRotationCursor });
      return {
        model: primary.model,
        inputPricePer1k: primary.inputPricePer1k,
        outputPricePer1k: primary.outputPricePer1k,
      };
    } catch {
      return null;
    }
  }

  /** Plan 038: the pool has the OpenCode provider (enabled). */
  hasOpencode(): boolean {
    return this.pool.some((connection) => isOpencodeConnection(connection));
  }

  /**
   * Plan 038: the route for one subtask (native OpenCode or the API), from
   * the same ordered chain as every other call. With every OpenCode entry
   * skipped and no HTTP entry after it, the API resolution over the HTTP
   * connections alone applies (the worker env when there are none).
   */
  executionRouteFor(
    agent: AgentLlmAssignment | undefined,
    gate: OpencodeGate,
    need: ResolveNeed = { callRole: "executor" }
  ): ExecutionRoute {
    const withOpencode = this.resolve(agent, need, { includeOpencode: true });
    const picked = routeFromResolution(withOpencode, gate, need);
    // The HTTP-only fallback must not consume a second rotation.
    const apiOnly = () => this.resolve(agent, need, { rotation: fixedRotationCursor });
    if (picked.route === "native") {
      let apiResolution: AgentResolution | undefined;
      try {
        apiResolution = apiOnly();
      } catch {
        apiResolution = undefined;
      }
      return {
        runtime: "native-provider",
        model: picked.entry.model,
        skipped: picked.skipped,
        ...(apiResolution ? { apiResolution } : {}),
        routing: {
          model: picked.entry.model,
          connection: picked.entry.connectionName,
          callRole: need.callRole,
          reason: `${picked.entry.model} on ${picked.entry.connectionName}: model list order (native OpenCode runtime)`,
        },
      };
    }
    if (picked.route === "api") return { runtime: "api", resolution: picked.resolution, skipped: picked.skipped };
    try {
      return { runtime: "api", resolution: apiOnly(), skipped: picked.skipped };
    } catch (error) {
      const why = picked.skipped.map((entry) => `${entry.model}: ${entry.reason}`).join("; ");
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${why ? ` OpenCode entries skipped: ${why}.` : ""}`
      );
    }
  }

  /** Task-level default (agent-less callers: planner fallback, Stagehand). */
  defaultConfig(): GlobalLLMConfig {
    return this.configFor(undefined);
  }
}

/**
 * Plan 038: can this worker run an OpenCode entry for this subtask? The
 * caller decides (CLI detected, worktree isolation); a reason is shown in
 * the event log when an entry is skipped.
 */
export interface OpencodeGate {
  available: boolean;
  reason?: string;
}

/** An OpenCode entry the route passed over, and why. */
export interface SkippedOpencodeEntry {
  model: string;
  reason: string;
}

/**
 * Plan 038: how one subtask runs. The first entry of the agent's ordered
 * chain (the role model when the override is on, then the list, rotated in
 * round robin) decides:
 * an OpenCode entry = the native runtime with that model; an HTTP entry =
 * the API runtime with the rest of the HTTP chain as its failover. OpenCode
 * entries the gate refuses are skipped, which is the fallback.
 */
export type ExecutionRoute =
  | {
      runtime: "native-provider";
      model: string;
      routing: ModelRoutingInfo;
      /** HTTP-only resolution for the subtask's auxiliary API calls. */
      apiResolution?: AgentResolution;
      skipped: SkippedOpencodeEntry[];
    }
  | { runtime: "api"; resolution: AgentResolution; skipped: SkippedOpencodeEntry[] };

/** Pure: pick the route from a resolution that kept OpenCode entries. */
export function routeFromResolution(
  resolution: AgentResolution,
  gate: OpencodeGate,
  need: ResolveNeed = {}
): { route: "native"; entry: ResolvedLlm; skipped: SkippedOpencodeEntry[] } | { route: "api"; resolution: AgentResolution; skipped: SkippedOpencodeEntry[] } | { route: "none"; skipped: SkippedOpencodeEntry[] } {
  const chain = [resolution.primary, ...resolution.fallbackChain];
  const skipped: SkippedOpencodeEntry[] = [];
  for (const [index, entry] of chain.entries()) {
    if (isOpencodeConnection(entry)) {
      if (gate.available) return { route: "native", entry, skipped };
      skipped.push({ model: entry.model, reason: gate.reason ?? "OpenCode is unavailable" });
      continue;
    }
    const rest = chain.slice(index + 1).filter((candidate) => !isOpencodeConnection(candidate));
    return {
      route: "api",
      skipped,
      resolution: {
        primary: entry,
        fallbackChain: rest,
        routing:
          index === 0
            ? resolution.routing
            : {
                model: entry.model,
                connection: entry.connectionName,
                callRole: need.callRole,
                reason: `${entry.model} on ${entry.connectionName}: next in the model list (OpenCode skipped)`,
              },
      },
    };
  }
  return { route: "none", skipped };
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
