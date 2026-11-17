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
  // Plan-020 auto-approval seam: tryAutoApprove only reaches this for a task
  // already in full_access/auto_edits mode, so a permissive default never
  // widens a supervised fixture.
  autoApprove: async () => ({ autoApproved: true, reason: "test", mode: "full_access" }),
};

export function withApiDefaults<T extends object>(api: T): T & typeof API_DEFAULTS {
  const target = api as Record<string, unknown>;
  for (const [key, value] of Object.entries(API_DEFAULTS)) {
    if (typeof target[key] !== "function") target[key] = value;
  }
  return api as T & typeof API_DEFAULTS;
}
