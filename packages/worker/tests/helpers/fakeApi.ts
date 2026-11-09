/**
 * Shared test-fake WorkerApi defaults. The runner grew new required API
 * methods (the plan-015 permission broker `checkPermission`); hand-built
 * fakes that predate them failed with "is not a function". Wrap a fake
 * with `withApiDefaults(api)` to fill in every missing method with a
 * benign default. The fake is mutated IN PLACE (and returned), so tests
 * that inspect or override methods on their own object keep working.
 */
export const API_DEFAULTS = {
  checkPermission: async () => ({ decision: "allow" as const, reason: "test" }),
  saveDynamicSubtasks: async () => ({ inserted: [] }),
  recordLifecycle: async () => undefined,
};

export function withApiDefaults<T extends object>(api: T): T & typeof API_DEFAULTS {
  const target = api as Record<string, unknown>;
  for (const [key, value] of Object.entries(API_DEFAULTS)) {
    if (typeof target[key] !== "function") target[key] = value;
  }
  return api as T & typeof API_DEFAULTS;
}
