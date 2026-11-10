/**
 * Provider health registry (spec §4D) — in-memory, per worker process.
 *
 * Tracks consecutive TRANSIENT failures per provider connection. After
 * `failureThreshold` (default 3) consecutive transient failures the circuit
 * opens: the resolver excludes the connection for `cooldownMs` (default
 * 60s). After the cooldown the circuit is half-open — the connection is
 * eligible again; one more transient failure re-opens it, a success closes
 * it (counters reset). Permanent errors (4xx) never count: they indicate a
 * bad request/credential, not an unhealthy provider, and must not sideline
 * a connection.
 *
 * Rate limits are the exception to the threshold (lib/llmRotation.ts,
 * rules adapted from 9router): a 429 or rate-limit wording opens the
 * circuit at once for an exponential backoff (2s, 4s, … max 5 min) that
 * grows with each consecutive rate limit and resets on success.
 */
import { cooldownForFailure } from "@/api/convex/lib/llmRotation";

export interface ProviderHealthSnapshot {
  consecutiveTransientFailures: number;
  totalSuccesses: number;
  totalTransientFailures: number;
  circuitOpenUntil: number | null;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

interface ConnectionHealth {
  rateLimitLevel?: number;
  consecutiveTransientFailures: number;
  totalSuccesses: number;
  totalTransientFailures: number;
  circuitOpenUntil: number | null;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

export interface ProviderHealthOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;

export type ProviderHealthChangeListener = (
  connectionId: string,
  snapshot: ProviderHealthSnapshot
) => void;

export class ProviderHealthRegistry {
  private readonly connections = new Map<string, ConnectionHealth>();
  private readonly connectionNames = new Map<string, string>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private changeListener: ProviderHealthChangeListener | undefined;

  constructor(options: ProviderHealthOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Observe every recorded outcome (Phase 5 observability): the runner
   * installs a reporter that mirrors snapshots to the backend so the
   * Settings UI can show circuit state per connection. One listener —
   * installing a new one replaces the previous.
   */
  setChangeListener(listener: ProviderHealthChangeListener | undefined): void {
    this.changeListener = listener;
  }

  /**
   * Remember a pool connection's display name (Phase 5 mirror): the
   * runner registers names as it materializes each task's provider
   * pool, and the backend reporter uses them to key snapshots the way
   * the Settings panel expects. Connections never registered (e.g.
   * env-fallback pseudo-connections) have no backend row to mirror to.
   */
  registerConnectionName(connectionId: string, name: string): void {
    this.connectionNames.set(connectionId, name);
  }

  connectionName(connectionId: string): string | undefined {
    return this.connectionNames.get(connectionId);
  }

  private notifyChange(connectionId: string): void {
    if (!this.changeListener) return;
    try {
      this.changeListener(connectionId, this.snapshot(connectionId));
    } catch {
      // A broken observer must never break a provider call path.
    }
  }

  private entry(connectionId: string): ConnectionHealth {
    let health = this.connections.get(connectionId);
    if (!health) {
      health = {
        consecutiveTransientFailures: 0,
        totalSuccesses: 0,
        totalTransientFailures: 0,
        circuitOpenUntil: null,
      };
      this.connections.set(connectionId, health);
    }
    return health;
  }

  recordSuccess(connectionId: string): void {
    const health = this.entry(connectionId);
    health.totalSuccesses++;
    health.lastSuccessAt = this.now();
    health.consecutiveTransientFailures = 0;
    health.circuitOpenUntil = null;
    health.rateLimitLevel = 0;
    this.notifyChange(connectionId);
  }

  /**
   * Record a failure. Only transient failures count toward the circuit;
   * permanent failures are recorded nowhere except the timestamp — they
   * neither open the circuit nor reset the consecutive counter.
   */
  recordFailure(
    connectionId: string,
    options: { transient?: boolean; error?: unknown } = {}
  ): void {
    const health = this.entry(connectionId);
    health.lastFailureAt = this.now();
    if (options.transient === false) return;
    health.totalTransientFailures++;
    health.consecutiveTransientFailures++;
    const cooldown = options.error === undefined ? undefined : cooldownForFailure(options.error, health.rateLimitLevel ?? 0);
    if (cooldown?.kind === "rate_limit") {
      health.rateLimitLevel = cooldown.backoffLevel;
      const until = this.now() + cooldown.cooldownMs;
      health.circuitOpenUntil = Math.max(health.circuitOpenUntil ?? 0, until);
    } else if (health.consecutiveTransientFailures >= this.failureThreshold) {
      health.circuitOpenUntil = this.now() + this.cooldownMs;
    }
    this.notifyChange(connectionId);
  }

  /**
   * Whether the resolver may pick this connection right now. An open
   * circuit whose cooldown has elapsed is half-open: eligible again (the
   * next outcome decides — success closes, transient failure re-opens).
   */
  isAvailable(connectionId: string): boolean {
    const health = this.connections.get(connectionId);
    if (!health || health.circuitOpenUntil === null) return true;
    return this.now() >= health.circuitOpenUntil;
  }

  isCircuitOpen(connectionId: string): boolean {
    return !this.isAvailable(connectionId);
  }

  snapshot(connectionId: string): ProviderHealthSnapshot {
    const health = this.connections.get(connectionId);
    if (!health) {
      return {
        consecutiveTransientFailures: 0,
        totalSuccesses: 0,
        totalTransientFailures: 0,
        circuitOpenUntil: null,
      };
    }
    const { rateLimitLevel: _level, ...snapshot } = health;
    return snapshot;
  }

  /**
   * Every tracked connection's snapshot (Phase 5 observability): the
   * Settings panel renders one circuit row per entry. Connections with
   * no recorded outcome yet are absent — the UI treats "no row" as
   * "no data", not as healthy.
   */
  snapshots(): Map<string, ProviderHealthSnapshot> {
    const out = new Map<string, ProviderHealthSnapshot>();
    for (const connectionId of this.connections.keys()) {
      out.set(connectionId, this.snapshot(connectionId));
    }
    return out;
  }

  reset(): void {
    this.connections.clear();
  }
}

/** Process-wide registry shared by every task this worker runs. */
export const providerHealth = new ProviderHealthRegistry();
