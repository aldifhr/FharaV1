"use client";

import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import DiffCard, { countLines } from "../../DiffCard";
import { Chip } from "./primitives";

type FileChange = { _id: string; filePath: string; diff: string; changeType: "new" | "modified" | "deleted" };

const SNIPPET_LINES = 3;

/** First changed lines of a diff (no context), for the review snippet. */
function changedLines(diff: string, limit: number): Array<{ sign: "+" | "-"; text: string }> {
  const out: Array<{ sign: "+" | "-"; text: string }> = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+") || line.startsWith("-")) {
      out.push({ sign: line[0] as "+" | "-", text: line.slice(1) });
      if (out.length >= limit) break;
    }
  }
  return out;
}

const LOCKFILE = /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;

/**
 * Review note body in the task thread: a small diff snippet of the most
 * relevant file, status chips, and the full diffs on demand.
 */
export default function ReviewSnippet({ files, approved, completed }: { files: FileChange[]; approved: boolean; completed: boolean }) {
  const [showAll, setShowAll] = useState(false);
  // The most-changed file is the one a reviewer would quote.
  const lead = useMemo(() => {
    let best: FileChange | undefined;
    let bestScore = -1;
    for (const file of files) {
      const { added, removed } = countLines(file.diff ?? "");
      if (added + removed > bestScore) {
        best = file;
        bestScore = added + removed;
      }
    }
    return best;
  }, [files]);
  if (!lead) return null;
  const stats = countLines(lead.diff ?? "");
  const lines = changedLines(lead.diff ?? "", SNIPPET_LINES);
  const touchesPackages = files.some((file) => LOCKFILE.test(file.filePath));

  return (
    <div className="mt-2 space-y-2">
      <div className="overflow-hidden rounded-xl border border-[#e9e8ef] bg-white dark:border-white/10 dark:bg-[#1c1c1f]">
        <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
          <span className="min-w-0 flex-1 truncate font-mono text-[#4c4a55] dark:text-neutral-300">{lead.filePath}</span>
          <span className="shrink-0 tabular-nums font-semibold">
            <span className="text-[#1f9d55] dark:text-emerald-400">+{stats.added}</span>{" "}
            <span className="text-[#d83a3a] dark:text-rose-400">−{stats.removed}</span>
          </span>
        </div>
        <div className="font-mono text-[11.5px] leading-[1.75]">
          {lines.map((line, index) => (
            <div
              key={index}
              className={`flex gap-2 truncate px-3 ${
                line.sign === "+"
                  ? "bg-[#e8f6ec] text-[#1d5c35] dark:bg-[#12301f] dark:text-emerald-200"
                  : "bg-[#fdf0e6] text-[#7a3b12] dark:bg-[#3a1d14] dark:text-orange-200"
              }`}
            >
              <span className="shrink-0 select-none">{line.sign === "+" ? "+" : "−"}</span>
              <span className="truncate whitespace-pre">{line.text}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {approved ? (
          <Chip tone="green" icon={<Check size={12} strokeWidth={2.5} />}>Approved</Chip>
        ) : completed ? (
          <Chip tone="gray" icon={<Check size={12} strokeWidth={2.5} />}>Completed</Chip>
        ) : null}
        {!touchesPackages && <Chip tone="gray">no new packages</Chip>}
        {files.length > 0 && (
          <button
            type="button"
            onClick={() => setShowAll((value) => !value)}
            aria-expanded={showAll}
            className="ml-auto rounded-md px-1.5 py-0.5 text-[12px] font-medium text-[#5148e0] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:text-indigo-300"
          >
            {showAll ? "Hide diff" : `Show full diff (${files.length} ${files.length === 1 ? "file" : "files"})`}
          </button>
        )}
      </div>
      {showAll && (
        <div className="space-y-2">
          {files.map((file) => (
            <DiffCard key={file._id} forceUnified filePath={file.filePath} diff={file.diff} changeType={file.changeType} />
          ))}
        </div>
      )}
    </div>
  );
}
