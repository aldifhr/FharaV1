
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "@/lib/spaRouter";
import { AnimatePresence, motion } from "framer-motion";
import Sidebar from "@/components/Sidebar";
import TaskThreadPanel from "@/components/TaskThreadPanel";
import { useMutation, useQuery } from "@fhara/runtime/react";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toasts";
import { api } from "@fhara/runtime/api";
import { DESKTOP_QUERY, useMediaQuery } from "@/lib/useMediaQuery";
import { takeRequestedThread } from "@/lib/pendingThread";
import { threadLinkView, type ThreadLink } from "@/lib/threadTree";
import ThreadNotFound from "@/components/shell/ThreadNotFound";
import { SectionLoading, WorkspaceProvider, type Agent, type Task, type SimulatedTaskThread, type WorkspaceContextValue } from "./WorkspaceContext";
import { PANEL_DEFAULT_WIDTH, panelMaxWidthForViewport } from "@/lib/useResizablePanel";
import { InspectorHeader, InspectorSurface } from "@/components/ui/inspector";
import { StatusTag } from "@/components/ui/status-tag";
import InitialAvatar from "@/components/InitialAvatar";
import MessageText from "@/components/chat/MessageText";
import { ChevronLeft, CheckCircle2, Loader2 } from "lucide-react";

function SimulatedTaskThreadPanel({
  thread, projectName, collapsed, panelWidth, panelMaxWidth, fullScreen, onPanelWidthChange, onToggle, onClose,
}: {
  thread: SimulatedTaskThread;
  projectName?: string;
  collapsed: boolean;
  panelWidth: number;
  panelMaxWidth: number;
  fullScreen: boolean;
  onPanelWidthChange: (width: number) => void;
  onToggle: () => void;
  onClose: () => void;
}) {
  const surface = fullScreen ? "sheet" : "docked";
  if (collapsed && !fullScreen) return (
    <aside className="flex h-full w-11 shrink-0 items-start justify-center border-l border-line bg-panel pt-4">
      <button type="button" onClick={onToggle} title="Expand task thread" aria-label="Expand task thread" className="rounded-lg p-1.5 text-ink-3 hover:bg-hover hover:text-ink"><ChevronLeft size={17} /></button>
    </aside>
  );
  return (
    <InspectorSurface variant={surface} width={panelWidth} maxWidth={panelMaxWidth} onWidthChange={onPanelWidthChange} resizeLabel="Resize task thread">
      <InspectorHeader
        title={thread.task.title}
        subtitle={<>Task thread · {projectName ?? "Workspace"} · Simulation</>}
        status={<StatusTag tone={thread.task.status === "done" ? "ok" : "active"}>{thread.task.status === "done" ? "Done" : "In progress"}</StatusTag>}
        onClose={onClose}
        closeLabel="Close task thread"
        actions={!fullScreen ? <button type="button" onClick={onToggle} aria-label="Collapse task thread" className="rounded-field p-1.5 text-ink-3 hover:bg-hover hover:text-ink"><ChevronLeft size={16} /></button> : undefined}
      />
      <div className="border-b border-line bg-hover/50 px-5 py-2 text-[12px] text-ink-3">Scripted preview only. No LLM calls, backend task, or repository changes.</div>
      <div className="shell-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {thread.subtasks.map((subtask: any) => (
          <div key={subtask._id} className="flex items-center gap-2 text-[13px] text-ink-2">
            {subtask.status === "completed" ? <CheckCircle2 size={15} className="text-ok" /> : subtask.status === "running" ? <Loader2 size={15} className="animate-spin text-ink-2" /> : <span className="h-3.5 w-3.5 rounded-full border border-line-strong" />}
            <span className="flex-1">{subtask.title}</span><span className="text-[12px] text-ink-3">{subtask.status}</span>
          </div>
        ))}
        <div className="border-t border-line pt-5" />
        {thread.messages.map((message: any) => (
          <div key={message._id} className={`flex gap-3 ${message.authorType === "user" ? "justify-end" : ""}`}>
            {message.authorType !== "user" && <InitialAvatar name={message.role ?? "Team"} size={30} agent />}
            <div className={`min-w-0 max-w-[90%] ${message.authorType === "user" ? "rounded-xl bg-hover px-3.5 py-2.5" : "flex-1"}`}>
              <p className="mb-1 text-[13px] font-semibold text-ink">{message.authorType === "user" ? "You" : message.role}</p>
              <MessageText content={message.content} size="sm" />
            </div>
          </div>
        ))}
        {thread.task.status === "done" && <p className="text-center text-[12px] text-ink-3">Simulation finished</p>}
      </div>
    </InspectorSurface>
  );
}

