"use client";

import { motion } from "framer-motion";
import { Pin } from "lucide-react";
import { parseOptions } from "@/lib/options";
import { roleLabel } from "@/lib/agentRoles";
import ApprovalCard from "../ApprovalCard";
import QaPanel from "../QaPanel";
import DiffCard from "../DiffCard";
import AgentAvatar from "../AgentAvatar";
import MessageText from "./MessageText";
import OptionCards from "./OptionCards";
import TaskCard from "./TaskCard";

export type MessageKind = "evaluation" | "planning" | "delegation" | "design" | null;

export function messageKindOf(content: string): MessageKind {
  return /^Task (completed|finished)/.test(content) ? "evaluation" :
    /^Plan dibuat/.test(content) ? "planning" :
    /^Delegation:/.test(content) ? "delegation" :
    /^Design proposal:/.test(content) ? "design" : null;
}

export function delegationParts(content: string) {
  const match = content.match(/^Delegation:\s*(.+?)\s*→\s*(.+?)\s*\((.+?)\)(?::\s*(.*))?$/s);
  return match ? { from: match[1], to: match[2], capability: match[3], reason: match[4] ?? "" } : null;
}

type Props = {
  timeline: any[];
  firstNewIndex: number;
  agents: any[];
  tasks?: any[];
  subtasksOf: Map<string, any[]>;
  pendingItems: any[];
  projectEvents?: any[];
  projectApprovalMode: "ask" | "auto";
  fileChangesByTask?: any[];
  latestAgentMessage: any;
  diffStats: { added: number; removed: number };
  chatSending: boolean;
  conversationTyping: boolean;
  replyingNames: string[];
  activeForSelectedTask: any[];
  workingAgents: any[];
  onSelectTask: (taskId: string) => void;
  approve: (approvalId: string) => void;
  reject: (approvalId: string) => void;
  hold: (approvalId: string) => void;
  togglePin: (messageId: string, pinned: boolean) => void;
  onPickProposal: (choice: string) => void;
  formatTime: (createdAt: number) => string;
  taskTitle: (taskId: string) => string;
  blockKey: (m: any) => string;
};

