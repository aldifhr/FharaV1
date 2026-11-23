
import { useEffect, useState } from "react";
import { useMutation } from "@fhara/runtime/react";
import { Play } from "lucide-react";
import { api } from "@fhara/runtime/api";
import { holdNoticeText } from "@/api/functions/lib/providerHold";
import { classifyRepoHold } from "@/api/functions/lib/repoReadiness";
import GitInitNote from "./GitInitNote";
import { useToast } from "./Toasts";

type Hold = { kind: "offline" | "rate_limit" | "quota" | "auth" | "repo"; reason: string; resumeAt: number; attempts: number };

/**
 * O3 + L7: a task on a provider hold (LLM offline, 429, quota, auth).
 * Shows the reason and the next automatic retry, and a Resume button that
 * retries now. Theme tokens only.
 */
export default function TaskHoldNotice({
  task,
  compact = false,
}: {
  task: { _id: string; status: string; pausedBy?: string; hold?: Hold; errorMessage?: string; queueHeld?: boolean };
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
  const repoHeld = task.status === "paused" && task.pausedBy === "held" && task.hold?.kind === "repo";
  const repo = repoHeld ? { reason: task.hold!.reason } : task.status === "failed" ? classifyRepoHold(task.errorMessage) : null;
  const queueHeld = task.queueHeld === true;
  const run = async () => {
    setPending(true);
    try {
      await resume({ taskId: task._id as never });
      toast("success", "Task resumed", queueHeld ? "The project queue can run again." : "It retries the provider now.");
    } catch (err) {
      toast("error", "Couldn't resume task", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setPending(false);
    }
  };
  const boxClass = compact ? "mt-2 rounded-lg border border-line bg-panel-2 px-2 py-1.5" : "rounded-xl border border-line bg-panel-2 p-3.5";
  const buttonClass = compact
    ? "mt-1.5 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-ink outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50"
    : "mt-2.5 flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas outline-none hover:bg-ink/85 focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50";
  if (repo) return <GitInitNote message={repo.reason} target={{ taskId: task._id }} compact={compact} />;
  if (queueHeld) {
    return (
      <div className={boxClass}>
        <p className={compact ? "text-[11px] text-ink-2" : "text-[14px] text-ink-2"}>
          Worktree setup failed. Queued work is held until you resume it.
        </p>
        <button type="button" disabled={pending} onClick={() => void run()} className={buttonClass}>
          <Play size={compact ? 11 : 14} /> Resume queue
        </button>
      </div>
    );
  }
  if (task.status !== "paused" || task.pausedBy !== "held" || !task.hold) return null;
  return (
    <div className={boxClass}>
      <p className={compact ? "text-[11px] text-ink-2" : "text-[14px] text-ink-2"}>{holdNoticeText(task.hold, now)}</p>
      <button type="button" disabled={pending} onClick={() => void run()} className={buttonClass}>
        <Play size={compact ? 11 : 14} /> Resume now
      </button>
    </div>
  );
}
