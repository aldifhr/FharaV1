"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { CHARACTER_TABLE } from "./characters";
import {
  buildOfficeSnapshot,
  type AgentDoc,
  type ApprovalDoc,
  type OfficeSnapshot,
  type PushDoc,
  type SubtaskDoc,
  type TaskDoc,
  type UsageTotals,
} from "./feed";

/** How often time-based states (thumbs-up, incident window) are re-checked. */
const CLOCK_MS = 15_000;

export interface OfficeFeed {
  /** undefined while the queries load */
  snapshot: OfficeSnapshot | undefined;
}

/**
 * The office's live feed: Convex subscriptions mapped into one snapshot
 * (feed.ts). Replaces Claude-Office's useAgentSocket WebSocket.
 *
 *   agents.listByProject           roster (characters)
 *   tasks.listByProject            whiteboard, incident (failed task)
 *   approvals.listPendingForProject hands up + permission cards
 *   office.feed                    subtasks + live activity, pushes, usage
 */
export function useFharaOfficeFeed(projectId: string | null): OfficeFeed {
  const args = projectId ? { projectId: projectId as never } : "skip";
  const agents = useQuery(api.agents.listByProject, args) as AgentDoc[] | undefined;
  const tasks = useQuery(api.tasks.listByProject, projectId ? { projectId: projectId as never, limit: 60 } : "skip") as TaskDoc[] | undefined;
  const approvals = useQuery(api.approvals.listPendingForProject, args) as ApprovalDoc[] | undefined;
  const feed = useQuery(api.office.feed, args) as
    | { subtasks: SubtaskDoc[]; pushes: PushDoc[]; usage: UsageTotals }
    | null
    | undefined;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  const snapshot = useMemo(() => {
    if (!projectId || agents === undefined || tasks === undefined || approvals === undefined || feed === undefined) return undefined;
    return buildOfficeSnapshot({
      agents,
      tasks,
      approvals,
      subtasks: feed?.subtasks ?? [],
      pushes: feed?.pushes ?? [],
      usage: feed?.usage ?? null,
      characters: CHARACTER_TABLE,
      now,
    });
  }, [projectId, agents, tasks, approvals, feed, now]);

  return { snapshot };
}
