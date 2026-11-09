/**
 * Replan section of /runs (Replan Intelligence): read the `replan` record
 * the worker stores on each replanned plan version's payload into a
 * display shape. Pure (no Convex APIs) and defensive — payloads are
 * `v.any()`, older versions have no record, and nothing here may throw.
 */

export interface ReplanViewEntry {
  key: string;
  title: string;
  kind: string;
  capability: string;
  fields: string[];
  reasoning: string | null;
  frozen: boolean;
  restored: boolean;
  outsideImpact: boolean;
}

export interface ReplanView {
  fromVersion: number;
  toVersion: number;
  createdAt: number;
  reason: string;
  failedKeys: string[];
  impactKeys: string[];
  frozenKeys: string[];
  attempts: number;
  rejected: string[];
  reasoningMissing: string[];
  added: ReplanViewEntry[];
  removed: ReplanViewEntry[];
  modified: ReplanViewEntry[];
  preserved: ReplanViewEntry[];
}

const TEXT_CAP = 600;

function str(value: unknown, cap = TEXT_CAP): string {
  return typeof value === "string" ? value.slice(0, cap) : "";
}

function strings(value: unknown, limit = 50): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, limit).map((item) => item.slice(0, TEXT_CAP))
    : [];
}

function entries(value: unknown): ReplanViewEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .filter((item) => typeof item.key === "string")
    .slice(0, 50)
    .map((item) => ({
      key: str(item.key, 100),
      title: str(item.title, 200) || str(item.key, 100),
      kind: str(item.kind, 40),
      capability: str(item.capability, 80),
      fields: strings(item.fields, 20),
      reasoning: str(item.reasoning) || null,
      frozen: item.frozen === true,
      restored: item.restored === true,
      outsideImpact: item.outsideImpact === true,
    }));
}

/** One view per replanned plan version, oldest first. */
export function replansFromPlans(
  plans: Array<{ version: number; createdAt: number; payload?: unknown }>
): ReplanView[] {
  const views: ReplanView[] = [];
  for (const plan of [...plans].sort((a, b) => a.version - b.version)) {
    const payload = plan.payload as { replan?: unknown } | null | undefined;
    const record = payload && typeof payload === "object" ? payload.replan : undefined;
    if (!record || typeof record !== "object") continue;
    const r = record as Record<string, unknown>;
    const diff = (r.diff && typeof r.diff === "object" ? r.diff : {}) as Record<string, unknown>;
    views.push({
      fromVersion: typeof r.fromVersion === "number" ? r.fromVersion : plan.version - 1,
      toVersion: typeof r.toVersion === "number" ? r.toVersion : plan.version,
      createdAt: plan.createdAt,
      reason: str(r.reason, 1000),
      failedKeys: strings(r.failedKeys),
      impactKeys: strings(r.impactKeys),
      frozenKeys: strings(r.frozenKeys),
      attempts: typeof r.attempts === "number" ? r.attempts : 1,
      rejected: strings(r.rejected, 5),
      reasoningMissing: strings(r.reasoningMissing),
      added: entries(diff.added),
      removed: entries(diff.removed),
      modified: entries(diff.modified),
      preserved: entries(diff.preserved),
    });
  }
  return views;
}
