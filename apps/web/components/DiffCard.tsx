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

/**
 * The viewer's colours come from the diff tokens in app/globals.css, so the
 * palette follows the app theme (light/dark) without hexes in this file.
 */
const DIFF_VARIABLES = {
  diffViewerBackground: "var(--shell-diff-bg)",
  diffViewerColor: "var(--shell-diff-fg)",
  addedBackground: "var(--shell-diff-add-bg)",
  removedBackground: "var(--shell-diff-del-bg)",
  wordAddedBackground: "var(--shell-diff-word-add)",
  wordRemovedBackground: "var(--shell-diff-word-del)",
  addedColor: "var(--shell-diff-add-fg)",
  removedColor: "var(--shell-diff-del-fg)",
  codeFoldGutterBackground: "var(--shell-diff-fold-gutter)",
  codeFoldBackground: "var(--shell-diff-fold)",
  emptyLineBackground: "var(--shell-diff-empty)",
  gutterBackground: "var(--shell-diff-gutter)",
  gutterBackgroundDark: "var(--shell-diff-gutter-2)",
  diffViewerTitleBackground: "var(--shell-diff-title-bg)",
  diffViewerTitleColor: "var(--shell-diff-title-fg)",
  diffViewerTitleBorderColor: "var(--shell-diff-title-line)",
} as const;

type FileChangeType = "new" | "modified" | "deleted";

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
function PathLabel({ path }: { path: string }) {
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
          className="rounded p-1 text-ink-3 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30"
        >
          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <PathLabel path={filePath} />
        {changeType === "new" && <span className="rounded-md bg-ok/10 px-1.5 py-0.5 text-[11px] font-medium text-ok">New</span>}
        {changeType === "deleted" && <span className="rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-bold text-danger">Deleted</span>}
        {applied && <span className="rounded bg-ok/10 px-1.5 py-0.5 text-[10px] font-bold text-ok">applied</span>}
        <span className="flex shrink-0 gap-1.5 tabular-nums text-[11px] font-semibold">
          {added > 0 && <span className="text-ok">+{added}</span>}
          {removed > 0 && <span className="text-danger">−{removed}</span>}
        </span>
        {approvalId && (
          <span className="ml-auto flex gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => onApprove?.(approvalId)}
              title="Approves the whole change set this file belongs to"
              className="rounded-lg bg-brand px-2 py-1 text-[11px] font-semibold text-brand-ink hover:bg-brand-hover disabled:opacity-50"
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
                variables: { light: DIFF_VARIABLES, dark: DIFF_VARIABLES },
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
                  ? "bg-ok/10"
                  : row.type === "del"
                    ? "bg-danger/10"
                    : "";
              const signColor =
                row.type === "add"
                  ? "text-ok"
                  : row.type === "del"
                    ? "text-danger"
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
