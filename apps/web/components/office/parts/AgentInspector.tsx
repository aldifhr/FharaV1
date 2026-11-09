"use client";
/*
 * The card that opens when a character is clicked. Follows Claude-Office's
 * inspector (src/components/AgentCard.tsx, MIT, Copyright (c) 2026 W17ANT):
 * who it is, what it is on, its recent activity. Fhara port: data from
 * Convex (taskEvents.listByTask of the agent's current task), Fhara chrome.
 */
import Link from "next/link";
import { useQuery } from "convex/react";
import { X } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { roleLabel } from "@/lib/agentRoles";
import { PORTRAIT_DIR, ROLE_PORTRAITS } from "../characters";
import type { Agent } from "../engine/types";

type TaskEvent = {
  _id: string;
  type: string;
  message?: string;
  subtaskKey?: string;
  agentId?: string;
  level?: string;
  sequence?: number;
  createdAt?: number;
  _creationTime: number;
};

const STATE_LABEL: Record<Agent["state"], string> = {
  "new-hire": "baru masuk",
  "walking-to-desk": "kembali ke meja",
  working: "bekerja",
  idle: "santai",
  "coffee-break": "rehat kopi",
  completed: "baru selesai",
  leaving: "pulang",
  waiting: "menunggu meja",
};

function eventLine(e: TaskEvent): string {
  if (e.message?.trim()) return e.message.trim();
  return e.type.replace(/[._]/g, " ");
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

export default function AgentInspector({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const events = useQuery(api.taskEvents.listByTask, agent.taskId ? { taskId: agent.taskId as never } : "skip") as TaskEvent[] | undefined;
  const mine = (events ?? [])
    .filter((e) => e.agentId === agent.id || (agent.subtaskKey !== undefined && e.subtaskKey === agent.subtaskKey))
    .slice(-8)
    .reverse();
  const portrait = `${PORTRAIT_DIR}/${ROLE_PORTRAITS[agent.role] ?? ROLE_PORTRAITS.default}`;
  const state = agent.needsYou ? "menunggu persetujuanmu" : agent.lastFailed ? "gagal" : STATE_LABEL[agent.state];

  return (
    <section aria-label={`Detail ${agent.name}`} className="rounded-xl border border-line bg-panel">
      <header className="flex items-start gap-3 border-b border-line px-4 py-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={portrait} alt="" className="h-14 w-auto shrink-0 [image-rendering:pixelated]" draggable={false} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold text-ink">{agent.name}</h2>
          <p className="text-[12.5px] text-ink-3">
            {roleLabel(agent.role)} · {state}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Tutup" className="rounded-lg p-1 text-ink-3 transition hover:bg-hover hover:text-ink">
          <X size={15} />
        </button>
      </header>
      <div className="space-y-3 px-4 py-3">
        <div>
          <p className="text-[12px] text-ink-3">Sedang</p>
          <p className="text-[13.5px] leading-snug text-ink">{agent.statusText || "—"}</p>
        </div>
        {agent.taskId && (
          <div>
            <p className="text-[12px] text-ink-3">Task</p>
            <Link href={`/runs/${agent.taskId}`} className="text-[13.5px] leading-snug text-ink underline-offset-2 hover:underline">
              {agent.task ?? "Buka task"}
            </Link>
          </div>
        )}
        {agent.taskId && (
          <div>
            <p className="text-[12px] text-ink-3">Aktivitas terakhir</p>
            {events === undefined ? (
              <p className="text-[13px] text-ink-3">Memuat…</p>
            ) : mine.length === 0 ? (
              <p className="text-[13px] text-ink-3">Belum ada aktivitas.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {mine.map((e) => (
                  <li key={e._id} className="flex gap-2 text-[12.5px]">
                    <span className="shrink-0 tabular-nums text-ink-3">{clock(e.createdAt ?? e._creationTime)}</span>
                    <span className={`min-w-0 break-words ${e.level === "error" ? "text-red-600 dark:text-red-400" : "text-ink-2"}`}>{eventLine(e)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
