"use client";

import { useEffect, useState } from "react";

/** "12s", "3m", "1h" since a timestamp. */
export function elapsedLabel(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

/**
 * Live line under a running subtask: what the agent is doing right now and
 * how long it has been on it (the worker updates `activity` per step).
 */
export default function SubtaskActivity({ activity, at }: { activity: string; at?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <p className="ml-[25px] mt-0.5 flex items-center gap-1.5 text-[12.5px] text-ink-3" aria-live="polite">
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-500/60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-500" />
      </span>
      <span className="min-w-0 truncate">{activity}</span>
      {at ? <span className="shrink-0 tabular-nums">· {elapsedLabel(at, now)}</span> : null}
    </p>
  );
}
