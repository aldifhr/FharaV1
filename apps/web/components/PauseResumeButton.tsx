"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { Pause, Play } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "./Toasts";

/** Statuses Pause applies to (plan 022); waiting states already wait on the user. */
export function canPause(status: string | undefined): boolean {
  return status === "running" || status === "queued";
}

/**
 * Pause / Resume for one task (plan 022). Pause stops new subtasks from
 * starting (running ones finish) and never resumes on its own; it needs
 * no confirmation because nothing is lost — only Stop asks.
 */
export default function PauseResumeButton({
  task,
  size = 13,
}: {
  task: { _id: string; title?: string; status: string };
  size?: number;
}) {
  const pause = useMutation(api.taskControl.pause);
  const resume = useMutation(api.taskControl.resume);
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const paused = task.status === "paused";
  if (!paused && !canPause(task.status)) return null;
  const label = paused ? "Resume task" : "Pause task";
  const run = async () => {
    setPending(true);
    try {
      if (paused) {
        await resume({ taskId: task._id as never });
        toast("success", "Task resumed");
      } else {
        await pause({ taskId: task._id as never });
        toast("info", "Task paused", "Running subtasks finish; nothing new starts until you resume.");
      }
    } catch (err) {
      toast("error", paused ? "Couldn't resume task" : "Couldn't pause task", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => void run()}
      title={paused ? "Resume: continue from where it paused" : "Pause: running subtasks finish, nothing new starts"}
      aria-label={task.title ? `${label} ${task.title}` : label}
      className="rounded-md p-1.5 text-ink-3 outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-40"
    >
      {paused ? <Play size={size} /> : <Pause size={size} />}
    </button>
  );
}
