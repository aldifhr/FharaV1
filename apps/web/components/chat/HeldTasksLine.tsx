"use client";

import { useEffect, useState } from "react";
import { holdNoticeText } from "@/api/convex/lib/providerHold";

type HeldTask = {
  _id: string;
  title: string;
  status: string;
  pausedBy?: string;
  conversationId?: string | null;
  hold?: { kind: "offline" | "rate_limit" | "quota" | "auth"; reason: string; resumeAt: number };
};

/**
 * A plain line above the composer for each task of this chat that is on a
 * provider hold (429, offline, quota, auth). The thread panel carries the
 * full notice and Resume; this keeps the chat from looking silent. Theme
 * tokens only, no pill or card.
 */
export default function HeldTasksLine({
  tasks,
  conversationId,
  onOpenTask,
}: {
  tasks: HeldTask[] | undefined;
  conversationId: string | null;
  onOpenTask: (taskId: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const held = (tasks ?? []).filter(
    (t) =>
      t.status === "paused" &&
      t.pausedBy === "held" &&
      t.hold &&
      (!conversationId || !t.conversationId || String(t.conversationId) === conversationId)
  );
  if (held.length === 0) return null;
  return (
    <div className="w-full shrink-0 space-y-0.5 bg-panel px-3 pb-1 sm:px-8 lg:px-10" data-testid="chat-hold-line">
      {held.slice(0, 3).map((t) => (
        <p key={t._id} className="truncate text-[12.5px] text-ink-2">
          <button
            type="button"
            onClick={() => onOpenTask(t._id)}
            className="font-medium text-ink outline-none hover:underline focus-visible:underline"
          >
            {t.title}
          </button>
          <span className="text-ink-3"> · </span>
          {holdNoticeText(t.hold!, now)}
        </p>
      ))}
    </div>
  );
}
export { default as AutomationHoldLine } from "./AutomationHoldLine";
