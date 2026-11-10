"use client";

import { ArrowUpRight, Users } from "lucide-react";
import type {
  AssignmentCardData,
  ChangesCardData,
  PlanCardData,
  PushCardData,
  QaCardData,
  SideEffectCardData,
  VerificationCardData,
} from "@/api/convex/cardTypes";
import { ROLE_COLORS, roleKeyForMention, roleLabel, NEUTRAL_MENTION_COLOR } from "@/lib/agentRoles";
import TaskCard from "../TaskCard";
import { useCardSurface } from "./CardContext";
import ChangesCard from "./ChangesCard";
import PlanCard from "./PlanCard";
import PushCard from "./PushCard";
import QaCard from "./QaCard";
import SideEffectCard from "./SideEffectCard";
import VerificationCard from "./VerificationCard";
import { CARD_SURFACE, MUTED, RoleAvatar } from "./primitives";

export type MessageCard = { kind: string; data: any };

/**
 * The single renderer for `messages.card` (plan 019). Unknown kinds render
 * nothing, so an older client never breaks on a newer card.
 */
export default function ChatCard({ card }: { card: MessageCard | undefined | null }) {
  if (!card || typeof card !== "object" || !card.data) return null;
  switch (card.kind) {
    case "assignment":
      return <AssignmentCard data={card.data as AssignmentCardData} />;
    case "verification":
      return <VerificationCard data={card.data as VerificationCardData} />;
    case "qa":
      return <QaCard data={card.data as QaCardData} />;
    case "push":
      return <PushCard data={card.data as PushCardData} />;
    case "changes":
      return <ChangesCard data={card.data as ChangesCardData} />;
    case "plan":
      return <PlanCard data={card.data as PlanCardData} />;
    case "side_effect":
      return <SideEffectCard data={card.data as SideEffectCardData} />;
    default:
      return null;
  }
}

/**
 * The task card the CTO posts when it assigns work. On a surface that has
 * the live task it is the full task card (status, owners, branch,
 * progress); otherwise the assignment as recorded.
 */
function AssignmentCard({ data }: { data: AssignmentCardData }) {
  const surface = useCardSurface();
  const task = (surface.tasks ?? []).find((t: any) => String(t._id) === data.taskId);
  const assignees = Array.isArray(data.assignees) ? data.assignees : [];
  if (task) {
    return (
      <TaskCard
        task={task}
        subtasks={surface.subtasksOf?.get(String(task._id)) ?? []}
        pending={(surface.pendingApprovals ?? []).filter((a: any) => a.taskId === task._id && a.status === "pending")}
        onOpen={(id) => surface.onOpenTask?.(id)}
        agents={surface.agents ?? []}
        approvalMode={surface.approvalMode ?? "ask"}
        assignees={assignees}
      />
    );
  }
  return (
    <div className={`${CARD_SURFACE} max-w-xl px-4 py-3`}>
      <div className="flex items-center gap-2.5">
        <Users size={16} className="shrink-0 text-ink-3" aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{data.title}</p>
        {surface.onOpenTask && (
          <button
            type="button"
            onClick={() => surface.onOpenTask?.(data.taskId)}
            aria-label={`Open task ${data.title}`}
            className="rounded-md p-1 text-ink-3 outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <ArrowUpRight size={16} />
          </button>
        )}
      </div>
      <div className={`mt-2 flex flex-wrap items-center gap-1.5 text-[12px] ${MUTED}`}>
        {data.assignedBy && <span>Assigned by {data.assignedBy} to</span>}
        {assignees.length === 0 && <span>the team</span>}
        {assignees.map((assignee) => {
          const key = roleKeyForMention(assignee.role) ?? roleKeyForMention(roleLabel(assignee.role));
          return (
            <span
              key={assignee.agentId}
              className={`inline-flex items-center gap-1 rounded-md py-0.5 pl-0.5 pr-1.5 text-[12px] font-medium ring-1 ring-inset ${key ? ROLE_COLORS[key] : NEUTRAL_MENTION_COLOR}`}
            >
              <RoleAvatar role={assignee.role} size={16} />
              {roleLabel(assignee.role)}
            </span>
          );
        })}
      </div>
    </div>
  );
}
