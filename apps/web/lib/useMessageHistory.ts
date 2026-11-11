"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { loadEarlier, mergeHistory, MESSAGE_WINDOW, type EarlierPage, type HistoryRow } from "@/api/convex/lib/historyPaging";

export type MessageHistoryScope =
  | { kind: "task"; taskId: string }
  | { kind: "conversation"; conversationId: string }
  | { kind: "project"; projectId: string };

export type OutlineTurn = { _id: string; _creationTime: number; turn: number; preview: string };

/** What the "Load earlier" bar and the turn outline read and call. */
export type MessageHistory = {
  canLoadEarlier: boolean;
  loading: boolean;
  /** Rows held from older pages (changes after each page lands). */
  earlierCount: number;
  loadEarlier: () => void;
  outlineOpen: boolean;
  setOutlineOpen: (open: boolean) => void;
  turns: OutlineTurn[] | undefined;
  outlineTruncated: boolean;
  jumpToTurn: (turn: OutlineTurn) => void;
  /** A turn the list should scroll to once it renders; cleared by `clearJump`. */
  pendingJump: string | null;
  clearJump: () => void;
};

const scopeKey = (scope: MessageHistoryScope | null) =>
  scope ? `${scope.kind}:${"taskId" in scope ? scope.taskId : "conversationId" in scope ? scope.conversationId : scope.projectId}` : null;

/**
 * D12: the live newest window plus older pages loaded on demand. `rows` is
 * the merged, oldest-first list; `history` drives the "Load earlier" bar and
 * the turn outline. A jump to a turn outside the held rows pages down to it.
 */
export function useMessageHistory<T extends HistoryRow>(
  scope: MessageHistoryScope | null,
  live: T[] | undefined
): { rows: T[] | undefined; history: MessageHistory } {
  const convex = useConvex();
  const key = scopeKey(scope);
  const [state, setState] = useState<{ key: string | null; earlier: T[]; hasMore?: boolean }>({ key, earlier: [] });
  const [loading, setLoading] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  const held = state.key === key ? state : { key, earlier: [] as T[], hasMore: undefined };
  useEffect(() => {
    setState({ key, earlier: [] });
    setOutlineOpen(false);
    setPendingJump(null);
  }, [key]);

  const rows = useMemo(() => (live ? mergeHistory(held.earlier, live) : undefined), [held.earlier, live]);
  const outline = useQuery(api.messages.turnOutline, scope && outlineOpen ? { scope: scope as never } : "skip");

  const latest = useRef({ scope, key, held, live, loading });
  latest.current = { scope, key, held, live, loading };
  const fetchMore = useCallback(
    async (floor?: number) => {
      const { scope: current, key: currentKey, held: h, live: l, loading: busy } = latest.current;
      if (!current || !l || busy) return;
      setLoading(true);
      try {
        const fetchPage = (args: { before: number; floor?: number; limit?: number }) =>
          convex.query(api.messages.pageEarlier, { scope: current as never, ...args }) as unknown as Promise<EarlierPage<T>>;
        const next = await loadEarlier(fetchPage, { earlier: h.earlier, live: l }, floor === undefined ? {} : { floor });
        if (latest.current.key === currentKey) setState({ key: currentKey, ...next });
      } finally {
        setLoading(false);
      }
    },
    [convex]
  );

  const jumpToTurn = useCallback(
    (turn: OutlineTurn) => {
      setPendingJump(turn._id);
      const held = latest.current.held.earlier;
      const oldest = held.length ? held[0]._creationTime : latest.current.live?.[0]?._creationTime;
      if (oldest !== undefined && turn._creationTime < oldest) void fetchMore(turn._creationTime);
    },
    [fetchMore]
  );

  const history: MessageHistory = {
    canLoadEarlier: Boolean(live) && (held.hasMore ?? (live?.length ?? 0) >= MESSAGE_WINDOW),
    loading,
    earlierCount: held.earlier.length,
    loadEarlier: () => void fetchMore(),
    outlineOpen,
    setOutlineOpen,
    turns: outline?.turns as OutlineTurn[] | undefined,
    outlineTruncated: Boolean(outline?.truncated),
    jumpToTurn,
    pendingJump,
    clearJump: () => setPendingJump(null),
  };
  return { rows, history };
}
