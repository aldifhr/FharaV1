"use client";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { ChevronDown, ChevronRight } from "lucide-react";

// react-diff-viewer-continued is a CommonJS class component; load it
// client-only so its prop-types graph never runs during SSR. (The
// original react-diff-viewer only supports React 16.)
const DiffViewer = dynamic(() => import("react-diff-viewer-continued"), { ssr: false });

export type FileChangeType = "new" | "modified" | "deleted";

/** Count added/removed lines in a unified diff (skips file/hunk headers). */
export function countLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

type DiffRow =
  | { type: "hunk"; oldStart: number; newStart: number }
  | { type: "add" | "del" | "ctx"; oldNo: number | null; newNo: number | null; text: string };

function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of diff.split("\n")) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      rows.push({ type: "hunk", oldStart: oldNo, newStart: newNo });
      continue;
    }
    if (raw.startsWith("diff ") || raw.startsWith("index ") || raw.startsWith("---") || raw.startsWith("+++")) continue;
    // "\ No newline at end of file" is metadata, not a line.
    if (raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) {
      rows.push({ type: "add", oldNo: null, newNo: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      rows.push({ type: "del", oldNo: oldNo++, newNo: null, text: raw.slice(1) });
    } else {
      rows.push({ type: "ctx", oldNo: oldNo++, newNo: newNo++, text: raw.replace(/^ /, "") });
    }
  }
  // The trailing newline of the diff yields one empty "context" row.
  const last = rows[rows.length - 1];
  if (last && last.type === "ctx" && last.text === "") rows.pop();
  return rows;
}

type Props = {
  filePath: string;
  diff: string;
  changeType: FileChangeType;
  /** Full file contents; when both are present the diff renders with
   *  react-diff-viewer (line numbers, word diff). Otherwise the unified
   *  diff text is shown directly. */
  oldContent?: string | null;
  newContent?: string | null;
  approvalId?: string;
  applied?: boolean;
  busy?: boolean;
  onApprove?: (approvalId: string) => void;
  onReject?: (approvalId: string) => void;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Side-by-side (split) view instead of unified. */
  splitView?: boolean;
};

