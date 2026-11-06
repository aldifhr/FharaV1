"use client";

import { motion } from "framer-motion";
import { useQuery } from "convex/react";
import { useState } from "react";
import { Activity as ActivityIcon, FileDiff, Info, Loader2, XCircle } from "lucide-react";
import { BlurFade } from "@/components/ui/blur-fade";
import { api } from "../../../api/convex/_generated/api";
import IconRail from "../../components/IconRail";
import { SkeletonBox } from "skullet/react";

type Event = {
  _id: string;
  type: string;
  projectId: string;
  payload?: any;
  _creationTime: number;
};

export default function ActivitiesPage() {
  const projects = useQuery(api.projects.list, {});
  const events = useQuery(api.taskEvents.listAll, {});
  const [filter, setFilter] = useState<string>("all");

  const projectNameById = new Map((projects ?? []).map((p: any) => [p._id as string, p.name]));
  const [visibleCount, setVisibleCount] = useState(20);
  const filtered = (events ?? []).filter((e: Event) => filter === "all" || e.projectId === filter);
  const visible = filtered.slice(0, visibleCount);

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-gray-900 dark:text-gray-100 max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail />
      <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="min-w-0 flex-1 overflow-y-auto p-6 max-[979px]:p-4">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-xl font-semibold">Activities</h1>
          <p className="mt-1 text-sm text-gray-500">Task events across all projects.</p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <label className="text-sm text-gray-500">Project</label>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            >
              <option value="all">All projects</option>
              {(projects ?? []).map((p: any) => (
                <option key={p._id} value={p._id as string}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-gray-400">{filtered.length} event(s)</span>
          </div>

          <div className="mt-6">
            {events !== undefined && filtered.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-2">
                {(() => {
                  const list = filtered;
                  const errors = list.filter((e: Event) => e.type === "task.error").length;
                  const stages = list.filter((e: Event) => e.type === "task.stage").length;
                  const files = list.filter((e: Event) => e.type === "fileChanges.updated").length;
                  return (
                    <>
                      <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-300">{list.length} events</span>
                      {stages > 0 && <span className="rounded-full bg-sky-50 px-2.5 py-1 text-[11px] font-semibold text-sky-700 dark:bg-sky-950">{stages} stages</span>}
                      {files > 0 && <span className="rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-700 dark:bg-violet-950">{files} file updates</span>}
                      {errors > 0 && <span className="rounded-full bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-700 dark:bg-red-950">{errors} errors</span>}
                    </>
                  );
                })()}
              </div>
            )}
            {events === undefined && (
              <div aria-hidden className="pointer-events-none space-y-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="relative">
                    <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
                      <div className="flex flex-wrap items-center gap-2">
                        <SkeletonBox height={18} width={72} radius={999} />
                        <SkeletonBox height={18} width={96} radius={999} />
                        <SkeletonBox height={12} width={40} />
                      </div>
                      <SkeletonBox height={12} width={i % 2 === 0 ? "75%" : "55%"} className="mt-2" />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {events && filtered.length === 0 && (
              <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-400 dark:border-gray-700">
                <ActivityIcon size={24} className="mx-auto mb-2 opacity-50" />
                No activity yet. Task events will appear here.
              </div>
            )}
            {filtered.length > 0 && (
              <div className="relative ml-3 border-l-2 border-gray-200 pl-5 dark:border-gray-800">
                {visible.slice(0, 50).map((e: Event, i: number) => {
                  const type = e.type;
                  const isError = type === "task.error";
                  const isStage = type === "task.stage";
                  const isFile = type === "fileChanges.updated";
                  const isStatus = type === "task.status";
                  const icon = isError ? <XCircle size={13} /> : isStage ? <Loader2 size={13} className="animate-spin" /> : isFile ? <FileDiff size={13} /> : <Info size={13} />;
                  const dotCls = isError ? "bg-red-500" : isStage ? "bg-sky-500" : isFile ? "bg-violet-500" : isStatus ? "bg-emerald-500" : "bg-gray-400";
                  const pillCls = isError ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400" : isStage ? "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-400" : isFile ? "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-400" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";
                  const msg = e.payload?.message ? String(e.payload.message) : null;
                  const time = e._creationTime ? new Date(e._creationTime).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) : "";
                  return (
                    <div key={e._id} className="relative pb-3">
                      <span className={`absolute -left-[25px] top-1 flex h-4 w-4 items-center justify-center rounded-full text-white ${dotCls}`}>
                        {icon}
                      </span>
                      <BlurFade delay={Math.min(i * 0.03, 0.4)} inView>
                        <div className={`rounded-lg px-3 py-2.5 text-sm ${isError ? "border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40" : "border border-gray-200 dark:border-gray-800"}`}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold ${pillCls}`}>{type}</span>
                            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                              {projectNameById.get(e.projectId as string) ?? "—"}
                            </span>
                            {time && <span className="text-[11px] text-gray-400">{time}</span>}
                          </div>
                          {msg && <p className={`mt-1.5 break-words leading-5 ${isError ? "text-red-700 dark:text-red-300" : "text-gray-600 dark:text-gray-300"}`}>{msg}</p>}
                        </div>
                      </BlurFade>
                    </div>
                  );
                })}
              </div>
            )}
            {filtered.length > visibleCount && (
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  onClick={() => setVisibleCount((c) => c + 50)}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                >
                  Load more ({filtered.length - visibleCount} remaining)
                </button>
              </div>
            )}
          </div>
        </div>
      </motion.section>
    </div>
  );
}
