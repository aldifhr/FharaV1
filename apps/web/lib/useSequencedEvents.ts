"use client";

import { useEffect, useRef, useState } from "react";
import { hasGap, highWater, mergeSequenced, type SequencedRow } from "@/api/convex/lib/eventResume";

/** Rows kept client-side per stream; the oldest are dropped past this. */
const HELD_MAX = 2000;

type ResumeResult<T> = { mode: "replay" | "snapshot"; events: T[] };

/**
 * Snapshot + cursor on top of a reactive newest-window query (t3code idea #3).
 *
 * Convex re-sends the newest window after a reconnect, but if more events
 * than the window landed while the tab slept, the ones in between would be
 * skipped. When the new window no longer overlaps the last sequence seen,
 * ask the server what to do (`resume`): replay the missing events, or reset
 * to a fresh snapshot when the gap is too large (decideResume).
 */
export function useSequencedEvents<T extends SequencedRow>(
  streamKey: string | null | undefined,
  window: T[] | undefined,
  resume: (afterSequence: number) => Promise<ResumeResult<T>>
): T[] | undefined {
  const [held, setHeld] = useState<T[] | undefined>(undefined);
  const heldRef = useRef<T[]>([]);
  const lastSeen = useRef(0);
  const keyRef = useRef(streamKey);
  const resumeRef = useRef(resume);
  resumeRef.current = resume;

  useEffect(() => {
    if (keyRef.current !== streamKey) {
      keyRef.current = streamKey;
      lastSeen.current = 0;
      heldRef.current = [];
      setHeld(undefined);
    }
    if (!window) return;
    const key = streamKey;
    const commit = (rows: T[]) => {
      if (keyRef.current !== key) return;
      const trimmed = rows.length > HELD_MAX ? rows.slice(rows.length - HELD_MAX) : rows;
      heldRef.current = trimmed;
      lastSeen.current = Math.max(lastSeen.current, highWater(trimmed));
      setHeld(trimmed);
    };
    if (!hasGap(lastSeen.current, window)) {
      commit(mergeSequenced(heldRef.current, window));
      return;
    }
    resumeRef
      .current(lastSeen.current)
      .then((res) => {
        const base = res.mode === "replay" ? mergeSequenced(heldRef.current, res.events) : res.events;
        commit(mergeSequenced(base, window));
      })
      .catch(() => commit(mergeSequenced([], window)));
  }, [streamKey, window]);

  return held ?? window;
}
