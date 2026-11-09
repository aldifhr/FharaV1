"use client";

import { useLayoutEffect, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";

/** Lines kept in the DOM; the box shows about six and scrolls the rest. */
const KEEP_LINES = 40;

/** Last `n` non-empty-tail lines of the live text. */
export function liveTail(text: string, n = KEEP_LINES): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

/**
 * Streamed model output of a running subtask (worker:setSubtaskLiveOutput,
 * coalesced every ~400ms). Render only while the subtask is running; the
 * worker and the backend clear it when the subtask settles.
 */
export default function SubtaskLiveOutput({
  taskId,
  subtaskKey,
  className = "ml-[25px] mt-1",
}: {
  taskId: string;
  subtaskKey: string;
  className?: string;
}) {
  const live = useQuery(api.subtaskLive.get, { taskId: taskId as never, key: subtaskKey });
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  const text = live?.text ? liveTail(live.text) : "";

  // Keep the newest line in view unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  if (!text) return null;
  return (
    <pre
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      }}
      aria-label="Live output"
      className={`${className} max-h-[8.25rem] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-line bg-panel px-2.5 py-1.5 font-mono text-[11.5px] leading-[1.25rem] text-ink-3`}
    >
      {text}
    </pre>
  );
}
