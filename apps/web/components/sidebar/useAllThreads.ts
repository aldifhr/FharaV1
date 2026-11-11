"use client";

import { useMemo } from "react";
import { useQueries, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import type { ThreadItem } from "@/lib/threadTree";

/** Projects whose threads are loaded (newest projects first) and rows per project. */
const MAX_PROJECTS = 20;
const PER_PROJECT = 50;

type ProjectRow = { _id: string; name: string };
type ListRow = Omit<ThreadItem, "projectId" | "projectName">;

/**
 * Threads of every visible project, flattened. `undefined` until the first load.
 * Shared by the sidebar thread list and the command menu's recent threads, so
 * both read the same Convex subscriptions. `enabled: false` subscribes to nothing.
 */
export function useAllThreads(enabled = true): ThreadItem[] | undefined {
  const projects = useQuery(api.projects.list, enabled ? {} : "skip") as ProjectRow[] | undefined;
  const shown = useMemo(() => (projects ?? []).slice(0, MAX_PROJECTS), [projects]);
  const requests = useMemo(
    () => Object.fromEntries(shown.map((p) => [p._id, { query: api.threads.list, args: { projectId: p._id, limit: PER_PROJECT } }])),
    [shown],
  );
  const results = useQueries(requests);
  return useMemo(() => {
    if (projects === undefined) return undefined;
    const rows: ThreadItem[] = [];
    for (const p of shown) {
      const list = results[p._id];
      if (!Array.isArray(list)) continue; // loading, or no access: skip that project
      for (const r of list as ListRow[]) rows.push({ ...r, id: String(r.id), projectId: p._id, projectName: p.name });
    }
    return rows;
  }, [projects, shown, results]);
}
