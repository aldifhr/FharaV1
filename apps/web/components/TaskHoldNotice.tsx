"use client";

import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { Play } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { holdNoticeText } from "@/api/convex/lib/providerHold";
import { useToast } from "./Toasts";

type Hold = { kind: "offline" | "rate_limit" | "quota" | "auth"; reason: string; resumeAt: number; attempts: number };

/**
 * O3 + L7: a task on a provider hold (LLM offline, 429, quota, auth).
 * Shows the reason and the next automatic retry, and a Resume button that
 * retries now. Theme tokens only.
 */
export default function TaskHoldNotice({
  task,
  compact = false,
}: {
  task: { _id: string; status: string; pausedBy?: string; hold?: Hold };
  compact?: boolean;
}) {
  const resume = useMutation(api.taskControl.resume);
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  if (task.status !== "paused" || task.pausedBy !== "held" || !task.hold) return null;
  const run = async () => {
    setPending(true);
    try {
      await resume({ taskId: task._id as never });
      toast("success", "Task resumed", "It retries the provider now.");
    } catch (err) {
      toast("error", "Couldn't resume task", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <div className={compact ? "mt-2 rounded-lg border border-line bg-panel-2 px-2 py-1.5" : "rounded-xl border border-line bg-panel-2 p-3.5"}>
      <p className={compact ? "text-[11px] text-ink-2" : "text-[14px] text-ink-2"}>{holdNoticeText(task.hold, now)}</p>
      <button
        type="button"
        disabled={pending}
        onClick={() => void run()}
        className={
          compact
            ? "mt-1.5 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-ink outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50"
            : "mt-2.5 flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-[13px] font-medium text-white outline-none hover:bg-brand-hover focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50"
        }
      >
        <Play size={compact ? 11 : 14} /> Resume now
      </button>
    </div>
  );
}
