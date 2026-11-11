"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { reduceTranscript, turnRunning } from "@/lib/threadbear/reducer";
import { DIRECT_PAGE_LIMIT, DIRECT_TAIL_LIMIT, mergeTail, olderCursor, prependPage } from "@/lib/threadbear/transcriptMerge";
import type { OptimisticMessage, PendingCard, StreamRow, ThreadEvent, TranscriptRow } from "@/lib/threadbear/types";

export type DirectTaskView = {
  _id: string;
  status: string;
  title: string;
  permissionMode?: string;
  direct?: { status?: string; turnId?: string | null; effort?: string; role?: string } & Record<string, unknown>;
};

/**
 * Threadbear T3 reads for one direct thread: the live tail (at most
 * DIRECT_TAIL_LIMIT events), the hot streaming rows, the project's pending
 * cards (so a card older than the tail is never lost), and older pages read
 * once through `useConvex().query` on "Load earlier".
 */
export function useDirectTranscript(taskId: string, projectId: string | undefined, optimistic: OptimisticMessage[]) {
  const convex = useConvex();
  const tail = useQuery(api.directThreads.tail, { taskId: taskId as any, limit: DIRECT_TAIL_LIMIT });
  const streams = useQuery(api.directThreads.streams, { taskId: taskId as any }) as StreamRow[] | undefined;
  const pending = useQuery(api.approvals.listPendingForProject, projectId ? { projectId: projectId as any } : "skip");
  const [held, setHeld] = useState<ThreadEvent[]>([]);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const heldRef = useRef(held);
  heldRef.current = held;

  useEffect(() => {
    if (!tail) return;
    setHeld((prev) => mergeTail(prev, tail.events as ThreadEvent[]).events);
  }, [tail]);

  const cursor = olderCursor(held);
  const loadEarlier = useCallback(async () => {
    const before = olderCursor(heldRef.current);
    if (before === null) return;
    setLoadingEarlier(true);
    try {
      const page = (await convex.query(api.directThreads.page, { taskId: taskId as any, beforeSeq: before, limit: DIRECT_PAGE_LIMIT })) as ThreadEvent[];
      setHeld((prev) => prependPage(prev, page));
    } finally {
      setLoadingEarlier(false);
    }
  }, [convex, taskId]);

  const pendingCards = useMemo(
    () => ((pending ?? []) as unknown as (PendingCard & { taskId: string })[]).filter((c) => String(c.taskId) === taskId),
    [pending, taskId],
  );
  const rows: TranscriptRow[] = useMemo(
    () => reduceTranscript({ events: held, streams: streams ?? [], optimistic, pendingCards }),
    [held, streams, optimistic, pendingCards],
  );
  const task = (tail?.task ?? (tail === null ? null : undefined)) as DirectTaskView | null | undefined;
  // Mid-turn, waiting on a card, or a message queued for the worker: Stop applies.
  const running = task
    ? ["running", "starting", "waiting"].includes(String(task.direct?.status)) || task.status === "queued"
    : turnRunning(held);
  return { task, rows, running, loading: tail === undefined, hasEarlier: cursor !== null, loadingEarlier, loadEarlier };
}