export default function DiffCard({
  filePath,
  diff,
  changeType,
  oldContent,
  newContent,
  approvalId,
  applied,
  busy,
  onApprove,
  onReject,
  expanded = true,
  onExpandedChange,
  splitView = false,
}: Props) {
  const rows = useMemo(() => parseDiff(diff), [diff]);
  const { added, removed } = useMemo(() => countLines(diff), [diff]);
  const [dark, setDark] = useState(false);
  // Uncontrolled when the parent does not own the expanded state (most
  // callers don't): Without this the collapse button is dead because
  // onExpandedChange is undefined.
  const [internalExpanded, setInternalExpanded] = useState(true);
  const isExpanded = onExpandedChange ? expanded : internalExpanded;

  // Follow theme toggles while the diff is open (the class lives on <html>).
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains("dark"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  // A new file has no old content (and vice versa): pass an empty string
  // on that side so the viewer still renders the additions/deletions
  // instead of dropping to the plain unified-diff fallback.
  const hasContents = oldContent != null || newContent != null;

  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-[#e5e3eb] bg-white shadow-[0_1px_2px_rgba(30,25,60,.04)] dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center gap-2 border-b border-[#eeeef3] bg-[#fbfbfd] px-3 py-2 dark:border-gray-800 dark:bg-gray-800/60">
        <button
          type="button"
          onClick={() => {
            if (onExpandedChange) onExpandedChange(!expanded);
            else setInternalExpanded((value) => !value);
          }}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? `Collapse ${filePath}` : `Expand ${filePath}`}
          className="rounded p-1 text-gray-500 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#494752] dark:text-gray-200">{filePath}</span>
        {changeType === "new" && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">New</span>}
        {changeType === "deleted" && <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-700 dark:bg-rose-950 dark:text-rose-300">Deleted</span>}
        {applied && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">applied</span>}
        <span className="flex shrink-0 gap-1.5 tabular-nums text-[11px] font-semibold">
          {added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>}
          {removed > 0 && <span className="text-rose-500 dark:text-rose-400">−{removed}</span>}
        </span>
        {approvalId && (
          <span className="ml-auto flex gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => onApprove?.(approvalId)}
              title="Approves the whole change set this file belongs to"
              className="rounded-lg bg-emerald-600 px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
            >
              Approve all
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onReject?.(approvalId)}
              title="Rejects the whole change set this file belongs to"
              className="rounded-lg bg-gray-200 px-2 py-1 text-[11px] font-semibold disabled:opacity-50 dark:bg-gray-700 dark:text-white"
            >
              Reject all
            </button>
          </span>
        )}
      </div>
      {isExpanded && (
        hasContents ? (
          <div className="max-h-96 overflow-auto font-mono text-[11px] leading-[1.7]">
            <DiffViewer
              oldValue={oldContent ?? ""}
              newValue={newContent ?? ""}
              splitView={splitView}
              showDiffOnly={false}
              hideLineNumbers={false}
              disableWordDiff={false}
              useDarkTheme={dark}
              extraLinesSurroundingDiff={2}
              styles={{
                variables: {
                  dark: { diffViewerBackground: "#111827", diffViewerColor: "#e5e7eb", addedBackground: "#064e3b", removedBackground: "#7f1d1d", wordAddedBackground: "#059669", wordRemovedBackground: "#dc2626", addedColor: "#a7f3d0", removedColor: "#fecaca", codeFoldGutterBackground: "#1f2937", codeFoldBackground: "#374151", emptyLineBackground: "#1f2937", gutterBackground: "#1f2937", gutterBackgroundDark: "#111827", diffViewerTitleBackground: "#1f2937", diffViewerTitleColor: "#e5e7eb", diffViewerTitleBorderColor: "#374151" },
                  light: { diffViewerBackground: "#ffffff", diffViewerColor: "#374151", addedBackground: "#ecfdf5", removedBackground: "#fef2f2", wordAddedBackground: "#a7f3d0", wordRemovedBackground: "#fecaca", addedColor: "#065f46", removedColor: "#991b1b", codeFoldGutterBackground: "#f9fafb", codeFoldBackground: "#e5e7eb", emptyLineBackground: "#f9fafb", gutterBackground: "#f9fafb", gutterBackgroundDark: "#f3f4f6" },
                },
                diffContainer: { fontSize: "11px" },
              }}
            />
          </div>
        ) : (
          <div className="max-h-72 overflow-auto py-1 font-mono text-[11px] leading-[1.7]">
            {rows.map((row, i) => {
              if (row.type === "hunk") {
                return (
                  <div key={i} className="flex bg-gray-50 text-[10px] text-gray-400 dark:bg-gray-800/50">
                    <span className="w-10 shrink-0 select-none px-2 text-right">{row.oldStart}</span>
                    <span className="w-10 shrink-0 select-none px-2 text-right">{row.newStart}</span>
                    <span className="px-2">@@</span>
                  </div>
                );
              }
              const bg =
                row.type === "add"
                  ? "bg-emerald-50 dark:bg-emerald-950/40"
                  : row.type === "del"
                    ? "bg-rose-50 dark:bg-rose-950/40"
                    : "";
              const signColor = row.type === "add" ? "text-emerald-600 dark:text-emerald-400" : row.type === "del" ? "text-rose-500" : "text-transparent";
              return (
                <div key={i} className={`flex ${bg}`}>
                  <span className="w-10 shrink-0 select-none px-2 text-right text-gray-400">{row.oldNo ?? ""}</span>
                  <span className="w-10 shrink-0 select-none px-2 text-right text-gray-400">{row.newNo ?? ""}</span>
                  <span className={`w-4 shrink-0 select-none text-center font-bold ${signColor}`}>
                    {row.type === "add" ? "+" : row.type === "del" ? "−" : ""}
                  </span>
                  <span className="min-w-0 flex-1 whitespace-pre pr-3 text-gray-700 dark:text-gray-300">{row.text}</span>
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
