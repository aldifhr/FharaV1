"use client";
import { useMemo, useRef, useState } from "react";
import DiffCard, { countLines, type FileChangeType } from "./DiffCard";

export type CodeDiffFile = {
  /** Stable key; falls back to `filePath`. */
  key?: string;
  filePath: string;
  diff: string;
  changeType: FileChangeType;
  oldContent?: string | null;
  newContent?: string | null;
  /** Truthy when the change has already been applied. */
  applied?: boolean | number | string | null;
  approvalId?: string;
  busy?: boolean;
};

export type CodeDiffViewerProps = {
  files: CodeDiffFile[];
  onApprove?: (approvalId: string) => void;
  onReject?: (approvalId: string) => void;
  emptyMessage?: string;
  showFileList?: boolean;
  className?: string;
  /** Side-by-side diff. Defaults to false (unified) to fit narrow panes. */
  splitView?: boolean;
};

function fileKey(file: CodeDiffFile, index: number): string {
  return file.key ?? `${file.filePath}-${index}`;
}

export default function CodeDiffViewer({
  files,
  onApprove,
  onReject,
  emptyMessage = "No changes.",
  showFileList = true,
  className,
  splitView = false,
}: CodeDiffViewerProps) {
  const [expandedByKey, setExpandedByKey] = useState<Record<string, boolean>>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLDivElement>());

  const totals = useMemo(
    () =>
      (files ?? []).reduce(
        (stats, file) => {
          const lines = countLines(file.diff);
          stats.added += lines.added;
          stats.removed += lines.removed;
          return stats;
        },
        { added: 0, removed: 0 },
      ),
    [files],
  );

  const isExpanded = (key: string) => expandedByKey[key] ?? true;
  const setExpanded = (key: string, expanded: boolean) =>
    setExpandedByKey((prev) => ({ ...prev, [key]: expanded }));

  const expandAll = () =>
    setExpandedByKey(Object.fromEntries(files.map((f, i) => [fileKey(f, i), true])));
  const collapseAll = () =>
    setExpandedByKey(Object.fromEntries(files.map((f, i) => [fileKey(f, i), false])));

  const jumpToFile = (key: string) => {
    setSelectedKey(key);
    setExpanded(key, true);
    sectionRefs.current.get(key)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  if (!files?.length) {
    return (
      <div className={`mt-2 rounded-xl border border-dashed border-[#e5e3eb] bg-white px-4 py-6 text-center text-xs text-gray-400 dark:border-gray-800 dark:bg-gray-900 ${className ?? ""}`}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className={`mt-2 ${className ?? ""}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-gray-600 dark:text-gray-300">
        <span>Changed {files.length} {files.length === 1 ? "file" : "files"}</span>
        <span className="tabular-nums text-emerald-600">+{totals.added}</span>
        <span className="tabular-nums text-rose-500">−{totals.removed}</span>
        <span className="ml-auto flex gap-1.5">
          <button
            type="button"
            onClick={expandAll}
            className="rounded-lg bg-gray-100 px-2 py-1 text-[11px] font-semibold text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Expand all
          </button>
          <button
            type="button"
            onClick={collapseAll}
            className="rounded-lg bg-gray-100 px-2 py-1 text-[11px] font-semibold text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Collapse all
          </button>
        </span>
      </div>

      <div className="flex items-start gap-3">
        {showFileList && (
          <nav aria-label="Changed files" className="hidden w-44 shrink-0 sm:block">
            <ul className="space-y-1">
              {files.map((file, index) => {
                const key = fileKey(file, index);
                const lines = countLines(file.diff);
                const selected = selectedKey === key;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() => jumpToFile(key)}
                      aria-current={selected ? "true" : undefined}
                      className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] ${selected ? "bg-[#eef2fb] font-semibold text-[#3b4a7a] dark:bg-gray-800 dark:text-gray-100" : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"}`}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono">{file.filePath}</span>
                      <span className="flex shrink-0 gap-1 tabular-nums">
                        <span className="text-emerald-600">+{lines.added}</span>
                        <span className="text-rose-500">−{lines.removed}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}

        <div className="min-w-0 flex-1">
          {files.map((file, index) => {
            const key = fileKey(file, index);
            return (
              <div
                key={key}
                ref={(el) => {
                  if (el) sectionRefs.current.set(key, el);
                  else sectionRefs.current.delete(key);
                }}
              >
                <DiffCard
                  filePath={file.filePath}
                  diff={file.diff}
                  changeType={file.changeType}
                  oldContent={file.oldContent}
                  newContent={file.newContent}
                  applied={Boolean(file.applied)}
                  approvalId={file.approvalId}
                  busy={file.busy}
                  onApprove={onApprove}
                  onReject={onReject}
                  expanded={isExpanded(key)}
                  onExpandedChange={(expanded) => setExpanded(key, expanded)}
                  splitView={splitView}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
