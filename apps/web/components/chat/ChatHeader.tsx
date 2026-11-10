"use client";

import { Bell, Check, Copy, GitBranch, Menu, MoreHorizontal, PanelLeftOpen, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { useState } from "react";
import InitialAvatar from "../InitialAvatar";
import ProjectAvatar from "../shell/ProjectAvatar";
import { iconButtonClass, popoverClass, usePopover } from "../shell/usePopover";
import { agentName, roleLabel } from "@/lib/agentRoles";
import { teamStatusLabel, type StatusMap } from "@/lib/teamStatus";
import type { AgentRef as Agent } from "@/lib/types";

export type ChatTab = "chat" | "tasks" | "files";

export type HeaderNotification = {
  key: string;
  title: string;
  meta: string;
  approvalId?: string;
  taskId?: string;
};

type PinnedMessage = { _id: string; content: string; authorType: string; agentId?: string; taskId?: string; _creationTime: number };

/** "shedi.app" from the dev URL, else the repo folder name. */
export function appLabel(project: { devUrl?: string; workspacePath?: string } | null | undefined): string | null {
  if (!project) return null;
  if (project.devUrl) {
    try {
      return new URL(project.devUrl).host;
    } catch {
      /* not a URL — fall through */
    }
  }
  const base = project.workspacePath?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return base || null;
}

export default function ChatHeader({
  project,
  agents,
  status,
  tab,
  onTab,
  openTaskCount,
  branch,
  onOpenTask,
  pins,
  onJumpToPin,
  onUnpin,
  notifications,
  onApprove,
  onReject,
  onOpenAgent,
  onCopyLink,
  onManage,
  onClearChat,
  sidebarCollapsed,
  onExpandSidebar,
  onOpenDrawer,
  formatTime,
}: {
  project: { name?: string; devUrl?: string; workspacePath?: string } | null | undefined;
  agents: Agent[];
  status?: StatusMap;
  tab: ChatTab;
  onTab: (tab: ChatTab) => void;
  openTaskCount: number;
  branch: { name: string; taskId: string; taskTitle: string } | null;
  onOpenTask: (taskId: string) => void;
  pins: PinnedMessage[] | undefined;
  onJumpToPin: (message: PinnedMessage) => void;
  onUnpin: (messageId: string) => void;
  notifications: HeaderNotification[];
  onApprove: (approvalId: string) => Promise<unknown>;
  onReject: (approvalId: string) => Promise<unknown>;
  onOpenAgent?: (agentId: string) => void;
  onCopyLink: () => Promise<boolean>;
  onManage: () => void;
  onClearChat: () => void;
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  onOpenDrawer: () => void;
  formatTime: (ms: number) => string;
}) {
  const pinPop = usePopover();
  const bellPop = usePopover();
  const morePop = usePopover();
  const [copied, setCopied] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState<string | null>(null);
  const app = appLabel(project);
  const stacked = agents.slice(0, 5);
  const pinCount = pins?.length ?? 0;
  const agentRole = (id?: string) => roleLabel(agents.find((a) => a._id === id)?.role);

  const act = async (approvalId: string, run: (id: string) => Promise<unknown>) => {
    setActing(approvalId);
    setConfirmReject(null);
    try {
      await run(approvalId);
    } finally {
      setActing(null);
    }
  };

  const tabs = (
    <div role="tablist" aria-label="Workspace view" className="flex items-center rounded-xl bg-hover p-1">
      {(["chat", "tasks", "files"] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          onClick={() => onTab(t)}
          className={`flex-1 rounded-lg px-3.5 py-1.5 text-[14px] capitalize outline-none transition focus-visible:ring-2 focus-visible:ring-brand/40 ${
            tab === t ? "bg-panel font-medium text-ink shadow-[0_1px_2px_rgba(20,20,40,0.08)]" : "text-ink-2 hover:text-ink"
          }`}
        >
          {t}
          {t === "tasks" && openTaskCount > 0 && <span className="ml-1.5 tabular-nums text-ink-3">{openTaskCount}</span>}
        </button>
      ))}
    </div>
  );

  return (
    <header className="shrink-0 border-b border-line bg-panel pt-[env(safe-area-inset-top)]">
      <div className="flex h-[64px] items-center gap-3 px-3 sm:px-5">
        <button type="button" onClick={onOpenDrawer} aria-label="Open projects and team" className={`${iconButtonClass} -ml-1 min-[980px]:hidden`}>
          <Menu size={18} />
        </button>
        {sidebarCollapsed && (
          <button type="button" onClick={onExpandSidebar} aria-label="Show sidebar" title="Show sidebar" className={`${iconButtonClass} -ml-1 max-[979px]:hidden`}>
            <PanelLeftOpen size={17} strokeWidth={1.75} />
          </button>
        )}
        <ProjectAvatar name={project?.name ?? "•"} size={34} />
        <div className="min-w-0">
          <h1 className="truncate text-[16px] font-semibold leading-tight text-ink">{project?.name ?? "Project"}</h1>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            {stacked.length > 0 && (
              <span className="flex shrink-0 items-center max-sm:hidden">
                {stacked.map((a) => (
                  <button
                    key={a._id}
                    type="button"
                    onClick={() => onOpenAgent?.(a._id)}
                    title={`${agentName(a)} · ${teamStatusLabel(status?.[a._id])}`}
                    aria-label={`${agentName(a)}, ${teamStatusLabel(status?.[a._id])}`}
                    className="-ml-1 rounded-full ring-2 ring-panel outline-none first:ml-0 focus-visible:ring-brand/50"
                  >
                    <InitialAvatar agent avatarParams={a.avatarParams} name={agentName(a)} size={17} />
                  </button>
                ))}
              </span>
            )}
            <span className="truncate text-[13px] text-ink-2">
              {agents.length} {agents.length === 1 ? "agent" : "agents"}
              {app ? <span className="max-sm:hidden"> · {app}</span> : null}
            </span>
          </div>
        </div>

        <div className="mx-auto hidden md:block">{tabs}</div>

        <div className="ml-auto flex items-center gap-0.5 md:ml-0">
          {branch && (
            <button
              type="button"
              onClick={() => onOpenTask(branch.taskId)}
              title={`Branch of “${branch.taskTitle}”`}
              className="mr-1 hidden h-8 max-w-[180px] items-center gap-1.5 rounded-lg border border-line px-2.5 text-[13.5px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 sm:flex"
            >
              <GitBranch size={14} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{branch.name}</span>
            </button>
          )}

          <div className="relative" ref={pinPop.ref}>
            <button
              type="button"
              onClick={pinPop.toggle}
              aria-expanded={pinPop.open}
              aria-label={`${pinCount} pinned message${pinCount === 1 ? "" : "s"}`}
              title="Pinned messages"
              className={iconButtonClass}
            >
              <Pin size={15} />
              {pinCount > 0 && <span className="text-[13px] tabular-nums">{pinCount > 99 ? "99+" : pinCount}</span>}
            </button>
            {pinPop.open && (
              <div className={`${popoverClass} right-0 w-[min(22rem,calc(100vw-1.5rem))]`}>
                <p className="px-3.5 py-2 text-[13px] font-semibold">Pinned</p>
                <div className="shell-scroll max-h-80 overflow-y-auto">
                  {pinCount === 0 && <p className="px-3.5 pb-3 text-[13px] text-ink-3">Nothing pinned yet. Use ⋯ on a message to pin it.</p>}
                  {(pins ?? []).map((m) => (
                    <div key={m._id} className="group flex items-start gap-2 border-t border-line px-3.5 py-2.5">
                      <button
                        type="button"
                        onClick={() => {
                          pinPop.setOpen(false);
                          onJumpToPin(m);
                        }}
                        className="min-w-0 flex-1 text-left"
                      >
                        <p className="text-[12.5px] text-ink-3">
                          <span className="font-medium text-ink-2">{m.authorType === "agent" ? agentRole(m.agentId) : "You"}</span> · {formatTime(m._creationTime)}
                        </p>
                        <p className="mt-0.5 line-clamp-2 break-words text-[13.5px] text-ink">{m.content}</p>
                      </button>
                      <button type="button" aria-label="Unpin message" title="Unpin" onClick={() => onUnpin(m._id)} className="rounded-md p-1.5 text-ink-3 hover:bg-hover hover:text-ink">
                        <PinOff size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="relative" ref={bellPop.ref}>
            <button
              type="button"
              onClick={bellPop.toggle}
              aria-expanded={bellPop.open}
              aria-label={`Needs you in this project: ${notifications.length}`}
              title="Needs you in this project"
              className={`${iconButtonClass} relative`}
            >
              <Bell size={16} />
              {notifications.length > 0 && <span aria-hidden="true" className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-panel" />}
            </button>
            {bellPop.open && (
              <div className={`${popoverClass} right-0 w-[min(22rem,calc(100vw-1.5rem))]`}>
                <p className="px-3.5 py-2 text-[13px] font-semibold">Needs you in this project</p>
                <div className="shell-scroll max-h-80 overflow-y-auto">
                  {notifications.length === 0 && <p className="px-3.5 pb-3 text-[13px] text-ink-3">Nothing is waiting on you in this project.</p>}
                  {notifications.map((n) => (
                    <div key={n.key} className="border-t border-line px-3.5 py-2.5">
                      <button
                        type="button"
                        disabled={!n.taskId}
                        onClick={() => {
                          if (!n.taskId) return;
                          bellPop.setOpen(false);
                          onOpenTask(n.taskId);
                        }}
                        className="block w-full text-left"
                      >
                        <p className="line-clamp-2 text-[14px] font-medium text-ink">{n.title}</p>
                        <p className="mt-0.5 text-[12.5px] text-ink-3">{n.meta}</p>
                      </button>
                      {n.approvalId && (
                        <div className="mt-2 flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={acting !== null}
                            onClick={() => void act(n.approvalId!, onApprove)}
                            className="h-7 rounded-lg bg-brand px-2.5 text-[12.5px] font-medium text-white hover:bg-brand-hover disabled:opacity-50"
                          >
                            {acting === n.approvalId ? "Working…" : "Approve"}
                          </button>
                          {confirmReject === n.approvalId ? (
                            <>
                              <button
                                type="button"
                                disabled={acting !== null}
                                onClick={() => void act(n.approvalId!, onReject)}
                                className="h-7 rounded-lg bg-red-600 px-2.5 text-[12.5px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
                              >
                                Confirm reject
                              </button>
                              <button type="button" onClick={() => setConfirmReject(null)} className="h-7 rounded-lg px-2 text-[12.5px] text-ink-2 hover:text-ink">
                                Keep
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              disabled={acting !== null}
                              onClick={() => setConfirmReject(n.approvalId!)}
                              className="h-7 rounded-lg border border-line px-2.5 text-[12.5px] text-ink hover:bg-hover disabled:opacity-50"
                            >
                              Reject
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="relative" ref={morePop.ref}>
            <button type="button" onClick={morePop.toggle} aria-expanded={morePop.open} aria-label="More actions" title="More" className={iconButtonClass}>
              <MoreHorizontal size={17} />
            </button>
            {morePop.open && (
              <div role="menu" className={`${popoverClass} right-0 w-52`}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={async () => {
                    const ok = await onCopyLink();
                    setCopied(ok);
                    setTimeout(() => {
                      setCopied(false);
                      morePop.setOpen(false);
                    }, 900);
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[14px] hover:bg-hover"
                >
                  {copied ? <Check size={15} className="text-emerald-500" /> : <Copy size={15} className="text-ink-3" />}
                  {copied ? "Link copied" : "Copy project link"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    morePop.setOpen(false);
                    onManage();
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[14px] hover:bg-hover"
                >
                  <Pencil size={15} className="text-ink-3" /> Manage project
                </button>
                <div className="my-1 h-px bg-line" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    morePop.setOpen(false);
                    onClearChat();
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[14px] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                >
                  <Trash2 size={15} /> Clear chat
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="px-3 pb-2.5 md:hidden">{tabs}</div>
    </header>
  );
}
