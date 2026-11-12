"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Composed-message queue: each queued line is stored so it can be edited,
 * reordered, or dropped before dispatch. `sendAllQueued` runs them in order,
 * marking progress `queued → sending → sent|failed`; sent rows are cleared
 * after `clearDelayMs` so the user sees the success state.
 */
export type QueuedMessage = {
  id: string;
  content: string;
  status: "queued" | "sending" | "sent" | "failed";
};

export function useChatQueue(send: (content: string, id: string) => Promise<unknown>, onError?: (message: string) => void) {
  const [items, setItemsState] = useState<QueuedMessage[]>([]);
  const [sending, setSending] = useState(false);
  // Mirror of `items` so async callers (auto-send timers) never read a
  // stale closure.
  const itemsRef = useRef<QueuedMessage[]>([]);
  const sendingRef = useRef(false);
  const setItems = (update: (q: QueuedMessage[]) => QueuedMessage[]) => {
    setItemsState((q) => {
      const next = update(q);
      itemsRef.current = next;
      return next;
    });
  };

  const clear = () => setItems(() => []);

  const add = (content: string) => {
    setItems((q) => [...q, { id: crypto.randomUUID(), content, status: "queued" }]);
  };

  const remove = (id: string) => {
    setItems((q) => q.filter((m) => m.id !== id));
  };

  const move = (id: string, direction: -1 | 1) => {
    setItems((q) => {
      const idx = q.findIndex((m) => m.id === id);
      if (idx < 0) return q;
      const next = idx + direction;
      if (next < 0 || next >= q.length) return q;
      const nextq = [...q];
      [nextq[idx], nextq[next]] = [nextq[next], nextq[idx]];
      return nextq;
    });
  };

  const update = (id: string, content: string) => {
    setItems((q) => q.map((m) => (m.id === id ? { ...m, content } : m)));
  };

  /** Send pending rows in order (queued and previously failed), or only
   *  `onlyId` when given (per-row retry). Stops at the first failure. */
  const sendAll = async (clearDelayMs = 2000, onlyId?: string) => {
    if (sendingRef.current) return;
    const pending = itemsRef.current.filter(
      (m) => (m.status === "queued" || m.status === "failed") && (!onlyId || m.id === onlyId),
    );
    if (pending.length === 0) return;
    sendingRef.current = true;
    setSending(true);
    try {
      for (const item of pending) {
        // Read the latest content (the row may have been edited).
        const current = itemsRef.current.find((m) => m.id === item.id);
        if (!current) continue;
        setItems((q) => q.map((m) => (m.id === item.id ? { ...m, status: "sending" } : m)));
        try {
          await send(current.content, current.id);
          setItems((q) => q.map((m) => (m.id === item.id ? { ...m, status: "sent" } : m)));
        } catch (err) {
          setItems((q) => q.map((m) => (m.id === item.id ? { ...m, status: "failed" } : m)));
          onError?.(err instanceof Error ? err.message : "Failed to send");
          break;
        }
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
      setTimeout(() => {
        setItems((q) => q.filter((m) => m.status !== "sent"));
      }, clearDelayMs);
    }
  };

  const retry = (id: string) => sendAll(2000, id);

  return { items, sending, add, remove, move, update, sendAll, retry, clear };
}

/** Auto-grow a textarea up to `maxHeight` as the draft changes. */
export function useAutoGrowRef(deps: unknown[], maxHeight = 120) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller passes the deps list
  }, deps);
  return ref;
}
