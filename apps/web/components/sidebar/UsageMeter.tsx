"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { formatTokens, lastWeeklyReset, llmDisplayName, readLocalBudget, resetLabel, BUDGET_STORAGE_KEY } from "@/lib/usageWeek";

/** Sidebar footer: "Claude, this week 38%" + bar + reset time and worker slots. */
export default function UsageMeter() {
  // Re-evaluate the weekly window once a minute (crossing Monday 09:00).
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const since = useMemo(() => lastWeeklyReset(new Date(tick)).getTime(), [tick]);
  const usage = useQuery(api.shell.usage, { since });
  const [localBudget, setLocalBudget] = useState<number | null>(null);
  useEffect(() => {
    setLocalBudget(readLocalBudget());
    const onStorage = (e: StorageEvent) => e.key === BUDGET_STORAGE_KEY && setLocalBudget(readLocalBudget());
    const onLocal = () => setLocalBudget(readLocalBudget());
    window.addEventListener("storage", onStorage);
    window.addEventListener("moagent:budget-changed", onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("moagent:budget-changed", onLocal);
    };
  }, []);

  if (usage === undefined) {
    return (
      <div aria-hidden className="space-y-2">
        <div className="h-3.5 w-2/3 animate-pulse rounded bg-hover" />
        <div className="h-1.5 w-full animate-pulse rounded-full bg-hover" />
      </div>
    );
  }

  const budget = localBudget ?? usage.budget;
  const name = llmDisplayName(usage.topModel, usage.providerKind, usage.providerName);
  const pct = budget ? Math.min(100, Math.round((usage.totalTokens / budget) * 100)) : null;
  const inPct = budget ? Math.min(100, (usage.inputTokens / budget) * 100) : 0;
  const outPct = budget ? Math.min(100 - inPct, (usage.outputTokens / budget) * 100) : 0;
  const slots =
    usage.slots.workers === 0
      ? "worker offline"
      : `${usage.slots.busy} of ${usage.slots.total} slot${usage.slots.total === 1 ? "" : "s"} busy`;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="truncate text-ink-2">{name}, this week</span>
        <span className="shrink-0 font-medium tabular-nums text-ink" title={`${usage.totalTokens.toLocaleString()} tokens${budget ? ` of ${budget.toLocaleString()}` : ""}`}>
          {pct !== null ? `${pct}%` : `${formatTokens(usage.totalTokens)} tokens`}
        </span>
      </div>
      {pct !== null && (
        <div
          role="meter"
          aria-label={`${name} weekly usage`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-line"
        >
          <span className="h-full bg-brand" style={{ width: `${inPct}%` }} />
          <span className="h-full bg-brand/45" style={{ width: `${outPct}%` }} />
        </div>
      )}
      <p className="mt-2 truncate text-[12.5px] text-ink-3">
        {resetLabel(new Date(tick))} · {slots}
      </p>
    </div>
  );
}
