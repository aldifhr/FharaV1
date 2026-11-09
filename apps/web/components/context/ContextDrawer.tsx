"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "convex/react";
import { X } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import ContextInspector, { SnapshotPicker } from "./ContextInspector";

/** Right-side panel: the Context Inspector for one chat bubble's LLM calls. */
export default function ContextDrawer({ messageId, onClose }: { messageId: string; onClose: () => void }) {
  const rows = useQuery(api.contextSnapshots.forMessage, { messageId: messageId as never });
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  // The answer is the last call; earlier ones are repo-tool steps or a retry.
  const current = selected ?? (rows && rows.length > 0 ? rows[rows.length - 1]._id : undefined);
  if (!mounted) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Inspect context">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-2xl flex-col border-l border-line bg-panel">
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className="text-[15px] font-medium text-ink">Context</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-ink-3 hover:bg-hover hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {rows === undefined ? (
            <div className="h-8 rounded-lg bg-hover" />
          ) : rows.length === 0 ? (
            <p className="text-[13px] text-ink-3">
              No context was recorded for this reply. Snapshots are kept for the project&apos;s retention window and can be turned off with CONTEXT_SNAPSHOTS=0.
            </p>
          ) : (
            <div className="space-y-5">
              {rows.length > 1 && <SnapshotPicker rows={rows} selected={current} onSelect={setSelected} />}
              {current && <ContextInspector snapshotId={current} />}
            </div>
          )}
        </div>
      </aside>
    </div>,
    document.body
  );
}
