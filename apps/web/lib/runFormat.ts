/** Formatting helpers for the Runs (execution trace) views. */

/** "850ms", "12s", "3m 05s", "1h 02m" */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "980", "12.4k", "1.2M" */
export function formatTokens(n: number | null | undefined): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "$0.042"; "—" when no call had pricing. */
export function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return "—";
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/** "just now", "5m ago", "3h ago", "2d ago" */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Status dot for a task / step status. Neutral by default; red only for errors. */
export function statusDot(status: string): string {
  switch (status) {
    case "failed":
    case "rejected":
      return "bg-red-500";
    case "needs_approval":
    case "waiting_input":
    case "waiting_approval":
    case "pending":
      return "bg-orange-500";
    case "running":
    case "queued":
    case "pushing":
    case "requested":
      return "bg-ink animate-pulse";
    default:
      return "bg-ink-3";
  }
}

export function isActiveStatus(status: string): boolean {
  return status === "running" || status === "queued" || status === "pushing" || status === "requested";
}

export function isErrorStatus(status: string): boolean {
  return status === "failed" || status === "rejected";
}
