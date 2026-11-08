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

export function useChatQueue(send: (content: string) => Promise<unknown>, onError?: (message: string) => void) {
  const [items, setItems] = useState<QueuedMessage[]>([]);
  const [sending, setSending] = useState(false);

  const clear = () => setItems([]);

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

  const sendAll = async (clearDelayMs = 2000) => {
    const pending = items.filter((m) => m.status === "queued");
    if (pending.length === 0) return;
    setSending(true);
    for (const item of pending) {
      setItems((q) => q.map((m) => (m.id === item.id ? { ...m, status: "sending" } : m)));
      try {
        await send(item.content);
        setItems((q) => q.map((m) => (m.id === item.id ? { ...m, status: "sent" } : m)));
      } catch (err) {
        setItems((q) => q.map((m) => (m.id === item.id ? { ...m, status: "failed" } : m)));
        onError?.(err instanceof Error ? err.message : "Failed to send");
        break;
      }
    }
    setSending(false);
    setTimeout(() => {
      setItems((q) => q.filter((m) => m.status !== "sent"));
    }, clearDelayMs);
  };

  return { items, sending, add, remove, move, update, sendAll, clear };
}

/** Auto-grow a textarea up to `maxHeight` as the draft changes. */
export function useAutoGrowRef(deps: unknown[], maxHeight = 120) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}
