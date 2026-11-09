"use client";

import { Check, CheckCircle2, ExternalLink, Loader2, XCircle, Bell, Clock } from "lucide-react";
import type { ChatOption } from "@/lib/options";

function OptionPreview({ style }: { style: ChatOption["preview"] }) {
  const nav = (
    <div className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full bg-[#8f90a8] dark:bg-neutral-500" />
      <span className="ml-auto h-1.5 w-5 rounded bg-line" />
      <span className="h-1.5 w-5 rounded bg-line" />
      <span className="h-1.5 w-4 rounded-full bg-[#8f90a8] dark:bg-neutral-500" />
    </div>
  );
  const bar = (w = "w-full") => <div className={`h-1.5 rounded bg-line ${w}`} />;
  if (style === "rows") {
    return (
      <div className="space-y-2 p-3">
        {nav}
        <div className="flex gap-2 pt-0.5">
          <div className="h-9 w-10 shrink-0 rounded border border-line" />
          <div className="flex flex-1 flex-col justify-center gap-1">{bar("w-5/6")}{bar("w-2/3")}</div>
        </div>
        <div className="flex gap-2">
          <div className="flex flex-1 flex-col justify-center gap-1">{bar("w-4/6")}{bar("w-3/4")}</div>
          <div className="h-9 w-10 shrink-0 rounded border border-line" />
        </div>
      </div>
    );
  }
  if (style === "plain") {
    // Text-only proposals still get a hero-shaped preview.
    return (
      <div className="space-y-1.5 p-3">
        {nav}
        <div className="mx-auto mt-1 flex w-3/4 flex-col items-center gap-1">
          <div className="h-2.5 w-4/5 rounded bg-line-strong" />
          <div className="h-1.5 w-3/5 rounded bg-line" />
        </div>
        <div className="mx-auto h-3.5 w-12 rounded-full border border-brand/50" />
      </div>
    );
  }
  const highlighted = style === "bold";
  if (highlighted) {
    // One dominant hero block + two small supporting tiles — a different
    // silhouette from the three equal tiles below.
    return (
      <div className="space-y-1.5 p-3">
        {nav}
        <div className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-md bg-[#15131c] p-3 dark:bg-black">
          <div className="h-2.5 w-3/5 rounded bg-white/90" />
          <div className="h-1.5 w-2/5 rounded bg-white/50" />
          <div className="mt-0.5 h-3 w-10 rounded-full bg-brand" />
        </div>
        <div className="flex gap-1.5">
          <div className="h-6 flex-1 rounded border border-line" />
          <div className="h-6 flex-1 rounded border border-line" />
        </div>
      </div>
    );
  }
  // sheet: three EQUAL pricing columns (the middle one outlined + accent
  // bar), so this reads as a comparison grid rather than a hero.
  return (
    <div className="space-y-1.5 p-3">
      {nav}
      <div className="flex items-stretch gap-1.5 pt-0.5">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className={
              i === 1
                ? "flex flex-1 flex-col gap-1 rounded border-2 border-brand p-1.5"
                : "flex flex-1 flex-col gap-1 rounded border border-line p-1.5"
            }
          >
            {bar("w-2/3")}
            <div className={`h-2.5 w-1/2 rounded ${i === 1 ? "bg-line-strong" : "bg-line"}`} />
            <div className={`mt-auto h-2.5 rounded-full ${i === 1 ? "bg-brand" : "bg-hover"}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function OptionCards({
  options,
  pickedId,
  ctoAgrees,
  taskId,
  taskStatus,
  disabled,
  compact = false,
  onPick,
  onOpenTask,
}: {
  options: ChatOption[];
  pickedId?: string;
  ctoAgrees?: boolean;
  taskId?: string;
  taskStatus?: string;
  disabled?: boolean;
  /** Text-only answer tiles (agent question with options): no preview area. */
  compact?: boolean;
  onPick: (option: ChatOption) => void;
  onOpenTask?: (taskId: string) => void;
}) {
  return (
    <div className="mt-3 max-w-2xl">
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const selected = pickedId !== undefined && pickedId === option.id;
          // Layout mockups only for visual choices; "plain" is a text option.
          const showPreview = !compact && option.preview !== "plain" && Boolean(option.preview);
          return (
            <button
              key={option.id}
              type="button"
              disabled={disabled || pickedId !== undefined}
              onClick={() => onPick(option)}
              aria-pressed={selected}
              className={`group/option flex w-full flex-col overflow-hidden rounded-xl border bg-panel text-left outline-none transition ${
                selected ? "border-brand ring-1 ring-brand" : "border-line hover:border-line-strong focus-visible:ring-2 focus-visible:ring-brand/40"
              } disabled:cursor-default ${pickedId !== undefined && !selected ? "opacity-50" : ""}`}
            >
              {showPreview && (
                <div className="border-b border-line bg-hover/60">
                  <OptionPreview style={option.preview} />
                </div>
              )}
              <div className="flex items-start gap-3 px-3.5 py-3">
                <span
                  className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold ${
                    selected ? "bg-brand text-white" : "bg-hover text-ink-2"
                  }`}
                >
                  {selected ? <Check size={12} /> : option.id}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-medium text-ink">{option.title}</span>
                  {option.summary && <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-3">{option.summary}</span>}
                </span>
              </div>
            </button>
          );
        })}
      </div>
      {pickedId !== undefined && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] text-ink-3">You picked {pickedId}</span>
          {ctoAgrees && (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 py-1 text-[12px] font-medium text-ink-2 dark:bg-transparent">
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-indigo-100 text-[9px] font-bold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">C</span>
              CTO agrees
            </span>
          )}
          {taskId && taskStatus && (
            <button
              type="button"
              onClick={() => onOpenTask?.(taskId)}
              title="Open the task created from this pick"
              className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[12px] font-medium text-ink-2 transition hover:border-brand/50 hover:text-brand-ink"
            >
              {taskStatus === "done" ? (
                <CheckCircle2 size={11} />
              ) : taskStatus === "failed" || taskStatus === "rejected" ? (
                <XCircle size={11} />
              ) : taskStatus === "needs_approval" || taskStatus === "waiting_input" ? (
                <Bell size={11} />
              ) : taskStatus === "running" ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Clock size={11} />
              )}
              {taskStatus === "done"
                ? "Done"
                : taskStatus === "failed"
                  ? "Failed"
                  : taskStatus === "rejected"
                    ? "Rejected"
                    : taskStatus === "needs_approval" || taskStatus === "waiting_input"
                      ? "Needs you"
                      : taskStatus === "running"
                        ? "Running"
                        : "Queued"}
              <ExternalLink size={10} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
