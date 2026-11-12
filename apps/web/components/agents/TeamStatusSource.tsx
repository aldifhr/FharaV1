"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import QueryBoundary from "../shell/QueryBoundary";
import { subscribeChatTyping } from "@/lib/chatTyping";
import { statusFromLeases, type LeaseEntry, type StatusMap } from "@/lib/teamStatus";

type Props = { projectId?: string; children: (status: StatusMap | undefined) => ReactNode };

/** The server-derived live team status (one read model for the sidebar and the agent panel). */
function Live({ projectId, children }: Props) {
  const status = useQuery(api.shell.teamStatus, projectId ? { projectId: projectId as never } : {}) as StatusMap | undefined;
  return <>{children(status)}</>;
}

/** Fallback while a deployment lacks `shell.teamStatus`: the execution lease view, mapped to the same words. */
function Leases({ projectId, children }: Props) {
  const active = useQuery(api.executionView.activeByAgent, {}) as Record<string, LeaseEntry> | undefined;
  const status = useMemo(
    () => (active ? statusFromLeases(active, { projectId, otherProjects: "elsewhere", checkFirst: "review" }) : undefined),
    [active, projectId],
  );
  return <>{children(status)}</>;
}

/**
 * Hands its children the live status of every agent. Both the sidebar team
 * list and the agent panel read status through this, with the same
 * `projectId`, and label it with `agentStatusView`.
 */
export default function TeamStatusSource(props: Props) {
  return (
    <QueryBoundary fallback={<Leases {...props} />}>
      <Live {...props} />
    </QueryBoundary>
  );
}

/** Agents drafting a chat reply right now (chat replies have no execution lease; ChatPanel announces them). */
export function useDraftingAgentIds(): string[] {
  const [drafting, setDrafting] = useState<string[]>([]);
  useEffect(() => subscribeChatTyping((d) => setDrafting(d.active ? d.agentIds : [])), []);
  return drafting;
}
