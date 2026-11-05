"use client";
import { useEffect, useRef } from "react";
import { parse, html } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";

type Props = { filePath: string; diff: string; changeType: "new" | "modified" | "deleted" };

export default function DiffCard({ filePath, diff, changeType }: Props) {
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
    <div className="mt-2 overflow-hidden rounded-xl border border-[#e5e3eb] bg-white shadow-[0_1px_2px_rgba(30,25,60,.04)]">
      <div className="flex items-center gap-2 border-b border-[#eeeef3] bg-[#fbfbfd] px-3 py-2">
        <span className="truncate font-mono text-[11px] text-[#494752]">{filePath}</span>
        {changeType === "new" && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">NEW</span>}
        <span className="ml-auto text-[11px] text-emerald-600">+3</span>
        <span className="text-[11px] text-rose-500">−5</span>
      </div>
      <div ref={ref} className="max-h-64 overflow-auto text-xs" />
    </div>
  );
}