function WorkspaceShell({
  projectId,
  threadId,
  children,
}: {
  projectId: string;
  /** Deep-linked thread (`/project/:projectId/:threadId`); opens once the task list is known. */
  threadId?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // `?task=` survives from older links; thread links otherwise hand the
  // thread over in app state (see `lib/pendingThread.ts`).
  const taskParam = searchParams.get("task");
  const isDesktop = useMediaQuery(DESKTOP_QUERY, true);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const panelMaxWidth = panelMaxWidthForViewport(viewportWidth);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [simulatedThread, setSimulatedThread] = useState<SimulatedTaskThread | null>(null);
  const [threadCollapsed, setThreadCollapsed] = useState(false);
  const [panelWidth, setPanelWidth] = useState(() => Math.min(PANEL_DEFAULT_WIDTH, panelMaxWidth));
  const [highlightAgentId, setHighlightAgentId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const userClosedRef = useRef(false);
  const openSimulatedThread = useCallback((thread: SimulatedTaskThread) => {
    userClosedRef.current = false;
    setSimulatedThread(thread);
    setSelectedTaskId(thread.task._id);
    setThreadCollapsed(false);
  }, []);
  const updateSimulatedThread = useCallback((thread: SimulatedTaskThread) => {
    setSimulatedThread((current) => current?.task._id === thread.task._id ? thread : current);
  }, []);
  /** The deep link (`project:thread`) whose selection was applied; see the deep-link effect. */
  const appliedLinkRef = useRef<string | null>(null);
  /** Thread handed over by the link that opened this project (see `lib/pendingThread.ts`). */
  const requestedThread = useRef<{ projectId: string; taskId: string | null } | null>(null);

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  useEffect(() => {
    setPanelWidth((width) => Math.min(width, panelMaxWidth));
  }, [panelMaxWidth]);

  const openAgent = (agentId: string) => {
    setHighlightAgentId(agentId);
  };
  // `projects.get` returns null for a deleted project or a malformed id.
  const project = useQuery(api.projects.get, { projectId });
  // A deep link (`/project/:projectId/:threadId`) opens the thread as the main
  // view, not the project chat.
  const deepLinked = Boolean(threadId && selectedTaskId === threadId);
  const tasks = useQuery(
    api.tasks.listByProject,
    project ? { projectId: project._id } : "skip",
  );
  // What the deep link's id names in this project: a task, a conversation, or nothing.
  const link = useQuery(api.threads.resolveLink, project && threadId ? { projectId: project._id, threadId } : "skip") as
    | ThreadLink
    | undefined;
  const linkView = threadId ? threadLinkView(projectId, project === null ? null : link) : null;
  const allAgents = useQuery(api.agents.list, {});
  const projectAgentIds = project?.agentIds;
  const agents = projectAgentIds
    ? allAgents?.filter((agent) => projectAgentIds.includes(agent._id))
    : allAgents;

  useEffect(() => {
    if (project === null) router.replace("/chats");
  }, [project, router]);

  const removeTask = useMutation(api.tasks.remove);
  const toast = useToast();
  const [confirmReq, setConfirmReq] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);

  const deleteTask = (task: Task) => {
    setConfirmReq({
      title: `Delete task "${task.title}"?`,
      message: "This task and all of its history will be deleted permanently.",
      confirmLabel: "Delete task",
      onOk: () => { void confirmDeleteTask(task); },
    });
  };

  const confirmDeleteTask = async (task: Task) => {
    setConfirmPending(true);
    try {
      await removeTask({ taskId: task._id as never });
      setSelectedTaskId((current) => (current === task._id ? null : current));
      toast("success", "Task deleted", task.title);
      setConfirmReq(null);
    } catch (err) {
      toast("error", "Failed to delete task", err instanceof Error ? err.message : "Failed to delete task");
    } finally {
      setConfirmPending(false);
    }
  };

  // Project switch resets the thread; a `?task=` link (old bookmarks, Needs
  // you) or a thread handed over by `requestThread` opens that task's thread.
  // Parents' effects run after children's, so the reset and the deep link
  // live in the same effect.
  useEffect(() => {
    // Taken once per project; the ref makes a StrictMode replay of this
    // effect open the same thread instead of clearing it.
    const requested =
      requestedThread.current?.projectId === projectId
        ? requestedThread.current.taskId
        : takeRequestedThread(projectId);
    requestedThread.current = { projectId, taskId: requested };
    setSelectedTaskId(taskParam ?? requested);
    setSimulatedThread(null);
    setThreadCollapsed(false);
    setSidebarOpen(false);
    userClosedRef.current = false;
  }, [projectId, taskParam]);

  // Deep link (`/project/:projectId/:threadId`): a task id opens its thread
  // once the link is resolved. Applied once per thread id: a later task-list
  // or link refresh must not re-open a thread the user closed or replace one
  // they opened since. A conversation id shows that conversation (ChatSection);
  // an unknown or foreign id shows "Thread not found".
  useEffect(() => {
    if (!threadId || linkView === null || linkView === "loading") return;
    const key = `${projectId}:${threadId}`;
    if (appliedLinkRef.current === key) return;
    appliedLinkRef.current = key;
    if (linkView !== "task") return;
    setThreadCollapsed(false);
    setSelectedTaskId(threadId);
  }, [projectId, threadId, linkView]);

  const closeThread = () => {
    userClosedRef.current = true;
    setSelectedTaskId(null);
    setSimulatedThread(null);
    // A deep-linked thread is the main view: closing it returns to the project chat.
    if (deepLinked) router.replace(`/project/${projectId}`);
  };

  const value: WorkspaceContextValue = {
    projectId,
    agents: agents as Agent[] | undefined,
    tasks: tasks as Task[] | undefined,
    selectedTaskId,
    threadCollapsed,
    highlightAgentId,
    selectTask: (taskId: string) => { userClosedRef.current = false; setSelectedTaskId(taskId); setThreadCollapsed(false); },
    simulatedThread,
    openSimulatedThread,
    updateSimulatedThread,
    toggleThread: () => setThreadCollapsed((collapsed) => !collapsed),
    closeThread,
    openAgent,
    deleteTask,
    openSidebar: () => setSidebarOpen(true),
    linkedConversationId: linkView === "conversation" && threadId ? threadId : null,
    linkedConversationClosed: linkView === "conversation" && link?.status !== "active",
  };

  const thread = selectedTaskId ? simulatedThread?.task._id === selectedTaskId ? (
    <SimulatedTaskThreadPanel
      key={selectedTaskId}
      thread={simulatedThread}
      projectName={(project as any)?.name}
      collapsed={isDesktop && threadCollapsed}
      panelWidth={panelWidth}
      panelMaxWidth={panelMaxWidth}
      fullScreen={!isDesktop || deepLinked}
      onPanelWidthChange={setPanelWidth}
      onToggle={() => setThreadCollapsed((collapsed) => !collapsed)}
      onClose={closeThread}
    />
  ) : (
    <TaskThreadPanel
      key={selectedTaskId}
      taskId={selectedTaskId}
      collapsed={isDesktop && threadCollapsed}
      panelWidth={panelWidth}
      panelMaxWidth={panelMaxWidth}
      fullScreen={!isDesktop || deepLinked}
      onPanelWidthChange={setPanelWidth}
      onToggle={() => setThreadCollapsed((collapsed) => !collapsed)}
      onClose={closeThread}
    />
  ) : null;

  return (
    <WorkspaceProvider value={value}>
      <div className="h-dvh overflow-hidden bg-panel text-ink">
        <div className="flex h-full min-h-0 overflow-hidden">
        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden max-[979px]:flex-col">
          <ConfirmDialog
            request={confirmReq}
            pending={confirmPending}
            onCancel={() => setConfirmReq(null)}
            onConfirm={() => confirmReq?.onOk()}
          />
          <Sidebar
            projectId={projectId}
            drawerOpen={sidebarOpen}
            onCloseDrawer={() => setSidebarOpen(false)}
            onSelectProject={() => setSidebarOpen(false)}
          />
          {linkView === "not_found" ? (
            <ThreadNotFound projectId={projectId} />
          ) : deepLinked && isDesktop ? (
            // A deep-linked thread replaces the project chat as the main view.
            // Phones keep the chat and show the thread as a full-screen sheet.
            <main className="min-h-0 min-w-0 flex-1 overflow-hidden bg-dots">
              {thread}
            </main>
          ) : project ? (
            children
          ) : (
            // Child queries assert project access and would throw for a
            // deleted project; render them only once it is known to exist.
            <main className="min-h-0 min-w-0 flex-1 bg-dots px-5 py-6" aria-busy="true">
              <SectionLoading />
            </main>
          )}
          {isDesktop ? (
            !deepLinked && project && (
              <motion.div
                animate={{ width: selectedTaskId ? (threadCollapsed ? 44 : panelWidth) : 0 }}
                transition={{ duration: 0.24, ease: [0.32, 0.72, 0, 1] }}
                className="h-full min-h-0 shrink-0 overflow-hidden"
              >
                <AnimatePresence initial={false}>{thread}</AnimatePresence>
              </motion.div>
            )
          ) : (
            <AnimatePresence>
              {selectedTaskId && project && (
                <motion.div
                  key="thread-sheet"
                  initial={{ opacity: 0, y: 24 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 24 }}
                  transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
                  className="fixed inset-0 z-40 flex flex-col bg-panel"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Task thread"
                >
                  {thread}
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </div>
        </div>
      </div>
    </WorkspaceProvider>
  );
}

export default WorkspaceShell;
