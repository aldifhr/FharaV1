"use client";

/**
 * Self-Improvement Lab UI: "Suggest fix" on a failed run and the proposed
 * change shown as a diff with Apply / Dismiss. Nothing applies by itself.
 */
import { useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "@/components/Toasts";
import { TARGET_KIND_LABELS, type SuggestionTargetKind } from "@/api/convex/lib/improve/suggest";
import { diffStats } from "@/api/convex/lib/improve/textDiff";

export type Suggestion = FunctionReturnType<typeof api.improve.listSuggestions>[number];

function errorText(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const match = /Uncaught Error: (.*?)(?:\n|$)/.exec(err.message);
  return match ? match[1] : err.message;
}

function DiffText({ diff }: { diff: string }) {
  return (
    <pre className="mt-2 max-h-96 overflow-auto rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12px] leading-relaxed">
      {diff.split("\n").map((line, i) => (
        <div
          key={i}
          className={
            line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")
              ? "text-ink-3"
              : line.startsWith("+")
                ? "text-ink"
                : line.startsWith("-")
                  ? "text-destructive"
                  : "text-ink-2"
          }
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

const STATUS_COPY: Record<string, string> = {
  running: "Reading the run…",
  ready: "Proposed change",
  no_change: "No change proposed",
  applied: "Applied",
  dismissed: "Dismissed",
  error: "Failed",
};

export function SuggestionItem({ suggestion, showTask = false }: { suggestion: Suggestion; showTask?: boolean }) {
  const toast = useToast();
  const apply = useMutation(api.improve.applySuggestion);
  const dismiss = useMutation(api.improve.dismissSuggestion);
  const [busy, setBusy] = useState<"apply" | "dismiss" | null>(null);
  const stats = suggestion.diff ? diffStats(suggestion.diff) : null;
  const run = (kind: "apply" | "dismiss") => async () => {
    setBusy(kind);
    try {
      if (kind === "apply") {
        await apply({ suggestionId: suggestion._id });
        toast("success", "Change applied", suggestion.targetLabel ?? undefined);
      } else {
        await dismiss({ suggestionId: suggestion._id });
      }
    } catch (err) {
      toast("error", kind === "apply" ? "Couldn't apply the change" : "Couldn't dismiss", errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="py-3">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]">
        <span className={`font-medium ${suggestion.status === "error" ? "text-destructive" : suggestion.status === "running" ? "text-ink-3" : "text-ink"}`}>
          {STATUS_COPY[suggestion.status] ?? suggestion.status}
        </span>
        {suggestion.targetKind && (
          <span className="text-ink-2">
            {TARGET_KIND_LABELS[suggestion.targetKind as SuggestionTargetKind]} · {suggestion.targetLabel}
          </span>
        )}
        {stats && (
          <span className="tabular-nums text-[12px] text-ink-3">
            +{stats.added} −{stats.removed}
          </span>
        )}
        {showTask && suggestion.taskTitle && <span className="min-w-0 truncate text-ink-3">{suggestion.taskTitle}</span>}
      </p>
      {suggestion.rationale && <p className="mt-1 text-[13.5px] leading-relaxed text-ink">{suggestion.rationale}</p>}
      {suggestion.error && <p className="mt-1 text-[12.5px] text-ink-3">{suggestion.error}</p>}
      {suggestion.diff && (suggestion.status === "ready" || suggestion.status === "applied") && <DiffText diff={suggestion.diff} />}
      {suggestion.status === "ready" && (
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={run("apply")}
            className="inline-flex h-8 items-center rounded-lg bg-ink px-3 text-[13px] font-medium text-canvas outline-none transition hover:bg-ink/85 focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50"
          >
            {busy === "apply" ? "Applying…" : "Apply"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={run("dismiss")}
            className="inline-flex h-8 items-center rounded-lg border border-line bg-panel px-3 text-[13px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

export function SuggestFixButton({ taskId, label = "Suggest fix" }: { taskId?: string; label?: string }) {
  const toast = useToast();
  const request = useMutation(api.improve.requestSuggestion);
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await request({ ...(taskId ? { taskId: taskId as never } : {}) });
          toast("info", "Reading the failed run", "One suggestion appears here when it's ready. Nothing is applied until you click Apply.");
        } catch (err) {
          toast("error", "Couldn't start", errorText(err));
        } finally {
          setBusy(false);
        }
      }}
      className="inline-flex h-8 items-center rounded-lg border border-line bg-panel px-3 text-[13px] font-medium text-ink outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50"
    >
      {busy ? "Starting…" : label}
    </button>
  );
}
