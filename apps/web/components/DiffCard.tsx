"use client";
import { useEffect, useRef } from "react";
import { parse, html } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";

type Props = {
  filePath: string;
  diff: string;
  changeType: "new" | "modified" | "deleted";
  approvalId?: string;
  applied?: boolean;
  busy?: boolean;
  onApprove?: (approvalId: string) => void;
  onReject?: (approvalId: string) => void;
};

export default function DiffCard({
  filePath,
  diff,
  changeType,
  approvalId,
  applied,
  busy,
  onApprove,
  onReject,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    try {
      const out = html(parse(diff), { drawFileList: false, matching: "lines" });
      ref.current.innerHTML = out;
    } catch {
      ref.current.textContent = diff;
    }
    return () => { if (ref.current) ref.current.innerHTML = ""; };
  }, [diff]);

  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-[#e5e3eb] bg-white dark:border-gray-800 dark:bg-gray-900 shadow-[0_1px_2px_rgba(30,25,60,.04)]">
      <div className="flex items-center gap-2 border-b border-[#eeeef3] bg-[#fbfbfd] dark:border-gray-800 dark:bg-gray-800/60 px-3 py-2">
        <span className="truncate font-mono text-[11px] text-[#494752]">{filePath}</span>
        {changeType === "new" && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">NEW</span>}
        {changeType === "deleted" && <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-700">DEL</span>}
        {applied && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">APPLIED</span>}
        {approvalId && (
          <span className="ml-auto flex gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => onApprove?.(approvalId)}
              className="rounded-lg bg-emerald-600 px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
            >
              Accept
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onReject?.(approvalId)}
              className="rounded-lg bg-gray-200 px-2 py-1 text-[11px] font-semibold disabled:opacity-50 dark:bg-gray-700 dark:text-white"
            >
              Reject
            </button>
          </span>
        )}
      </div>
      <div ref={ref} className="max-h-64 overflow-auto text-xs" />
    </div>
  );
}
