"use client";

import { Check, CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import type { ChatOption } from "@/lib/options";

function OptionPreview({ style }: { style: ChatOption["preview"] }) {
  const nav = (
    <div className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full bg-[#8f90a8] dark:bg-gray-500" />
      <span className="ml-auto h-1.5 w-5 rounded bg-gray-200 dark:bg-gray-700" />
      <span className="h-1.5 w-5 rounded bg-gray-200 dark:bg-gray-700" />
      <span className="h-1.5 w-4 rounded-full bg-[#8f90a8] dark:bg-gray-500" />
    </div>
  );
  const bar = (w = "w-full") => <div className={`h-1.5 rounded bg-gray-200 dark:bg-gray-700 ${w}`} />;
  if (style === "rows") {
    return (
      <div className="space-y-2 p-3">
        {nav}
        <div className="flex gap-2 pt-0.5">
          <div className="h-9 w-10 shrink-0 rounded border border-gray-200 dark:border-gray-700" />
          <div className="flex flex-1 flex-col justify-center gap-1">{bar("w-5/6")}{bar("w-2/3")}</div>
        </div>
        <div className="flex gap-2">
          <div className="flex flex-1 flex-col justify-center gap-1">{bar("w-4/6")}{bar("w-3/4")}</div>
          <div className="h-9 w-10 shrink-0 rounded border border-gray-200 dark:border-gray-700" />
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
          <div className="h-2.5 w-4/5 rounded bg-gray-300 dark:bg-gray-600" />
          <div className="h-1.5 w-3/5 rounded bg-gray-200 dark:bg-gray-700" />
        </div>
        <div className="mx-auto h-3.5 w-12 rounded-full border border-[#635bff]/50" />
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
        <div className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-md bg-[#15131c] p-3 dark:bg-white">
          <div className="h-2.5 w-3/5 rounded bg-white/90" />
          <div className="h-1.5 w-2/5 rounded bg-white/50" />
          <div className="mt-0.5 h-3 w-10 rounded-full bg-[#635bff]" />
        </div>
        <div className="flex gap-1.5">
          <div className="h-6 flex-1 rounded border border-gray-200 dark:border-gray-700" />
          <div className="h-6 flex-1 rounded border border-gray-200 dark:border-gray-700" />
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
                ? "flex flex-1 flex-col gap-1 rounded border-2 border-[#635bff] p-1.5"
                : "flex flex-1 flex-col gap-1 rounded border border-gray-200 p-1.5 dark:border-gray-700"
            }
          >
            {bar("w-2/3")}
            <div className={`h-2.5 w-1/2 rounded ${i === 1 ? "bg-gray-300 dark:bg-gray-600" : "bg-gray-200 dark:bg-gray-700"}`} />
            <div className={`mt-auto h-2.5 rounded-full ${i === 1 ? "bg-[#635bff]" : "bg-gray-100 dark:bg-gray-700"}`} />
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
  onPick,
  onOpenTask,
}: {
  options: ChatOption[];
  pickedId?: string;
  ctoAgrees?: boolean;
  taskId?: string;
  taskStatus?: string;
  disabled?: boolean;
  onPick: (option: ChatOption) => void;
  onOpenTask?: (taskId: string) => void;
}) {
  return (
    <div className="mt-3 max-w-2xl">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {options.map((option) => {
          const selected = pickedId !== undefined && pickedId === option.id;
          return (
            <button
              key={option.id}
              type="button"
              disabled={disabled || pickedId !== undefined}
              onClick={() => onPick(option)}
              aria-pressed={selected}
              className={`group/option overflow-hidden rounded-xl border-2 bg-white text-left shadow-sm transition ${
                selected
                  ? "border-[#635bff] bg-[#f3f1ff] dark:bg-indigo-950/30"
                  : "border-gray-200 hover:border-[#635bff]/60 dark:border-gray-800 dark:bg-gray-900"
              } disabled:cursor-default disabled:opacity-90`}
            >
              {option.preview !== "plain" && (
                <div className="border-b border-[#e9e7f5] dark:border-gray-800">
                  <OptionPreview style={option.preview} />
                </div>
              )}
              <div className="flex items-baseline gap-2 px-3 pt-2.5">
                <span
                  className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-bold ${
                    selected
                      ? "bg-[#635bff] text-white"
                      : "bg-gray-100 text-gray-600 group-hover/option:bg-[#635bff] group-hover/option:text-white dark:bg-gray-800 dark:text-gray-300"
                  }`}
                >
                  {option.id}
                </span>
                <p className="min-w-0 flex-1 text-sm font-semibold text-gray-900 dark:text-white">
                  {option.title}
                </p>
              </div>
              {option.summary && (
                <p className="px-3 pb-3 pt-1 text-[11px] text-gray-400">{option.summary}</p>
              )}
              <div className="px-3 pb-3 pt-1">
                {selected ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#635bff]">
                    <Check size={12} /> You picked {option.id}
                  </span>
                ) : (
                  <span className="text-[11px] text-gray-400">{pickedId === undefined ? "Click to pick" : ""}</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
      {pickedId !== undefined && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full bg-[#f3f1ff] px-2 py-0.5 text-[11px] font-semibold text-[#635bff] dark:bg-indigo-950/60 dark:text-indigo-300">
            <Check size={11} /> You picked {pickedId}
          </span>
          {ctoAgrees && (
            <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-300">
              <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-indigo-100 text-[8px] font-bold text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">C</span>
              CTO agrees
            </span>
          )}
          {taskId && taskStatus && (
            <button
              type="button"
              onClick={() => onOpenTask?.(taskId)}
              title="Open the task created from this pick"
              className="inline-flex items-center gap-1 rounded-full border border-[#e5e3eb] px-2 py-0.5 text-[11px] font-semibold text-gray-600 transition hover:border-[#635bff]/50 hover:text-[#635bff] dark:border-gray-700 dark:text-gray-300"
            >
              {taskStatus === "done" ? <CheckCircle2 size={11} /> : taskStatus === "failed" ? <XCircle size={11} /> : <Loader2 size={11} className="animate-spin" />}
              {taskStatus === "done" ? "Done" : taskStatus === "failed" ? "Failed" : "Running"}
              <ExternalLink size={10} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
