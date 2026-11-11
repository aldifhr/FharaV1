"use client";
// Paradev A2 (plan audit/paradev-plan-2026-11-11.md, P-A): the Changes pane's
// file list. Idea only from Paradev's DiffPaneFileList; markup is Fhara's.
import type { ChangesetFile } from "@/api/convex/lib/changeset";
import { statusLetter } from "@/lib/changesView";

const STATUS_WORD: Record<ChangesetFile["status"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  changed: "Changed",
};

export default function ChangesFileList({
  files,
  selectedPath,
  onSelect,
}: {
  files: ChangesetFile[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <ul aria-label="Changed files" className="divide-y divide-line border-y border-line">
      {files.map((file) => {
        const selected = file.path === selectedPath;
        return (
          <li key={file.path}>
            <button
              type="button"
              onClick={() => onSelect(file.path)}
              aria-current={selected ? "true" : undefined}
              data-testid="changes-file-row"
              className={`flex w-full items-center gap-2.5 px-4 py-2 text-left outline-none hover:bg-hover focus-visible:bg-hover ${
                selected ? "bg-hover" : ""
              }`}
            >
              <span title={STATUS_WORD[file.status]} className="w-3 shrink-0 font-mono text-[12px] text-ink-3">
                {statusLetter(file.status)}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink" title={file.path}>
                {file.path}
                {file.oldPath && <span className="text-ink-3"> ← {file.oldPath}</span>}
              </span>
              <span className="shrink-0 tabular-nums text-[12px] text-ink-3">
                {file.isBinary ? "binary" : `+${file.additions} −${file.deletions}`}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
