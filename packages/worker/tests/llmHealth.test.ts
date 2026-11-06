import { describe, expect, it } from "vitest";
import { ProviderHealthRegistry } from "@/llm/health";

/**
 * Circuit breaker semantics (spec §4D): only transient failures count;
 * the circuit opens after 3 consecutive transient failures, stays open
 * for the cooldown, then half-opens — the next outcome decides.
 */
describe("ProviderHealthRegistry", () => {
  it("stays available below the failure threshold", () => {
    const health = new ProviderHealthRegistry();
    health.recordFailure("c1", { transient: true });
    health.recordFailure("c1", { transient: true });
    expect(health.isAvailable("c1")).toBe(true);
    expect(health.isCircuitOpen("c1")).toBe(false);
    expect(health.snapshot("c1").consecutiveTransientFailures).toBe(2);
  });

  it("opens the circuit after 3 consecutive transient failures", () => {
    const health = new ProviderHealthRegistry();
    for (let i = 0; i < 3; i++) health.recordFailure("c1", { transient: true });
    expect(health.isCircuitOpen("c1")).toBe(true);
    expect(health.isAvailable("c1")).toBe(false);
    const snap = health.snapshot("c1");
    expect(snap.consecutiveTransientFailures).toBe(3);
    expect(snap.totalTransientFailures).toBe(3);
    expect(snap.circuitOpenUntil).not.toBeNull();
  });

  it("a success resets the consecutive counter and closes the circuit", () => {
    const health = new ProviderHealthRegistry();
    for (let i = 0; i < 3; i++) health.recordFailure("c1", { transient: true });
    expect(health.isCircuitOpen("c1")).toBe(true);
    health.recordSuccess("c1");
    expect(health.isCircuitOpen("c1")).toBe(false);
    expect(health.snapshot("c1").consecutiveTransientFailures).toBe(0);
    expect(health.snapshot("c1").totalSuccesses).toBe(1);
    // Counter restarted: two more transient failures do not reopen.
    health.recordFailure("c1", { transient: true });
    health.recordFailure("c1", { transient: true });
    expect(health.isAvailable("c1")).toBe(true);
  });

  it("permanent failures neither count toward the circuit nor reset it", () => {
    const health = new ProviderHealthRegistry();
    health.recordFailure("c1", { transient: true });
    health.recordFailure("c1", { transient: true });
    health.recordFailure("c1", { transient: false });
    health.recordFailure("c1", { transient: false });
    expect(health.snapshot("c1").consecutiveTransientFailures).toBe(2);
    expect(health.snapshot("c1").totalTransientFailures).toBe(2);
    expect(health.isAvailable("c1")).toBe(true);
    // The preserved streak still opens the circuit on the next transient hit.
    health.recordFailure("c1", { transient: true });
    expect(health.isCircuitOpen("c1")).toBe(true);
  });

  it("half-opens after the cooldown elapses", () => {
    let now = 1_000_000;
    const health = new ProviderHealthRegistry({ cooldownMs: 60_000, now: () => now });
    for (let i = 0; i < 3; i++) health.recordFailure("c1", { transient: true });
    expect(health.isAvailable("c1")).toBe(false);
    now += 59_999;
    expect(health.isAvailable("c1")).toBe(false);
    now += 1;
    expect(health.isAvailable("c1")).toBe(true);
  });

  it("a transient failure while half-open re-opens the circuit", () => {
    let now = 0;
    const health = new ProviderHealthRegistry({ cooldownMs: 60_000, now: () => now });
    for (let i = 0; i < 3; i++) health.recordFailure("c1", { transient: true });
    now += 60_000;
    expect(health.isAvailable("c1")).toBe(true);
    health.recordFailure("c1", { transient: true });
    expect(health.isAvailable("c1")).toBe(false);
  });

  it("tracks connections independently and reset() clears all state", () => {
    const health = new ProviderHealthRegistry();
    for (let i = 0; i < 3; i++) health.recordFailure("c1", { transient: true });
    expect(health.isCircuitOpen("c1")).toBe(true);
    expect(health.isAvailable("c2")).toBe(true);
    expect(health.snapshot("never-seen")).toEqual({
      consecutiveTransientFailures: 0,
      totalSuccesses: 0,
      totalTransientFailures: 0,
      circuitOpenUntil: null,
    });
    health.reset();
    expect(health.isAvailable("c1")).toBe(true);
    expect(health.snapshot("c1").totalTransientFailures).toBe(0);
  });

  it("honors a custom failure threshold", () => {
    const health = new ProviderHealthRegistry({ failureThreshold: 1 });
    health.recordFailure("c1", { transient: true });
    expect(health.isCircuitOpen("c1")).toBe(true);
  });
});
