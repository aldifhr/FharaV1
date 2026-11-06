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
 */

export interface ProviderHealthSnapshot {
  consecutiveTransientFailures: number;
  totalSuccesses: number;
  totalTransientFailures: number;
  circuitOpenUntil: number | null;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

interface ConnectionHealth {
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

export class ProviderHealthRegistry {
  private readonly connections = new Map<string, ConnectionHealth>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: ProviderHealthOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? (() => Date.now());
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
  }

  /**
   * Record a failure. Only transient failures count toward the circuit;
   * permanent failures are recorded nowhere except the timestamp — they
   * neither open the circuit nor reset the consecutive counter.
   */
  recordFailure(connectionId: string, options: { transient?: boolean } = {}): void {
    const health = this.entry(connectionId);
    health.lastFailureAt = this.now();
    if (options.transient === false) return;
    health.totalTransientFailures++;
    health.consecutiveTransientFailures++;
    if (health.consecutiveTransientFailures >= this.failureThreshold) {
      health.circuitOpenUntil = this.now() + this.cooldownMs;
    }
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
    return { ...health };
  }

  reset(): void {
    this.connections.clear();
  }
}

/** Process-wide registry shared by every task this worker runs. */
export const providerHealth = new ProviderHealthRegistry();
