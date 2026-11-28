
/**
 * Self-Improvement Lab UI: "Suggest fix" on a failed run and the proposed
 * change shown as a diff with Apply / Dismiss. Nothing applies by itself.
 */
import { useState } from "react";
import { useMutation } from "@fhara/runtime/react";
import type { FunctionReturnType } from "@fhara/runtime/server";
import { ChevronRight } from "lucide-react";
import { api } from "@fhara/runtime/api";
import { useToast } from "@/components/Toasts";
import { StatusTag, type StatusTone } from "@/components/ui/status-tag";
import { relativeTime } from "@/lib/runFormat";
import { TARGET_KIND_LABELS, type SuggestionTargetKind } from "@/api/functions/lib/improve/suggest";
import { diffStats } from "@/api/functions/lib/improve/textDiff";

export type Suggestion = FunctionReturnType<typeof api.improve.listSuggestions>[number];

function errorText(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const marker = "Uncaught Error: ";
  const at = err.message.indexOf(marker);
  if (at === -1) return err.message;
  const rest = err.message.slice(at + marker.length);
  const newline = rest.indexOf("\n");
  return newline === -1 ? rest : rest.slice(0, newline);
}

function DiffText({ diff }: { diff: string }) {
  return (
    <pre className="mt-2 max-h-96 overflow-auto rounded-field border border-line bg-inset px-3 py-2 font-mono text-[12px] leading-relaxed">
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
const STATUS_TONE: Record<string, StatusTone> = {
  running: "warn",
  ready: "active",
  no_change: "neutral",
  applied: "ok",
  dismissed: "neutral",
  error: "danger",
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
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusTag tone={STATUS_TONE[suggestion.status] ?? "neutral"}>
          {STATUS_COPY[suggestion.status] ?? suggestion.status}
        </StatusTag>
        {suggestion.targetKind && (
          <span className="min-w-0 truncate text-[12.5px] text-ink-2">
            {TARGET_KIND_LABELS[suggestion.targetKind as SuggestionTargetKind]} · {suggestion.targetLabel}
          </span>
        )}
        {stats && (
          <span className="text-[11.5px] tabular-nums text-ink-3">
            +{stats.added} −{stats.removed}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[11.5px] tabular-nums text-ink-3">
          {relativeTime(suggestion.decidedAt ?? suggestion.createdAt)}
        </span>
      </div>
      {showTask && suggestion.taskTitle && (
        <p className="mt-1 truncate text-[12px] text-ink-3">From {suggestion.taskTitle}</p>
      )}
      {suggestion.rationale && <p className="mt-2 text-[13px] leading-relaxed text-ink">{suggestion.rationale}</p>}
      {suggestion.error && <p className="mt-1 text-[12px] text-danger">{suggestion.error}</p>}
      {suggestion.diff && (suggestion.status === "ready" || suggestion.status === "applied") && (
        <details open={suggestion.status === "ready"} className="group mt-2">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-field px-1.5 py-0.5 text-[12px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30">
            <ChevronRight size={13} className="transition-transform group-open:rotate-90" />
            {suggestion.status === "ready" ? "Review diff" : "Show diff"}
          </summary>
          <DiffText diff={suggestion.diff} />
        </details>
      )}
      {suggestion.status === "ready" && (
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={run("apply")}
            className="inline-flex h-8 items-center rounded-field bg-ink px-3 text-[12.5px] font-medium text-canvas outline-none transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50"
          >
            {busy === "apply" ? "Applying…" : "Apply"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={run("dismiss")}
            className="inline-flex h-8 items-center rounded-field border border-line bg-panel px-3 text-[12.5px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50"
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
