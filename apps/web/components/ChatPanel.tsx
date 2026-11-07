"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion } from "framer-motion";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import Link from "next/link";
import AgentAvatar from "./AgentAvatar";
import { AnimatedTooltip } from "@/components/ui/animated-tooltip";
import { avatartionFor, deserializeAvatartion } from "./ui/avatartion";
import DiffCard from "./DiffCard";
import Modal from "./Modal";
import TaskBoard from "./TaskBoard";
import TerminalPanel from "./TerminalPanel";

import { useToast } from "./Toasts";
import { Bell, Check, Copy, MoreHorizontal, Pencil, Send } from "lucide-react";

type Props = {
  projectId: string;
  tab: "chat" | "tasks";
  setTab: (t: "chat" | "tasks") => void;
  onSelectTask: (taskId: string) => void;
  onOpenAgent?: (agentId: string) => void;
  selectedTaskId: string | null;
};

// ponytail: auto-mode intent classification can be added via LLM when explicit modes feel too rigid

function MessageText({ content }: { content: string }) {
  return (
    <div className="mt-1 max-w-3xl space-y-2 text-[13px] leading-5 text-[#4c4a55] dark:text-gray-200">
      <div className="markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </div>
  );
}

export default function ChatPanel({ projectId, tab, setTab, onSelectTask, onOpenAgent, selectedTaskId }: Props) {
  const project = useQuery(api.projects.get, { projectId: projectId as any });
  const messages = useQuery(api.messages.listByProject, { projectId: projectId as any });
  const tasks = useQuery(api.tasks.listByProject, { projectId: projectId as any });
  const approvals = useQuery(api.approvals.listPendingAll, {});
  const approve = useMutation(api.approvals.approve);
  const reject = useMutation(api.approvals.reject);
  const allAgents = useQuery(api.agents.list, {});
  const updateProject = useMutation(api.projects.update);
  const updateTeam = useMutation(api.projects.updateTeam);
  const updateApprovalMode = useMutation(api.projects.updateApprovalMode);
  const [isManageOpen, setIsManageOpen] = useState(false);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const projectAgentIds = project?.agentIds;
  const agents = (projectAgentIds
    ? (allAgents ?? []).filter((agent: any) => (projectAgentIds as readonly string[]).includes(agent._id))
    : (allAgents ?? [])) as any[];
  const pendingForProject = (approvals ?? []).filter((a: any) => a.projectId === projectId).length;
  const pendingItems = (approvals ?? []).filter((a: any) => a.projectId === projectId);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [moreOpen]);

  useEffect(() => {
    if (!notifOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(event.target as Node)) {
        setNotifOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [notifOpen]);

  const copyProjectLink = async () => {
    const url = `${window.location.origin}/chats/${projectId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
    setMoreOpen(false);
  };

  const selectedTask = (tasks ?? []).find((task) => task._id === selectedTaskId);
  const fileChangesByTask = useQuery(api.fileChanges.listByTask, selectedTask ? { taskId: selectedTask._id } : "skip");
  const taskEvents = useQuery(api.taskEvents.listByTask, selectedTask ? { taskId: selectedTask._id } : "skip");
  const projectFiles = useQuery(api.fileChanges.listByProject, { projectId: projectId as any });
  const activeByAgent = useQuery(api.executionView.activeByAgent, {});
  const selectedTaskMessages = selectedTask
    ? (messages ?? []).filter((message: any) => message.taskId === selectedTask._id)
    : [];
  // One chronological timeline: every project message, with task agent
  // reports inline. Task user copies (same content as the conversation
  // message) are skipped to avoid duplicates.
  const timeline = (messages ?? [])
    .filter((message: any) => !message.taskId || message.authorType === "agent")
    .sort((a: any, b: any) => a._creationTime - b._creationTime);
  const lastMessage = timeline[timeline.length - 1];
  const conversationTyping = lastMessage?.authorType === "user";
  const latestAgentMessage = [...selectedTaskMessages].reverse().find((message: any) => message.authorType === "agent");
  const taskTitle = (taskId: string) => (tasks ?? []).find((task) => task._id === taskId)?.title ?? "task";
  // A task block starts at the user message that spawned it. The plan message
  // replies to that user message, so the link is recoverable from
  // replyToMessageId. Older plan messages predate taskId tagging, so the task
  // id is parsed from their content as a fallback.
  const taskFromPlan = (content: string) => content.match(/^Plan dibuat\. Task (\S+)/)?.[1];
  const replyToTask = new Map<string, string>();
  for (const m of messages ?? []) {
    const taskId = m.taskId ?? taskFromPlan(m.content ?? "");
    if (m.replyToMessageId && taskId) replyToTask.set(m.replyToMessageId, taskId);
  }
  // ponytail: evaluation and planning messages are summaries, not execution
  // output. Detect by content prefix so the UI can show a badge.
  const messageKind = (content: string): "evaluation" | "planning" | null =>
    /^Task (completed|finished)/.test(content) ? "evaluation" :
    /^Plan dibuat/.test(content) ? "planning" : null;
  const blockKey = (m: any) => m.taskId ?? replyToTask.get(m._id) ?? taskFromPlan(m.content ?? "") ?? "conversation";

  const [manageName, setManageName] = useState("");
  const [managePath, setManagePath] = useState("");
  const [manageApprovalMode, setManageApprovalMode] = useState<"ask" | "auto">("ask");
  const [manageAgentIds, setManageAgentIds] = useState<string[]>([]);
  const [manageQaUrl, setManageQaUrl] = useState("");
  const [manageDevUrl, setManageDevUrl] = useState("");
  const [manageError, setManageError] = useState("");
  const [savingManage, setSavingManage] = useState(false);

  function openManageProject() {
    if (!project) return;
    setMoreOpen(false);
    setManageError("");
    setManageName((project as any).name ?? "");
    setManagePath((project as any).workspacePath ?? "");
    setManageApprovalMode((project as any).approvalMode ?? "ask");
    setManageAgentIds(((project as any).agentIds ?? []) as string[]);
    setManageQaUrl((project as any).qaUrl ?? "");
    setManageDevUrl((project as any).devUrl ?? "");
    setIsManageOpen(true);
  }

  async function handleSaveProject(event: React.FormEvent) {
    event.preventDefault();
    if (!project) return;
    if (!manageName.trim()) {
      setManageError("Name is required");
      return;
    }
    setManageError("");
    setSavingManage(true);
    try {
      await updateProject({
        projectId: projectId as never,
        name: manageName,
        workspacePath: managePath,
        ...(manageQaUrl.trim() ? { qaUrl: manageQaUrl.trim() } : {}),
        ...(manageDevUrl.trim() ? { devUrl: manageDevUrl.trim() } : {}),
        approvalMode: manageApprovalMode,
      });
      await updateTeam({ projectId: projectId as never, agentIds: manageAgentIds as never[] });
      setIsManageOpen(false);
      toast("success", "Project updated");
    } catch (err) {
      setManageError(err instanceof Error ? err.message : "Failed to update project");
    } finally {
      setSavingManage(false);
    }
  }

  const toast = useToast();

  const sendMessage = useAction(api.messages.send);
  const [chatCommand, setChatCommand] = useState("");
  const [chatAgentIds, setChatAgentIds] = useState<string[]>([]);
  const [chatError, setChatError] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [mention, setMention] = useState<string | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);

  useEffect(() => {
    const workspacePath = (project as any)?.workspacePath;
    if (!workspacePath) {
      setWorkspaceFiles([]);
      return;
    }
    let cancelled = false;
    void fetch(`/api/project-files?workspacePath=${encodeURIComponent(workspacePath)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to list project files");
        return (await response.json()) as { files?: string[] };
      })
      .then((data) => {
        if (!cancelled) setWorkspaceFiles(data.files ?? []);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [(project as any)?.workspacePath]);

  const mentionResults = useMemo(() => {
    if (mention === null) return [];
    const q = mention.toLowerCase();
    const changedFiles = (projectFiles ?? []).map((f: any) => f.filePath as string);
    return [...new Set([...workspaceFiles, ...changedFiles])]
      .filter((p) => p.toLowerCase().includes(q))
      .slice(0, 30);
  }, [mention, projectFiles, workspaceFiles]);

  const attachMentionedFiles = async (text: string) => {
    const paths = [...new Set(
      [...text.matchAll(/@([\w./-]+\.[\w]{1,12})/g)].map((match) => match[1]),
    )];
    if (paths.length === 0 || !(project as any)?.workspacePath) return text;
    const contents = await Promise.all(paths.map(async (filePath) => {
      const params = new URLSearchParams({
        workspacePath: (project as any).workspacePath,
        filePath,
      });
      const response = await fetch(`/api/project-files?${params}`);
      if (!response.ok) return "";
      const data = (await response.json()) as { content?: string };
      return data.content ? `\n\n--- File: ${filePath} ---\n${data.content}` : "";
    }));
    return `${text}${contents.join("")}`.slice(0, 8000);
  };

  const submitChat = async () => {
    const text = chatCommand.trim();
    if (!text) return;
    setChatError("");
    setChatSending(true);
    try {
      const content = await attachMentionedFiles(text);
      await sendMessage({
        projectId: projectId as any,
        content,
        preferredAgentIds: chatAgentIds.length ? (chatAgentIds as any) : undefined,
      });
      setChatCommand("");
      setMention(null);
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setChatSending(false);
    }
  };

  const handleChatInput = (value: string) => {
    setChatCommand(value);
    const at = value.lastIndexOf("@");
    const afterSpace = at >= 0 && (at === 0 || /\s/.test(value[at - 1]));
    const token = afterSpace ? value.slice(at + 1) : null;
    setMention(token !== null && !/\s/.test(token) ? token : null);
  };

  const insertMention = (path: string) => {
    const at = chatCommand.lastIndexOf("@");
    const before = chatCommand.slice(0, at);
    setChatCommand(`${before}@${path} `);
    setMention(null);
  };

  const headerAgents = agents.slice(0, 6);
  const activeForSelectedTask = useMemo(() => {
    if (!selectedTask) return [];
    return (agents as any[]).filter((a: any) => {
      const active = (activeByAgent as any)?.[a._id];
      return active && active.taskId === selectedTask._id;
    }).map((a: any) => ({
      agent: a,
      stage: (activeByAgent as any)[a._id]?.status ?? "running",
      subtaskKey: (activeByAgent as any)[a._id]?.subtaskKey,
    }));
  }, [agents, activeByAgent, selectedTask]);
  const workingAgents = agents.filter((agent: any) => agent.status === "working");
  const taskErrors = (taskEvents ?? []).filter((event: any) => event.type === "task.error");
  const diffStats = (fileChangesByTask ?? []).reduce(
    (stats, fileChange: any) => {
      for (const line of fileChange.diff.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) continue;
        if (line.startsWith("+")) stats.added += 1;
        if (line.startsWith("-")) stats.removed += 1;
      }
      return stats;
    },
    { added: 0, removed: 0 }
  );
  const formatMessageTime = (createdAt: number) => {
    const elapsedMinutes = Math.max(0, Math.floor((Date.now() - createdAt) / 60000));
    if (elapsedMinutes < 1) return "just now";
    if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) return `${elapsedHours}h ago`;
    return `${Math.floor(elapsedHours / 24)}d ago`;
  };

  return (
    <main className="relative flex min-w-0 flex-1 flex-col bg-transparent">
      <header className="flex items-center gap-3 border-b border-[#ebe9f0] px-5 py-3 dark:border-gray-800">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#e6f4ed] text-sm font-bold text-[#3d9b67]">
          {(project as any)?.name?.slice(0, 2).toUpperCase() ?? "AW"}
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{(project as any)?.name ?? "Agent Workspace"}</h1>
          <div className="flex items-center gap-2">
            <div className="relative flex items-center pl-1" aria-label={`${agents.length} agents`}>
              <div
                className="flex items-center"
                onMouseLeave={() => setActiveAgentId(null)}
              >
                {headerAgents.map((a: any) => (
                  <button
                    key={a._id}
                    type="button"
                    onClick={() => onOpenAgent?.(a._id)}
                    aria-label={a.name}
                    className={`-ml-1.5 rounded-full p-0 first:ml-0 ${
                      activeAgentId && activeAgentId !== a._id
                        ? "opacity-40"
                        : "opacity-100 transition hover:opacity-70"
                    }`}
                    onMouseEnter={() => setActiveAgentId(a._id)}
                  >
                    <AgentAvatar name={a.name} size={20} status={a.status} avatarParams={a.avatarParams} />
                  </button>
                ))}
              </div>
              {activeAgentId && (
                <span className="pointer-events-none absolute left-0 top-full z-30 mt-2">
                  <AnimatedTooltip
                    items={(() => {
                      const a = agents.find((x: any) => x._id === activeAgentId);
                      return a
                        ? [{
                            id: a._id,
                            name: a.name,
                            designation: `${a.role} · ${a.status}`,
                            avatar: (a.avatarParams ? deserializeAvatartion(a.avatarParams) : null) ?? avatartionFor(a.name),
                            size: 20,
                          }]
                        : [];
                    })()}
                  />
                </span>
              )}
              {agents.length > headerAgents.length && (
                <button
                  type="button"
                  onClick={() => onOpenAgent?.(agents[headerAgents.length]._id)}
                  title={`+${agents.length - headerAgents.length} more — open agents`}
                  aria-label={`Open ${agents.length - headerAgents.length} more agents`}
                  className="-ml-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-[10px] font-semibold text-gray-600 ring-1 ring-white transition hover:bg-gray-200"
                >
                  +{agents.length - headerAgents.length}
                </button>
              )}
            </div>
            <span className="text-xs text-gray-500">{agents.length} {agents.length === 1 ? "agent" : "agents"}</span>
            <button
              type="button"
              onClick={() => setIsTerminalOpen(true)}
              className="ml-2 flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              title="Open terminal"
            >
              ▸ Terminal
            </button>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <div className="relative" ref={notifRef}>
            <button
              type="button"
              onClick={() => setNotifOpen((open) => !open)}
              title={`Notifications — ${pendingForProject} pending approval${pendingForProject === 1 ? "" : "s"}`}
              aria-label={`Notifications — ${pendingForProject} pending approval${pendingForProject === 1 ? "" : "s"}`}
              aria-expanded={notifOpen}
              className="relative rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            >
              <Bell size={15} />
              {pendingForProject > 0 && (
                <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
                  {pendingForProject > 9 ? "9+" : pendingForProject}
                </span>
              )}
            </button>
            {notifOpen && (
              <div className="absolute right-0 z-40 mt-2 w-72 overflow-hidden rounded-xl border border-[#ebe9f0] bg-white py-1 text-sm shadow-xl dark:border-gray-800 dark:bg-gray-900">
                <p className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  Notifications ({pendingForProject})
                </p>
                <div className="max-h-64 overflow-y-auto">
                  {pendingItems.length === 0 && (
                    <p className="px-3 py-3 text-sm text-gray-400">Nothing is waiting for approval.</p>
                  )}
                  {pendingItems.map((a: any) => (
                    <div key={a._id} className="border-t border-gray-100 px-3 py-2 dark:border-gray-800">
                      <p className="truncate text-sm font-medium">{a.summary}</p>
                      <p className="mt-0.5 text-xs text-gray-500">{a.kind}</p>
                      <div className="mt-1.5 flex gap-2">
                        <button
                          type="button"
                          onClick={() => approve({ approvalId: a._id })}
                          className="rounded-lg bg-emerald-600 px-2 py-1 text-xs font-semibold text-white"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => reject({ approvalId: a._id })}
                          className="rounded-lg bg-gray-200 px-2 py-1 text-xs font-semibold dark:bg-gray-700 dark:text-white"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="relative" ref={moreRef}>
            <button
              type="button"
              onClick={() => setMoreOpen((open) => !open)}
              title="More actions"
              aria-label="More actions"
              aria-expanded={moreOpen}
              className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            >
              <MoreHorizontal size={17} />
            </button>
            {moreOpen && (
              <div className="absolute right-0 z-40 mt-2 w-48 overflow-hidden rounded-xl border border-[#ebe9f0] bg-white py-1 text-sm shadow-xl dark:border-gray-800 dark:bg-gray-900">
                <button
                  type="button"
                  onClick={copyProjectLink}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  {copied ? <Check size={15} className="text-emerald-500" /> : <Copy size={15} />}
                  {copied ? "Link copied" : "Copy project link"}
                </button>
                <button
                  type="button"
                  onClick={openManageProject}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <Pencil size={15} />
                  Manage project
                </button>
                <Link
                  href="/activities"
                  onClick={() => setMoreOpen(false)}
                  className="flex w-full items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <Bell size={15} />
                  View activity
                </Link>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="flex gap-2 border-b border-[#ebe9f0] px-5 dark:border-gray-800">
        {(["chat", "tasks"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`border-b-2 px-3 py-2 text-[13px] capitalize ${tab === t ? "border-[#6252d8] font-semibold text-[#5147b4]" : "border-transparent text-gray-500"}`}>
            {t}{t === "tasks" && tasks?.length ? ` ${tasks.length}` : ""}
          </button>
        ))}
      </div>

      <div ref={scrollRef} onScroll={() => { const el = scrollRef.current; if (el) setShowScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 120); }} className="flex-1 space-y-5 overflow-y-auto bg-transparent p-5">
        {taskErrors.map((event: any, index: number) => (
          <div key={`task-error-${index}`} className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <span className="font-semibold">Agent error:</span> {event.payload?.message ?? "Task failed to process."}
          </div>
        ))}
        {tab === "chat" ? (
          <>
            {timeline.map((m: any, index: number) => {
              const previous = timeline[index - 1];
              const key = blockKey(m);
              const prevKey = previous ? blockKey(previous) : null;
              // Divider marks the start of a task block (at the user's message
              // that spawned it), not a transition back to plain conversation.
              const boundary = key !== prevKey && key !== "conversation";
              return (
                <div key={m._id}>
                  {boundary && (
                    <p className="my-5 text-center text-[11px] text-gray-400">
                      — {taskTitle(key)} —
                    </p>
                  )}
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.18) }}
                    className="flex gap-3"
                  >
                    {m.authorType === "agent" ? (
                      <AgentAvatar
                        name={(agents as any)?.find((a: any) => a._id === m.agentId)?.name ?? "Agent"}
                        size={32}
                        avatarParams={(agents as any)?.find((a: any) => a._id === m.agentId)?.avatarParams}
                      />
                    ) : (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#eceaf3] text-[11px] font-bold text-[#5147b4] dark:bg-white/15 dark:text-white">
                        You
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <p className="text-[13px] font-semibold text-[#34323d] dark:text-gray-100">
                          {m.authorType === "agent"
                            ? (agents as any)?.find((a: any) => a._id === m.agentId)?.name ?? "Agent"
                            : "You"}
                          {(() => {
                            const kind = messageKind(m.content);
                            if (kind === "evaluation") return (
                              <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
                                <svg className="animate-[spin_2.5s_linear_infinite]" xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <circle cx="12" cy="12" r="10" />
                                  <path d="m16 9-5.5 5.5L8 12" />
                                </svg>
                                evaluated
                              </span>
                            );
                            if (kind === "planning") return <span className="ml-1.5 rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700 dark:bg-purple-900 dark:text-purple-300">planned</span>;
                            return null;
                          })()}
                        </p>
                        <span className="text-[11px] text-gray-400">{formatMessageTime(m._creationTime)}</span>
                      </div>
                      <MessageText content={m.content} />
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
                                applied={Boolean(fc.appliedAt)}
                                approvalId={pendingApproval?._id as string}
                                busy={false}
                                onApprove={(id) => approve({ approvalId: id as any })}
                                onReject={(id) => reject({ approvalId: id as any })}
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
            {conversationTyping && (
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <span>Team is thinking</span>
                <span className="flex gap-0.5" aria-label="Agent is typing">
                  <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" />
                  <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:120ms]" />
                  <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:240ms]" />
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
                      <AgentAvatar name={agent.name} size={18} status="working" avatarParams={agent.avatarParams} />
                      <span className="font-medium">{agent.name}</span>
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
                  <span>{workingAgents.map((agent: any) => agent.name).join(", ")} is thinking</span>
                  <span className="flex gap-0.5" aria-label="Agent is thinking">
                    <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" />
                    <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:120ms]" />
                    <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:240ms]" />
                  </span>
                </div>
              )
            )}
          </>
        ) : (
          <motion.div key="tasks" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }}>
            <TaskBoard projectId={projectId} selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} />
          </motion.div>
        )}
      </div>

      {showScrollDown && (
        <button
          type="button"
          onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })}
          aria-label="Scroll to bottom"
          className="absolute bottom-24 left-1/2 z-20 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full bg-white shadow-lg ring-1 ring-gray-200 hover:bg-gray-50 dark:bg-gray-800 dark:ring-gray-700"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>
      )}


      {isTerminalOpen && (
        <Modal title={`Terminal · ${project?.name ?? ""}`} onClose={() => setIsTerminalOpen(false)} maxWidth="max-w-3xl">
          <div className="h-[420px] pt-4">
            <TerminalPanel workspacePath={project?.workspacePath ?? ""} />
          </div>
        </Modal>
      )}

      {isManageOpen && (
        <Modal title={`Manage project · ${manageName}`} onClose={() => setIsManageOpen(false)} maxWidth="max-w-lg">
          <form onSubmit={handleSaveProject} className="mt-4 grid gap-3">
            <label className="grid gap-1 text-sm">
              Project name
              <input
                value={manageName}
                onChange={(event) => setManageName(event.target.value)}
                required
                className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
              />
            </label>
            <label className="grid gap-1 text-sm">
              Folder path
              <input
                value={managePath}
                onChange={(event) => setManagePath(event.target.value)}
                required
                className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
              />
            </label>
            <label className="grid gap-1 text-sm">
              Approval mode
              <select
                value={manageApprovalMode}
                onChange={(event) => setManageApprovalMode(event.target.value as "ask" | "auto")}
                className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
              >
                <option value="ask">Ask before changes</option>
                <option value="auto">Auto-approve</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              QA base URL <span className="text-xs text-gray-400">(opsional)</span>
              <input
                value={manageQaUrl}
                onChange={(event) => setManageQaUrl(event.target.value)}
                placeholder="http://localhost:3000"
                className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
              />
            </label>
            <label className="grid gap-1 text-sm">
              Dev base URL <span className="text-xs text-gray-400">(opsional)</span>
              <input
                value={manageDevUrl}
                onChange={(event) => setManageDevUrl(event.target.value)}
                placeholder="http://localhost:3000"
                className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
              />
            </label>
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Team project</legend>
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-2 dark:border-gray-700">
                {(allAgents ?? []).length === 0 && <p className="text-xs text-gray-400">Belum ada agent. Buat agent dulu dari halaman Teams.</p>}
                {(allAgents ?? []).map((agent: any) => (
                  <label key={agent._id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={manageAgentIds.includes(agent._id)}
                      onChange={(event) =>
                        setManageAgentIds((current) =>
                          event.target.checked
                            ? [...current, agent._id]
                            : current.filter((id) => id !== agent._id)
                        )
                      }
                    />
                    <span>{agent.name}</span>
                    <span className="text-xs text-gray-400">{agent.role}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {manageError && <p className="text-sm text-red-600">{manageError}</p>}
            <button
              type="submit"
              disabled={savingManage}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-gray-900"
            >
              {savingManage ? "Saving…" : "Save project"}
            </button>
          </form>
        </Modal>
      )}
      {tab === "chat" && (
        <div className="border-t border-[#ebe9f0] bg-white/70 p-3 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-950/70">
          {agents.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {agents.map((a: any) => {
                const selected = chatAgentIds.includes(a._id);
                return (
                  <button
                    key={a._id}
                    type="button"
                    onClick={() =>
                      setChatAgentIds((current) =>
                        selected ? current.filter((id) => id !== a._id) : [...current, a._id],
                      )
                    }
                    title={selected ? `Remove ${a.name}` : `Assign ${a.name}`}
                    className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium transition ${
                      selected
                        ? "border-[#6252d8] bg-[#6252d8]/10 text-[#4d3fbe] dark:text-[#b9b2ff]"
                        : "border-[#e5e3eb] text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                    }`}
                  >
                    <AgentAvatar name={a.name} size={16} status={a.status} avatarParams={a.avatarParams} />
                    {a.name}
                  </button>
                );
              })}
              {chatAgentIds.length === 0 && (
                <span className="self-center text-[11px] text-gray-400">Auto-assign</span>
              )}
            </div>
          )}
          <div className="relative flex gap-2">
            {mention !== null && mentionResults.length > 0 && (
              <ul className="absolute bottom-full left-0 z-30 mb-2 max-h-52 w-full overflow-y-auto rounded-xl border border-[#e5e3eb] bg-white py-1 shadow-xl dark:border-gray-700 dark:bg-gray-900">
                {mentionResults.map((path) => (
                  <li key={path}>
                    <button
                      type="button"
                      onClick={() => insertMention(path)}
                      className="block w-full truncate px-3 py-1.5 text-left font-mono text-xs hover:bg-gray-50 dark:hover:bg-gray-800"
                    >
                      @{path}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <input
              value={chatCommand}
              onChange={(e) => handleChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (mention !== null && mentionResults.length > 0) {
                    insertMention(mentionResults[0]);
                    return;
                  }
                  void submitChat();
                }
              }}
              placeholder="Ask the team anything… use @ to reference a file"
              className="flex-1 rounded-xl border border-[#e5e3eb] bg-[#fbfbfd] px-3 py-2.5 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-[#a29ae8] focus:ring-2 focus:ring-[#e5e1ff] dark:border-gray-700 dark:bg-gray-800 dark:text-white dark:placeholder:text-gray-400 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
            />
            <button
              onClick={() => void submitChat()}
              disabled={chatSending || !chatCommand.trim()}
              className="flex items-center gap-1 rounded-xl bg-[#6252d8] px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#5345c2] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send size={16} /> {chatSending ? "Sending…" : "Send"}
            </button>
          </div>
          {chatError && <p className="mt-2 text-xs text-red-600">{chatError}</p>}
        </div>
      )}

    </main>
  );
}
