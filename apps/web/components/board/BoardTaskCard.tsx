"use client";

import { motion } from "framer-motion";
import { ChevronDown, ChevronRight, Square, Trash2 } from "lucide-react";
import { roleLabel } from "@/lib/agentRoles";
import { isClosedStatus, subtaskStatusMeta, taskStatusLabel } from "@/lib/taskStatus";
import { taskStatusTone } from "@/lib/taskStatusTone";
import { holdNoticeText } from "@/api/convex/lib/providerHold";
import { PanelCard, PanelCardBody, PanelCardFooter, PanelCardHeader } from "../ui/panel-card";
import { StatusTag } from "../ui/status-tag";
import SubtaskActivity from "../SubtaskActivity";
import SubtaskLiveOutput from "../SubtaskLiveOutput";
import PauseResumeButton from "../PauseResumeButton";
import TaskHoldNotice from "../TaskHoldNotice";
import { PHASES, phaseOf, prSummary, type PrLaneRow } from "./boardModel";

const ICON_BTN =
  "rounded-field p-1.5 text-ink-3 outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30";

/** One task on the Tasks board, on the shared PanelCard parts (dashboard restyle F5). */
export default function BoardTaskCard({
  task: t,
  subtasks,
  plan,
  pendingCount,
  pr,
  laneLabel,
  selected,
  isOpen,
  agentById,
  onSelect,
  onToggle,
  onStop,
  onDelete,
}: {
  task: any;
  subtasks: any[];
  plan: any;
  pendingCount: number;
  pr: PrLaneRow | undefined;
  laneLabel: string;
  selected: boolean;
  isOpen: boolean;
  agentById: Map<string, any>;
  onSelect: () => void;
  onToggle: () => void;
  onStop: () => void;
  onDelete: () => void;
}) {
  const done = subtasks.filter((s) => s.status === "completed").length;
  const closed = isClosedStatus(t.status);
  const assigned = new Set<string>();
  for (const s of subtasks) {
    const role = agentById.get(s.assignedAgentId ?? "")?.role;
    if (role) assigned.add(roleLabel(role));
  }
  const held = Boolean(t.status === "paused" && t.pausedBy === "held" && t.hold);
  const warning = t.status === "done" && t.completionWarning ? String(t.completionWarning) : null;
  const hasMeta = (!isOpen && held) || Boolean(warning) || Boolean(pr);
  const current = phaseOf(t, subtasks);
  const currentIndex = PHASES.findIndex((p) => p.key === current);

  return (
    <motion.div layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
      <PanelCard selected={selected}>
        <PanelCardHeader
          kind={laneLabel}
          title={
            <button type="button" onClick={onSelect} className="block max-w-full truncate rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ink/30">
              {t.title}
            </button>
          }
          meta={
            hasMeta ? (
              <>
                {!isOpen && held && (
                  <p className="truncate text-ink-2" data-testid="board-hold-line">
                    {holdNoticeText(t.hold, Date.now())}
                  </p>
                )}
                {warning && <p className="truncate text-warn">{warning}</p>}
                {pr && <p className="truncate">{prSummary(pr)}</p>}
              </>
            ) : undefined
          }
          aside={
            <>
              <StatusTag tone={taskStatusTone(t.status, pendingCount > 0)}>{taskStatusLabel(t.status, t)}</StatusTag>
              <button type="button" onClick={onToggle} aria-label={isOpen ? `Collapse ${t.title}` : `Expand ${t.title}`} aria-expanded={isOpen} className={ICON_BTN}>
                {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              </button>
              {!closed && <PauseResumeButton task={t} />}
              {!closed ? (
                <button type="button" onClick={onStop} title="Stop task (delete it after it stops)" aria-label={`Stop task ${t.title}`} className={`${ICON_BTN} hover:text-danger`}>
                  <Square size={13} />
                </button>
              ) : (
                <button type="button" onClick={onDelete} title="Delete task" aria-label={`Delete task ${t.title}`} className={`${ICON_BTN} hover:text-danger disabled:opacity-30`}>
                  <Trash2 size={14} />
                </button>
              )}
            </>
          }
        />

        {isOpen && (
          <PanelCardBody caption={plan ? `Plan v${plan.version} · ${plan.createdBy}` : "Subtasks"}>
            <div className="space-y-1.5">
              {plan && (
                <p className="text-[12px] text-ink-2">
                  <span className="font-semibold text-ink">Goal:</span> {plan.goal}
                  {plan.createdBy === "fallback" && plan.degradedReason && (
                    <span className="mt-0.5 block text-warn">Deterministic plan: {plan.degradedReason}</span>
                  )}
                </p>
              )}
              {subtasks.length === 0 && <p className="text-xs text-ink-3">No subtasks yet.</p>}
              {subtasks.map((s: any) => {
                const status = subtaskStatusMeta(s.status);
                const Icon = status.icon;
                const agent = s.assignedAgentName ? agentById.get(s.assignedAgentId) : null;
                return (
                  <div key={s._id}>
                    <div className="flex items-center gap-2 text-xs">
                      <Icon size={13} className={`${status.cls}${s.status === "running" ? " animate-spin" : ""}`} />
                      <span className="min-w-0 flex-1 truncate font-medium text-ink">
                        {s.title}
                        {s.reviewRound && s.reviewRound > 1 ? <span className="ml-1 font-normal text-ink-3">(round {s.reviewRound})</span> : null}
                      </span>
                      <span className="text-mono-id shrink-0 text-[11px]">{s.capability}</span>
                      {s.assignedAgentName && <span className="shrink-0 text-[11px] text-ink-3">{roleLabel(agent?.role)}</span>}
                      <span className={`shrink-0 text-[10px] font-semibold ${status.cls}`}>{status.label}</span>
                    </div>
                    {s.status === "running" && s.activity && <SubtaskActivity activity={s.activity} at={s.activityAt} />}
                    {s.status === "running" && <SubtaskLiveOutput taskId={t._id} subtaskKey={s.key} />}
                  </div>
                );
              })}
              <TaskHoldNotice task={t} compact />
              {t.errorMessage && <p className="border-l-2 border-danger pl-2 text-[11px] text-danger">{t.errorMessage}</p>}
              {pr?.prUrl && (
                <a href={pr.prUrl} target="_blank" rel="noreferrer" className="block pt-1 text-[11px] text-ink outline-none hover:underline focus-visible:underline">
                  Open PR #{pr.prNumber} on GitHub
                </a>
              )}
              {/* Agile phase flow: plain steps, the current one in ink. */}
              <ol aria-label="Phase" className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-1.5 text-[11px]">
                {PHASES.map((phase, i) => (
                  <li key={phase.key} className="flex items-center gap-1.5">
                    <span
                      aria-current={i === currentIndex ? "step" : undefined}
                      className={i === currentIndex ? "font-semibold text-ink" : i < currentIndex ? "text-ok" : "text-ink-3"}
                    >
                      {phase.label}
                    </span>
                    {i < PHASES.length - 1 && <span aria-hidden="true" className="text-ink-3">→</span>}
                  </li>
                ))}
              </ol>
            </div>
          </PanelCardBody>
        )}

        <PanelCardFooter
          metrics={[
            { label: "Subtasks", value: subtasks.length ? `${done}/${subtasks.length}` : null },
            { label: "Approvals", value: pendingCount > 0 ? String(pendingCount) : null },
            { label: "PR", value: pr ? `#${pr.prNumber}` : null },
            { label: "Sprint", value: t.sprint ? String(t.sprint) : null },
          ]}
        >
          {assigned.size > 0 && (
            <span className="truncate text-[11px] text-ink-3" title={[...assigned].join(", ")}>
              {[...assigned].slice(0, 3).join(" · ")}
              {assigned.size > 3 ? ` +${assigned.size - 3}` : ""}
            </span>
          )}
        </PanelCardFooter>
      </PanelCard>
    </motion.div>
  );
}
