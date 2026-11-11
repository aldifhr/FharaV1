"use client";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useUiPref } from "@/lib/uiPrefs";
import { parseDiff } from "@/lib/lineComments";

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
  /** "flush": a section inside a multi-file card (no own border/margin). */
  variant?: "card" | "flush";
  /** Always render the parsed unified diff (old/new gutters), never the
   *  full-file viewer — the chat "Changed N files" card uses this. */
  forceUnified?: boolean;
  /** Gutter click on a numbered row of the unified view (shift = extend);
   *  turns the line numbers into buttons (Changes pane line comments). */
  onLineClick?: (rowIndex: number, shift: boolean) => void;
  /** Inclusive row-index range to mark as selected. */
  selectedRange?: [number, number] | null;
  /** Content shown under a row (comments, the composer). */
  renderAnnotation?: (rowIndex: number) => ReactNode;
};

/** "site/lib/pricing.ts" → dimmed directory + bold file name. */
export function PathLabel({ path }: { path: string }) {
  const at = path.lastIndexOf("/");
  const dir = at >= 0 ? path.slice(0, at + 1) : "";
  const file = at >= 0 ? path.slice(at + 1) : path;
  return (
    <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={path}>
      {dir && <span className="text-ink-3">{dir}</span>}
      <span className="font-semibold text-ink">{file}</span>
    </span>
  );
}

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
  splitView,
  variant = "card",
  forceUnified = false,
  onLineClick,
  selectedRange,
  renderAnnotation,
}: Props) {
  const rows = useMemo(() => parseDiff(diff), [diff]);
  const { added, removed } = useMemo(() => countLines(diff), [diff]);
  const [dark, setDark] = useState(false);
  // Uncontrolled when the parent does not own the expanded state (most
  // callers don't): Without this the collapse button is dead because
  // onExpandedChange is undefined.
  // Settings → Diffs & pull requests (this device).
  const [diffView] = useUiPref("diffView");
  const [diffContext] = useUiPref("diffContext");
  const [diffExpanded] = useUiPref("diffExpanded");
  const split = splitView ?? diffView === "split";
  const [internalExpanded, setInternalExpanded] = useState<boolean | null>(null);
  const isExpanded = onExpandedChange ? expanded : (internalExpanded ?? diffExpanded);

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
  const hasContents = !forceUnified && (oldContent != null || newContent != null);

  return (
    <div
      className={
        variant === "flush"
          ? "border-t border-line"
          : "mt-2 overflow-hidden rounded-xl border border-line bg-panel shadow-[0_1px_2px_rgba(30,25,60,.04)]"
      }
    >
      <div className={`flex items-center gap-2 px-3 py-2 ${variant === "flush" ? "bg-panel" : "border-b border-line bg-panel-2"}`}>
        <button
          type="button"
          onClick={() => {
            if (onExpandedChange) onExpandedChange(!expanded);
            else setInternalExpanded(!isExpanded);
          }}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? `Collapse ${filePath}` : `Expand ${filePath}`}
          className="rounded p-1 text-ink-3 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <PathLabel path={filePath} />
        {changeType === "new" && <span className="rounded-md bg-[#e9f8ef] px-1.5 py-0.5 text-[11px] font-medium text-[#1f8a4c] dark:bg-emerald-500/15 dark:text-emerald-300">New</span>}
        {changeType === "deleted" && <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-700 dark:bg-rose-950 dark:text-rose-300">Deleted</span>}
        {applied && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">applied</span>}
        <span className="flex shrink-0 gap-1.5 tabular-nums text-[11px] font-semibold">
          {added > 0 && <span className="text-[#1f9d55] dark:text-emerald-400">+{added}</span>}
          {removed > 0 && <span className="text-[#d83a3a] dark:text-rose-400">−{removed}</span>}
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
              className="rounded-lg bg-line px-2 py-1 text-[11px] font-semibold text-ink disabled:opacity-50"
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
              splitView={split}
              showDiffOnly={diffContext === "changes"}
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
          <div className={`${variant === "flush" ? "max-h-[28rem]" : "max-h-72"} overflow-auto border-t border-line font-mono text-[12px] leading-[1.75]`}>
            {rows.map((row, i) => {
              if (row.type === "hunk") {
                // A gap between hunks; the first hunk needs no separator.
                return i === 0 ? null : (
                  <div key={i} className="flex bg-panel-2 text-[11px] text-ink-3">
                    <span className="w-10 shrink-0 select-none px-2 text-right">⋯</span>
                    <span className="w-10 shrink-0 select-none px-2 text-right" />
                    <span className="px-2">@@ {row.oldStart},{row.newStart}</span>
                  </div>
                );
              }
              const bg =
                row.type === "add"
                  ? "bg-[#e8f6ec] dark:bg-[#12301f]"
                  : row.type === "del"
                    ? "bg-[#fdecec] dark:bg-[#3a1618]"
                    : "";
              const signColor =
                row.type === "add"
                  ? "text-[#1f9d55] dark:text-emerald-400"
                  : row.type === "del"
                    ? "text-[#d83a3a] dark:text-rose-400"
                    : "text-transparent";
              const selected = Boolean(selectedRange && i >= selectedRange[0] && i <= selectedRange[1]);
              const gutter = (n: number | null) =>
                onLineClick ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={(e) => onLineClick(i, e.shiftKey)}
                    aria-label={`Comment on line ${n ?? ""}`}
                    className="w-10 shrink-0 select-none px-2 text-right text-ink-3 hover:bg-hover hover:text-ink"
                  >
                    {n ?? ""}
                  </button>
                ) : (
                  <span className="w-10 shrink-0 select-none px-2 text-right text-ink-3">{n ?? ""}</span>
                );
              const note = renderAnnotation?.(i);
              return (
                <Fragment key={i}>
                  <div
                    data-diff-row={i}
                    aria-selected={onLineClick ? selected : undefined}
                    className={`flex min-w-max ${bg} ${onLineClick ? `border-l-2 ${selected ? "border-ink" : "border-transparent"}` : ""}`}
                  >
                    {gutter(row.oldNo)}
                    {gutter(row.newNo)}
                    <span className={`w-5 shrink-0 select-none text-center ${signColor}`}>
                      {row.type === "add" ? "+" : row.type === "del" ? "−" : ""}
                    </span>
                    <span className="whitespace-pre pr-4 text-ink">{row.text}</span>
                  </div>
                  {note ? <div className="sticky left-0 border-y border-line bg-panel font-sans">{note}</div> : null}
                </Fragment>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
