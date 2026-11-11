"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { clockTime } from "@/lib/format";

const EVENT_LABEL: Record<string, string> = {
  "task.stage": "Stage",
  "task.check": "Check",
  "task.error": "Error",
  "task.steered": "You steered",
  "task.input_answered": "You answered",
  "approval.held": "Approval held",
};

function eventSummary(e: { type: string; payload?: any }): string {
  const p = e.payload ?? {};
  const detail = p.label ?? p.stage ?? p.message ?? p.instruction ?? p.answer ?? p.status ?? "";
  const label = EVENT_LABEL[e.type] ?? e.type.replace(/^task\./, "").replace(/[._]/g, " ");
  return detail ? `${label} · ${String(detail).slice(0, 80)}` : label;
}

function ActivityFeed({ projectId }: { projectId: string }) {
  const events = useQuery(api.taskEvents.listByProject, { projectId: projectId as never, limit: 20 });
  const tasks = useQuery(api.tasks.listByProject, { projectId: projectId as never });
  const title = (id: string) => (tasks ?? []).find((t: any) => t._id === id)?.title;
  return (
    <div>
      <p className="text-caption border-b border-line px-3.5 py-2.5">Activity</p>
      <ul className="shell-scroll max-h-[360px] overflow-y-auto py-1">
        {events === undefined && <li className="px-3.5 py-3 text-ink-3">Loading…</li>}
        {events?.length === 0 && <li className="px-3.5 py-3 text-ink-3">No activity yet in this project.</li>}
        {(events ?? []).map((e: any) => (
          <li key={e._id} className="px-3.5 py-2">
            <p className={`truncate text-[13px] ${e.level === "error" ? "text-danger" : "text-ink"}`}>{eventSummary(e)}</p>
            <p className="mt-0.5 truncate text-xs text-ink-3">
              {title(e.taskId) ?? "Task"} · {clockTime(e._creationTime)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The project's recent activity, floating beside the sidebar button that opened it. */
export default function ActivityPopover({
  anchor,
  projectId,
  onClose,
  width = 300,
}: {
  anchor: HTMLElement | null;
  projectId: string;
  onClose: () => void;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  useEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const left = Math.min(r.right + 10, window.innerWidth - width - 8);
    setPos(r.top > window.innerHeight / 2 ? { left, bottom: window.innerHeight - r.bottom } : { left, top: r.top });
  }, [anchor, width]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);
  if (!pos || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      className="fixed z-[70] overflow-hidden rounded-card border border-line bg-panel text-sm text-ink shadow-[0_16px_40px_-12px_rgba(20,20,40,0.3)]"
      style={{ ...pos, width }}
    >
      <ActivityFeed projectId={projectId} />
    </div>,
    document.body,
  );
}
