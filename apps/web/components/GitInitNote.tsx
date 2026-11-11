"use client";

import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { GitBranch } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "./Toasts";

type Target = { projectId?: string; taskId?: string; workspacePath?: string };

/**
 * Lane git-init: the plain "not a git repository / no commits yet" line
 * with an Initialize git button (git init, git add -A, initial commit).
 * Not destructive, so no confirm dialog; it only runs on the click.
 * Theme tokens only.
 */
export default function GitInitNote({
  message,
  target,
  compact = false,
  onDone,
}: {
  message: string;
  target: Target;
  compact?: boolean;
  onDone?: () => void;
}) {
  const initialize = useAction(api.gitInit.initialize);
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const run = async () => {
    setPending(true);
    try {
      const result = await initialize(target as never);
      if (!result.ok) {
        toast("error", "Couldn't initialize git", result.error);
        return;
      }
      const resumed = result.resumed > 0 ? ` ${result.resumed === 1 ? "The task" : `${result.resumed} tasks`} will run again.` : "";
      toast("success", "Git initialized", `${result.committed ? "Initial commit created." : "Repository ready."}${resumed}`);
      onDone?.();
    } catch (err) {
      toast("error", "Couldn't initialize git", err instanceof Error ? err.message.split("\n")[0] : "Please try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      data-testid="git-init-note"
      className={compact ? "mt-2 rounded-lg border border-line bg-panel-2 px-2 py-1.5" : "rounded-xl border border-line bg-panel-2 p-3.5"}
    >
      <p className={compact ? "text-[11px] text-ink-2" : "text-[14px] text-ink-2"}>{message}</p>
      <button
        type="button"
        disabled={pending}
        onClick={() => void run()}
        className={
          compact
            ? "mt-1.5 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-ink outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50"
            : "mt-2.5 flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas outline-none hover:bg-ink/85 focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50"
        }
      >
        <GitBranch size={compact ? 11 : 14} /> {pending ? "Initializing…" : "Initialize git"}
      </button>
    </div>
  );
}

/**
 * The folder's readiness for a project (settings) or a typed path (new
 * project form), checked on the server; null while unknown, ready or the
 * folder does not exist yet. `refresh` re-checks after an init.
 */
export function useRepoReadinessNote(target: Target | null): { message: string | null; refresh: () => void } {
  const status = useAction(api.gitInit.status);
  const [message, setMessage] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const key = target ? `${target.projectId ?? ""}|${target.taskId ?? ""}|${target.workspacePath ?? ""}` : "";
  useEffect(() => {
    if (!target || (!target.projectId && !target.taskId && !target.workspacePath?.trim())) {
      setMessage(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      status(target as never)
        .then((r) => !cancelled && setMessage("message" in r ? r.message : null))
        .catch(() => !cancelled && setMessage(null));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, tick]);
  return { message, refresh: () => setTick((n) => n + 1) };
}
