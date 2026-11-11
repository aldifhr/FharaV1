import { cacheHitPercent, tokensPerSecond, type CallStatsInput } from "@/api/convex/lib/callStats";
import { formatDuration } from "@/lib/runFormat";

/**
 * D5: one quiet line of call stats under the snapshot facts: prompt-cache
 * hit share, time to first token and output tokens/s. Each part shows only
 * when the provider reported what it needs; nothing renders when none did.
 */
export default function CallStats({ stats }: { stats: CallStatsInput }) {
  const cache = cacheHitPercent(stats);
  const speed = tokensPerSecond(stats);
  const parts = [
    cache !== undefined ? `cache ${cache}%` : "",
    typeof stats.ttftMs === "number" ? `TTFT ${formatDuration(stats.ttftMs)}` : "",
    speed !== undefined ? `${speed.toLocaleString("en-US")} tokens/s` : "",
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <p className="text-[12px] tabular-nums text-ink-3" aria-label="Call stats">
      {parts.join(" · ")}
    </p>
  );
}
