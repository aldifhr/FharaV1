"use client";

import { useState } from "react";
import { FileDiff } from "lucide-react";
import { DIFF_PREVIEW_LINES, diffLines, diffStat } from "@/lib/threadbear/toolBody";
import type { DiffRow as DiffRowData } from "@/lib/threadbear/types";

const LINE_TONE = { "+": "text-ok", "-": "text-danger", "@": "text-ink-3", " ": "text-ink-2" } as const;

/** One file edit: the path, +added −removed, the first DIFF_PREVIEW_LINES lines and "Show N more". */
export default function DiffRow({ row }: { row: DiffRowData }) {
  const [all, setAll] = useState(false);
  const lines = diffLines(row.hunks);
  const { added, removed } = diffStat(row.hunks);
  const shown = all ? lines : lines.slice(0, DIFF_PREVIEW_LINES);
  const more = lines.length - shown.length;
  return (
    <div className="overflow-hidden rounded-field border border-line bg-panel">
      <div className="flex min-w-0 items-center gap-2 border-b border-line px-3 py-1.5 text-[12.5px]">
        <FileDiff size={13} className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate font-mono text-ink">{row.path || "file"}</span>
        <span className="shrink-0 font-mono tabular-nums text-ok">+{added}</span>
        <span className="shrink-0 font-mono tabular-nums text-danger">−{removed}</span>
      </div>
      <pre className="overflow-x-auto bg-inset px-3 py-2 font-mono text-[12px] leading-5">
        {shown.map((l, i) => (
          <div key={i} className={LINE_TONE[l.tag]}>
            {l.tag === "@" ? l.text : `${l.tag}${l.text}`}
          </div>
        ))}
      </pre>
      {more > 0 && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="w-full border-t border-line px-3 py-1.5 text-left text-[12px] text-ink-2 outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30"
        >
          Show {more} more {more === 1 ? "line" : "lines"}
        </button>
      )}
    </div>
  );
}
