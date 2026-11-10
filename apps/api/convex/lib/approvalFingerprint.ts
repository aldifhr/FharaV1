/**
 * O6: approvals bound to what the user saw (plan 043).
 *
 * Adapted from DiscoClaw/discoclaw@24c8ae6 src/discord/destructive-confirmation.ts
 * (`stableStringify` + `actionFingerprint`, and the 10-minute confirmation
 * TTL). MIT, © 2025 David Marsh (THIRD_PARTY_NOTICES.md). Changed by Fhara:
 * Web Crypto (works in Convex and the browser), the fingerprint covers the
 * approval's shown fields, and the TTL runs from when the client showed it.
 *
 * A decision that carries a fingerprint is refused when the approval no
 * longer matches what was shown, or when it was shown longer ago than the
 * TTL (a phone tab left open). A decision without one keeps the old
 * behaviour (backward compatible).
 */

export const APPROVAL_SHOWN_TTL_MS = 10 * 60_000;
/** Clock skew allowed between the device and the backend. */
export const APPROVAL_CLOCK_SKEW_MS = 2 * 60_000;

/** JSON with sorted keys, so equal values hash equally. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => JSON.stringify(k) + ":" + stableStringify(v));
  return "{" + entries.join(",") + "}";
}

/** The parts of an approval the user is shown (and decides on). */
export function shownFields(approval: {
  _id: string;
  kind: string;
  summary: string;
  payload?: unknown;
  arguments?: unknown;
  toolName?: string;
  subtaskKey?: string;
  planVersion?: number;
}) {
  return {
    id: approval._id,
    kind: approval.kind,
    summary: approval.summary,
    payload: approval.payload ?? null,
    arguments: approval.arguments ?? null,
    toolName: approval.toolName ?? null,
    subtaskKey: approval.subtaskKey ?? null,
    planVersion: approval.planVersion ?? null,
  };
}

/** sha-256 (hex, first 16 chars) of the shown fields. */
export async function approvalFingerprint(approval: Parameters<typeof shownFields>[0]): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(shownFields(approval)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export type ShownCheck = { ok: true } | { ok: false; reason: string };

/** Refuse a decision on something other than what was shown, or shown too long ago. */
export async function checkShown(
  approval: Parameters<typeof shownFields>[0],
  shown: { fingerprint?: string; shownAt?: number },
  now = Date.now()
): Promise<ShownCheck> {
  if (shown.fingerprint === undefined) return { ok: true };
  if (shown.fingerprint !== (await approvalFingerprint(approval))) {
    return { ok: false, reason: "This approval changed since it was shown. Reload and review it again." };
  }
  if (typeof shown.shownAt !== "number" || !Number.isFinite(shown.shownAt)) {
    return { ok: false, reason: "This approval has no shown time. Reload and review it again." };
  }
  if (shown.shownAt > now + APPROVAL_CLOCK_SKEW_MS) {
    return { ok: false, reason: "This device's clock is ahead. Reload and review the approval again." };
  }
  if (now - shown.shownAt > APPROVAL_SHOWN_TTL_MS) {
    return { ok: false, reason: "This approval was shown more than 10 minutes ago. Reload and review it again." };
  }
  return { ok: true };
}
