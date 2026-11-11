"use client";

import { useEffect, useMemo, useState } from "react";
import { useConvex } from "convex/react";
import { ChevronDown, ChevronRight, ChevronUp, Loader2 } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { clockTime } from "@/lib/format";
import { mergeRawEvents, oldestSequence, toRawEvent, type RawEvent } from "@/lib/runEvents";
import { useToast } from "@/components/Toasts";

/**
 * The run's raw task events (moved out of runs/[taskId]/page.tsx). runs.get
 * holds the newest window; when it is truncated, "Load earlier" pages older
 * events through taskEvents.pageEarlier (D12) by the oldest sequence held.
 */
export default function RawEvents({ taskId, events, truncated }: { taskId: string; events: RawEvent[]; truncated: boolean }) {
  const convex = useConvex();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [earlier, setEarlier] = useState<RawEvent[]>([]);
  const [hasMore, setHasMore] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setEarlier([]);
    setHasMore(null);
  }, [taskId]);

  const rows = useMemo(() => mergeRawEvents(earlier, events), [earlier, events]);
  const cursor = oldestSequence(rows);
  const canLoadEarlier = (hasMore ?? truncated) && cursor !== null && cursor > 1;
  if (events.length === 0) return null;

  const loadEarlier = async () => {
    if (cursor === null || loading) return;
    setLoading(true);
    try {
      const page = await convex.query(api.taskEvents.pageEarlier, { taskId: taskId as never, beforeSequence: cursor });
      setEarlier((held) => mergeRawEvents(page.rows.map((row) => toRawEvent(row as never)), held));
      setHasMore(page.hasMore);
    } catch (err) {
      toast("error", "Couldn't load earlier events", err instanceof Error ? err.message : undefined);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="mt-10">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[13px] font-medium text-ink-2 hover:text-ink"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Raw events
        <span className="tabular-nums text-ink-3">
          {rows.length}
          {canLoadEarlier ? " (latest)" : ""}
        </span>
      </button>
      {open && (
        <div className="mt-3 overflow-hidden rounded-xl border border-line bg-panel">
          {(canLoadEarlier || earlier.length > 0) && (
            <div className="flex items-center border-b border-line px-2 py-1.5 text-[12.5px] text-ink-3">
              {canLoadEarlier ? (
                <button
                  type="button"
                  onClick={() => void loadEarlier()}
                  disabled={loading}
                  className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-60"
                >
                  {loading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
                  {loading ? "Loading earlier events…" : "Load earlier"}
                </button>
              ) : (
                <span className="px-1.5 py-1">Start of the run</span>
              )}
            </div>
          )}
          <ul className="max-h-[480px] divide-y divide-line overflow-y-auto font-mono text-[11.5px]">
            {rows.map((e) => (
              <li key={e._id} className="px-3 py-1.5">
                <div className="flex gap-2">
                  <span className="w-10 shrink-0 tabular-nums text-ink-3">{e.sequence ?? "—"}</span>
                  <span className="w-12 shrink-0 tabular-nums text-ink-3">{clockTime(e.createdAt)}</span>
                  <span className={`min-w-0 flex-1 break-words ${e.level === "error" ? "text-danger" : e.level === "warn" ? "text-ink" : "text-ink-2"}`}>
                    {e.type}
                    {e.subtaskKey ? <span className="text-ink-3"> [{e.subtaskKey}]</span> : null}
                    {e.message ? <span className="text-ink"> {e.message}</span> : null}
                  </span>
                </div>
                {e.payload && <p className="ml-24 mt-0.5 break-all text-ink-3">{e.payload}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
