"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { ChevronRight, Loader2 } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { bytesText, toolInputText, toolInterruption, toolStatus, toolSubject } from "@/lib/threadbear/toolBody";
import type { ToolRow as ToolRowData } from "@/lib/threadbear/types";

const STATUS_WORD = { running: "Running", done: "Done", failed: "Failed", interrupted: "Interrupted" } as const;
const PRE = "max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-field bg-inset px-3 py-2 font-mono text-[12px] leading-5 text-ink-2";

/**
 * One tool call. Closed: the subject and a status word. Open: the input, the
 * output preview, and the whole body of a big result read lazily
 * (`directThreads.body`, only while open). A call left without a result when
 * its turn ended says why: stopped, interrupted, or never fully written.
 */
export default function ToolRow({ row, taskId, turnOpen, turnOutcome }: { row: ToolRowData; taskId: string; turnOpen: boolean; turnOutcome?: string }) {
  const [open, setOpen] = useState(false);
  const status = toolStatus(row, turnOpen);
  const interruption = toolInterruption(row, turnOpen, turnOutcome);
  const wantsBody = open && Boolean(row.result?.hasBody);
  const body = useQuery(api.directThreads.body, wantsBody ? { taskId: taskId as any, seq: row.result!.seq } : "skip");
  const input = toolInputText(row.input);
  const output = wantsBody ? (body?.body ?? row.result?.text ?? "") : (row.result?.text ?? row.liveOutput ?? "");

  return (
    <div className="text-[13px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 rounded-field px-1.5 py-1 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        <ChevronRight size={13} className={`shrink-0 text-ink-3 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="shrink-0 text-ink-3">{row.title === toolSubject(row) ? "Tool" : row.title}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{toolSubject(row)}</span>
        {status === "running" ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-ink-3" aria-label="Running" />
        ) : (
          <span className={`shrink-0 text-[12px] ${status === "failed" ? "text-danger" : "text-ink-3"}`}>{interruption?.word ?? STATUS_WORD[status]}</span>
        )}
      </button>
      {open && (
        <div className="mt-1 grid gap-2 pl-6">
          {interruption && <p className="text-[12px] text-ink-3">{interruption.text}</p>}
          {input && <pre className={PRE}>{input}</pre>}
          {output ? <pre className={PRE}>{output}</pre> : <p className="text-[12px] text-ink-3">{status === "running" ? "No output yet." : "No output."}</p>}
          {wantsBody && body === undefined && <p className="text-[12px] text-ink-3">Loading the full output…</p>}
          {row.result?.hasBody && (
            <p className="text-[12px] text-ink-3">
              {row.result.bytes ? `${bytesText(row.result.bytes)} in all` : "Full output"}
              {row.result.truncated ? " · cut at the stored limit" : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
