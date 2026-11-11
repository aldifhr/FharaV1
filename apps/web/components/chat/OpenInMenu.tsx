"use client";

import { ChevronRight, Code2, ExternalLink, FolderOpen } from "lucide-react";
import { useState } from "react";
import { useToast } from "../Toasts";

/**
 * "Open in…" for the project's more menu: open the project folder, or the
 * current branch's worktree, in VS Code, Cursor or the file manager. The
 * server route (/api/open-in) runs only for loopback requests and picks the
 * folder itself; this component only names the project, task and launcher.
 */

type LauncherId = "vscode" | "cursor" | "files";

const LAUNCHER_ITEMS: { id: LauncherId; label: string; Icon: typeof Code2 }[] = [
  { id: "vscode", label: "VS Code", Icon: Code2 },
  { id: "cursor", label: "Cursor", Icon: Code2 },
  { id: "files", label: "File manager", Icon: FolderOpen },
];

const itemClass = "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[14px] hover:bg-hover disabled:opacity-50";

export default function OpenInMenu({
  projectId,
  branch,
  onDone,
}: {
  projectId?: string;
  /** The open branch's task, when there is one: its worktree is offered too. */
  branch: { name: string; taskId: string } | null;
  onDone: () => void;
}) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!projectId) return null;

  const open = async (launcher: LauncherId, taskId?: string) => {
    setBusy(true);
    try {
      const response = await fetch("/api/open-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, taskId, launcher }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        toast("error", "Could not open the folder", result.error);
        return;
      }
      onDone();
    } catch (error) {
      toast("error", "Could not open the folder", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const group = (heading: string, taskId?: string) => (
    <div key={heading}>
      <p className="truncate px-3 pb-0.5 pt-1.5 text-[12px] text-ink-3" title={heading}>
        {heading}
      </p>
      {LAUNCHER_ITEMS.map(({ id, label, Icon }) => (
        <button key={id} type="button" role="menuitem" disabled={busy} onClick={() => void open(id, taskId)} className={`${itemClass} pl-5`}>
          <Icon size={15} className="text-ink-3" /> {label}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <button type="button" role="menuitem" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)} className={itemClass}>
        <ExternalLink size={15} className="text-ink-3" />
        <span className="flex-1">Open in…</span>
        <ChevronRight size={14} className={`text-ink-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>
      {expanded && (
        <div className="pb-1">
          {group("Project folder")}
          {branch && group(`Worktree · ${branch.name}`, branch.taskId)}
        </div>
      )}
    </>
  );
}