export default function MessageList(props: Props) {
  const {
    timeline, firstNewIndex, agents, tasks = [], subtasksOf, pendingItems, projectEvents = [],
    projectApprovalMode, fileChangesByTask, latestAgentMessage, diffStats, chatSending,
    conversationTyping, replyingNames, activeForSelectedTask, workingAgents, onSelectTask, approve, reject,
    hold, togglePin, onPickProposal, formatTime, taskTitle, blockKey,
  } = props;

  return (
    <>
      {timeline.map((m: any, index: number) => {
        const previous = timeline[index - 1];
        const key = blockKey(m);
        const prevKey = previous ? blockKey(previous) : null;
        // Divider marks the start of a task block (at the user's message
        // that spawned it), not a transition back to plain conversation.
        const boundary = key !== prevKey && key !== "conversation";
        const showTaskCard = key !== "conversation" && m.authorType === "agent" && previous?.authorType === "user";
        const messageAgent = m.authorType === "agent"
          ? (agents as any)?.find((a: any) => a._id === m.agentId)
          : undefined;
        return (
          <div key={m._id}>
            {index === firstNewIndex && (
              <div className="flex items-center gap-3 text-[11px] font-medium text-[#635bff]">
                <span className="h-px flex-1 bg-[#e5e3eb] dark:bg-gray-700" />
                <span className="h-1.5 w-1.5 rounded-full bg-[#635bff]" />
                New
              </div>
            )}
            {boundary && (
              <p className="my-5 text-center text-[11px] text-gray-400">
                — {taskTitle(key)} —
              </p>
            )}
            {showTaskCard && (() => {
              const cardTask = (tasks ?? []).find((t: any) => t._id === key);
              if (!cardTask) return null;
              const pending = pendingItems.filter((a: any) => a.taskId === key && a.status === "pending");
              const qaEvents = (projectEvents ?? []).filter((e: any) => e.taskId === key && e.type === "task.check");
              return (
                <div className="space-y-2">
                  <TaskCard
                    task={cardTask}
                    subtasks={subtasksOf.get(key) ?? []}
                    pending={pending}
                    onApprove={approve}
                    onOpen={onSelectTask}
                    agents={agents}
                    approvalMode={projectApprovalMode}
                  />
                  {pending.map((a: any) => (
                    <ApprovalCard
                      key={a._id}
                      approval={a}
                      taskTitle={cardTask.title}
                      onApprove={approve}
                      onReject={reject}
                      onHold={hold}
                      onReview={onSelectTask}
                    />
                  ))}
                  {qaEvents.length > 0 && <QaPanel events={qaEvents} />}
                </div>
              );
            })()}
            <motion.div
              key={m._id}
              id={`message-${m._id}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.18) }}
              className="group mt-3 flex gap-3"
            >
              {m.authorType === "agent" ? (
                <AgentAvatar
                  name={roleLabel(messageAgent?.role)}
                  size={32}
                  avatarParams={messageAgent?.avatarParams}
                />
              ) : (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#eceaf3] text-[11px] font-bold text-[#5147b4] dark:bg-white/15 dark:text-white">
                  You
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold text-[#34323d] dark:text-gray-100">
                    {m.authorType === "agent"
                      ? roleLabel(messageAgent?.role)
                      : "You"}
                    {(() => {
                      const kind = messageKindOf(m.content);
                      if (kind === "evaluation") return (
                        <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
                          <svg className="animate-[spin_2.5s_linear_infinite]" xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <circle cx="12" cy="12" r="10" />
                            <path d="m16 9-5.5 5.5L8 12" />
                          </svg>
                          evaluated
                        </span>
                      );
                      if (kind === "planning") return <span className=" rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700 dark:bg-purple-900 dark:text-purple-300">planned</span>;
                      if (kind === "delegation") return <span className=" rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">delegated</span>;
                      if (kind === "design") return <span className=" rounded-full bg-pink-100 px-1.5 py-0.5 text-[10px] font-semibold text-pink-700 dark:bg-pink-950 dark:text-pink-300">design proposal</span>;
                      return null;
                    })()}
                  </p>
                  <span className="text-[11px] text-gray-400">{formatTime(m._creationTime)}</span>
                  <button
                    type="button"
                    title={m.pinned ? "Unpin message" : "Pin message"}
                    aria-label={m.pinned ? "Unpin message" : "Pin message"}
                    aria-pressed={Boolean(m.pinned)}
                    onClick={() => togglePin(m._id, !m.pinned)}
                    className={`rounded p-0.5 transition ${
                      m.pinned
                        ? "text-[#635bff]"
                        : "text-gray-300 opacity-0 group-hover:opacity-100 hover:text-[#635bff]"
                    }`}
                  >
                    <Pin size={11} />
                  </button>
                </div>
                {messageKindOf(m.content) === "delegation" ? null : (
                  <MessageText content={parseOptions(m.content).text} />
                )}
                {(() => {
                  if (m.authorType !== "agent") return null;
                  const { options } = parseOptions(m.content);
                  if (options.length === 0) return null;
                  const next = timeline[index + 1];
                  const pickedMsg = next?.authorType === "user" ? (next.content ?? "") : "";
                  const pickedId = options.find(
                    (o) =>
                      new RegExp(`^I choose ${o.id}\\b`, "i").test(pickedMsg) ||
                      pickedMsg.includes(o.title)
                  )?.id;
                  // The mockup's second chip: does the CTO endorse the
                  // pick in its next reply?
                  let ctoAgrees = false;
                  if (pickedId) {
                    for (let i = index + 2; i < timeline.length && i < index + 6; i += 1) {
                      const candidate = timeline[i];
                      if (!candidate || candidate.authorType !== "agent") continue;
                      const role = (agents as any)?.find((a: any) => a._id === candidate.agentId)?.role;
                      if (!/^(cto|architect|lead|orchestrator|planner)$/i.test(role ?? "")) continue;
                      ctoAgrees = /^\s*i agree\b/i.test(candidate.content ?? "");
                      break;
                    }
                  }
                  // The pick auto-creates a task ("Task created from
                  // your pick"); bind the card to that task's live
                  // status so the card evolves with execution.
                  let linkedTaskId: string | undefined;
                  let linkedTaskStatus: string | undefined;
                  if (pickedId) {
                    for (let i = index + 2; i < timeline.length; i += 1) {
                      const candidate = timeline[i];
                      if (
                        candidate?.taskId &&
                        typeof candidate.content === "string" &&
                        candidate.content.startsWith("Task created from your pick")
                      ) {
                        linkedTaskId = candidate.taskId;
                        linkedTaskStatus = (tasks ?? []).find((t: any) => t._id === candidate.taskId)?.status;
                        break;
                      }
                    }
                  }
                  return (
                    <OptionCards
                      options={options}
                      pickedId={pickedId}
                      ctoAgrees={ctoAgrees}
                      taskId={linkedTaskId}
                      taskStatus={linkedTaskStatus}
                      disabled={chatSending}
                      onPick={(option) => onPickProposal(`I choose ${option.id}: ${option.title}`)}
                      onOpenTask={onSelectTask}
                    />
                  );
                })()}
                {(() => {
                  const kind = messageKindOf(m.content);
                  if (kind !== "delegation") return null;
                  const parts = delegationParts(m.content);
                  if (!parts) return null;
                  return (
                    <div className="mt-2 flex max-w-3xl flex-wrap items-center gap-2 rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs dark:border-indigo-950 dark:bg-indigo-950/20">
                      <span className="font-semibold dark:text-white">{parts.from}</span>
                      <span aria-hidden="true" className="text-indigo-400">→</span>
                      <span className="font-semibold dark:text-white">{parts.to}</span>
                      <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-indigo-600 ring-1 ring-indigo-100 dark:bg-gray-900 dark:text-indigo-300 dark:ring-gray-800">{parts.capability}</span>
                      {parts.reason && <span className="w-full text-gray-500 dark:text-gray-400">{parts.reason}</span>}
                    </div>
                  );
                })()}
                {m.taskId && fileChangesByTask?.length && m._id === latestAgentMessage?._id ? (
                  <div className="mt-2">
                    <p className="mb-2 flex items-center gap-2 text-xs font-semibold text-gray-600">
                      Changed {(fileChangesByTask as any).length} files
                      <span className="text-emerald-600">+{diffStats.added}</span>
                      <span className="text-rose-500">−{diffStats.removed}</span>
                    </p>
                    {(fileChangesByTask as any).map((fc: any) => {
                      const pendingApproval = pendingItems.find(
                        (a: any) => a.taskId === m.taskId && a.status === "pending" && (a.payload?.filePaths ?? []).includes(fc.filePath),
                      );
                      return (
                        <DiffCard
                          key={fc._id}
                          filePath={fc.filePath}
                          diff={fc.diff}
                          changeType={fc.changeType}
                          oldContent={fc.oldContent}
                          newContent={fc.newContent}
                          applied={Boolean(fc.appliedAt)}
                          approvalId={pendingApproval?._id as string}
                          busy={false}
                          onApprove={(id) => approve(id as string)}
                          onReject={(id) => reject(id as string)}
                        />
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </motion.div>
          </div>
        );
      })}
      {/* Generic chat-reply indicator. Per-agent status (Working now
          / X is thinking) is more specific: when either is visible,
          this one hides so the same state is not announced twice. */}
      {conversationTyping && activeForSelectedTask.length === 0 && workingAgents.length === 0 && (
        <div className="flex items-center gap-2.5 rounded-full border border-[#ebe9f4] bg-white/80 px-3 py-1.5 text-xs font-medium text-gray-500 shadow-sm dark:border-gray-700 dark:bg-gray-800/80 dark:text-gray-300">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#eeecfb] text-[10px] text-[#635bff] dark:bg-indigo-950 dark:text-indigo-300" aria-hidden="true">✦</span>
          <span>{replyLabel(replyingNames)}</span>
          <span className="flex gap-1" aria-label="Agent is typing">
            <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8b82e8]" />
            <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8b82e8] [animation-delay:120ms]" />
            <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8b82e8] [animation-delay:240ms]" />
          </span>
        </div>
      )}
      {!timeline.length && <p className="text-sm text-gray-400">No messages yet.</p>}
      {activeForSelectedTask.length > 0 ? (
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-800 dark:bg-gray-900">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-600 dark:text-gray-300">
            <span className="relative flex h-2 w-2">
              <span className="absolute h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            Working now
          </div>
          <div className="mt-1.5 space-y-1">
            {activeForSelectedTask.map(({ agent, stage, subtaskKey }: any) => (
              <div key={agent._id} className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                <AgentAvatar name={roleLabel(agent.role)} size={18} status="working" avatarParams={agent.avatarParams} />
                <span className="font-medium">{roleLabel(agent.role)}</span>
                <span className="text-gray-400">
                  {stage === "waiting_approval" ? "waiting approval" : stage === "queued" ? "queued" : "thinking"}
                  {subtaskKey ? ` · ${subtaskKey}` : ""}
                </span>
                <span className="flex gap-0.5" aria-label="Agent is typing">
                  <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" />
                  <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:120ms]" />
                  <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:240ms]" />
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        workingAgents.length > 0 && (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <div className="flex space-x-1">
              {workingAgents.slice(0, 3).map((agent: any) => (
                <AgentAvatar
                  key={agent._id}
                  name={roleLabel(agent.role)}
                  size={20}
                  avatarParams={agent.avatarParams}
                />
              ))}
            </div>
            <span>{workingAgents.map((agent: any) => roleLabel(agent.role)).join(", ")} is thinking</span>
            <span className="flex gap-0.5" aria-label="Agent is thinking">
              <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" />
              <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:120ms]" />
              <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:240ms]" />
            </span>
          </div>
        )
      )}
    </>
  );
}

/** The pill names who is drafting a reply instead of the generic
 *  "Team is thinking" — falls back to "Team" when the selection is empty. */
function replyLabel(names: string[]): string {
  const [a, b, c] = names;
  if (!a) return "Team is thinking";
  if (!b) return `${a} is drafting a reply`;
  if (!c) return `${a} and ${b} are drafting replies`;
  return `${a}, ${b} and ${c} are drafting replies`;
}
