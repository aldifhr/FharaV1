"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { FileDiff } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import type { ChangesCardData } from "@/api/convex/cardTypes";
import DiffCard from "../../DiffCard";
import { CARD_SURFACE, MUTED } from "./primitives";

/** Files beyond this start collapsed so a big change set stays scannable. */
const EXPANDED_FILES = 3;

/**
 * "Changed N files +x −y": the summary comes from the card; the diffs are
 * read live from the task's stored file changes (never copied into chat).
 */
export default function ChangesCard({ data }: { data: ChangesCardData }) {
  const changes = useQuery(api.fileChanges.listByTask, data.taskId ? { taskId: data.taskId as any } : "skip");
  const files = Array.isArray(data.files) ? data.files : [];
  const byPath = useMemo(() => {
    const map = new Map<string, any>();
    for (const change of changes ?? []) {
      if (data.subtaskKey && change.subtaskKey && change.subtaskKey !== data.subtaskKey) continue;
      // Latest row per path wins (a fix round may restage a file).
      const prior = map.get(change.filePath);
      if (!prior || (prior._creationTime ?? 0) < (change._creationTime ?? 0)) map.set(change.filePath, change);
    }
    return map;
  }, [changes, data.subtaskKey]);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  return (
    <div className={CARD_SURFACE}>
      <div className="flex items-center gap-2.5 px-4 py-3">
        <FileDiff size={16} className="shrink-0 text-[#8a8796] dark:text-neutral-400" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-[14px] font-semibold text-[#26242e] dark:text-neutral-100">
          Changed {files.length} {files.length === 1 ? "file" : "files"}
        </p>
        <span className="flex shrink-0 gap-1.5 tabular-nums text-[12px] font-semibold">
          <span className="text-[#1f9d55] dark:text-emerald-400">+{data.additions ?? 0}</span>
          <span className="text-[#d83a3a] dark:text-rose-400">−{data.deletions ?? 0}</span>
        </span>
      </div>
      {files.map((file, index) => {
        const change = byPath.get(file.path);
        const expanded = open[file.path] ?? index < EXPANDED_FILES;
        if (!change) {
          return (
            <div key={file.path} className="flex items-center gap-2 border-t border-[#efeef3] px-4 py-2 dark:border-white/[0.07]">
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#4c4a55] dark:text-neutral-300">{file.path}</span>
              <span className={`text-[11px] ${MUTED}`}>{changes === undefined ? "loading diff…" : "diff no longer stored"}</span>
            </div>
          );
        }
        return (
          <DiffCard
            key={file.path}
            variant="flush"
            forceUnified
            filePath={file.path}
            diff={change.diff ?? ""}
            changeType={file.changeType}
            expanded={expanded}
            onExpandedChange={(value) => setOpen((prev) => ({ ...prev, [file.path]: value }))}
          />
        );
      })}
    </div>
  );
}
