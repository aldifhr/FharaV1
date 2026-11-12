"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "convex/react";
import { Trash2 } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import ProjectAvatar from "../shell/ProjectAvatar";
import QueryBoundary from "../shell/QueryBoundary";
import { SectionToggle } from "./SectionToggle";

type ProjectRow = { _id: string; name: string };
type Counts = Record<string, { open: number; needsYou: number }>;

const SHOWN = 7;

function ProjectRows({
  projects,
  counts,
  currentId,
  onSelect,
  onRemove,
}: {
  projects: ProjectRow[];
  counts?: Counts;
  currentId?: string;
  onSelect?: (id: string) => void;
  onRemove: (project: ProjectRow) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? projects : projects.slice(0, SHOWN);
  return (
    <>
      <ul className="mt-1 space-y-px">
        {shown.map((p) => {
          const selected = currentId === p._id;
          const c = counts?.[p._id];
          return (
            <li key={p._id} className={`group relative flex items-center rounded-lg transition ${selected ? "bg-hover" : "hover:bg-hover"}`}>
              <Link
                href={`/project/${p._id}`}
                onClick={() => onSelect?.(p._id)}
                aria-current={selected ? "page" : undefined}
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-[7px] outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
              >
                <ProjectAvatar name={p.name} size={22} />
                <span className={`min-w-0 flex-1 truncate text-[15px] ${selected ? "font-medium text-ink" : "text-ink"}`}>{p.name}</span>
                {c && c.open + c.needsYou > 0 && (
                  <span
                    title={`${c.open} in flight${c.needsYou ? ` · ${c.needsYou} need you` : ""}`}
                    className={`ml-1 flex h-5 min-w-5 items-center justify-center rounded-md border px-1 text-[11px] font-medium tabular-nums group-hover:opacity-0 [@media(hover:none)]:group-hover:opacity-100 ${
                      c.needsYou ? "border-warn/30 text-warn" : "border-line-strong text-ink-2"
                    }`}
                  >
                    {c.needsYou || c.open}
                  </span>
                )}
              </Link>
              <button
                type="button"
                onClick={() => onRemove(p)}
                aria-label={`Delete ${p.name}`}
                title="Delete project"
                className="absolute right-1.5 hidden h-6 w-6 items-center justify-center rounded-md text-ink-3 outline-none hover:bg-red-50 hover:text-red-600 focus-visible:flex focus-visible:ring-2 focus-visible:ring-red-400/40 group-hover:flex dark:hover:bg-red-950/40 [@media(hover:none)]:hidden"
              >
                <Trash2 size={13} />
              </button>
            </li>
          );
        })}
      </ul>
      {projects.length > SHOWN && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[14px] text-ink-2 hover:bg-hover hover:text-ink"
        >
          <span aria-hidden="true" className={`inline-block text-ink-3 transition-transform ${showAll ? "rotate-90" : ""}`}>›</span>
          {showAll ? "Show less" : `${projects.length - SHOWN} more`}
        </button>
      )}
    </>
  );
}

function WithCounts(props: Omit<Parameters<typeof ProjectRows>[0], "counts">) {
  const counts = useQuery(api.shell.projectCounts, {});
  return <ProjectRows {...props} counts={counts} />;
}

export default function ProjectList({
  filter,
  currentId,
  open,
  onToggle,
  onAdd,
  onSelect,
  onRemove,
}: {
  filter: string;
  currentId?: string;
  open: boolean;
  onToggle: () => void;
  onAdd: () => void;
  onSelect?: (id: string) => void;
  onRemove: (project: ProjectRow) => void;
}) {
  const projects = useQuery(api.projects.list, {}) as ProjectRow[] | undefined;
  const q = filter.trim().toLowerCase();
  const filtered = (projects ?? []).filter((p) => p.name.toLowerCase().includes(q));
  const rowProps = { projects: filtered, currentId, onSelect, onRemove };
  return (
    <section aria-label="Projects">
      <SectionToggle title="Projects" count={projects?.length} open={open} onToggle={onToggle} onAdd={onAdd} addLabel="New project" chevron />
      {open && projects === undefined && (
        <div aria-hidden className="mt-1 space-y-2 px-2 py-1">
          {[60, 45, 52].map((w) => (
            <div key={w} className="flex items-center gap-2.5">
              <span className="h-[22px] w-[22px] animate-pulse rounded-md bg-hover" />
              <span className="h-3.5 animate-pulse rounded bg-hover" style={{ width: `${w}%` }} />
            </div>
          ))}
        </div>
      )}
      {open && projects !== undefined && filtered.length === 0 && (
        <p className="px-2 pt-1.5 text-[13px] text-ink-3">{q ? "No projects match." : "No projects yet."}</p>
      )}
      {open && filtered.length > 0 && (
        <QueryBoundary fallback={<ProjectRows {...rowProps} />}>
          <WithCounts {...rowProps} />
        </QueryBoundary>
      )}
    </section>
  );
}
