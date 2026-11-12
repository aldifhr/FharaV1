"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import Sidebar from "@/components/Sidebar";
import TaskThreadPanel from "@/components/TaskThreadPanel";
import { useMutation, useQuery } from "convex/react";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toasts";
import { api } from "@/api/convex/_generated/api";
import { DESKTOP_QUERY, useMediaQuery } from "@/lib/useMediaQuery";
import { takeRequestedThread } from "@/lib/pendingThread";
import { threadLinkView, type ThreadLink } from "@/lib/threadTree";
import ThreadNotFound from "@/components/shell/ThreadNotFound";
import { SectionLoading, WorkspaceProvider, type Agent, type Task, type WorkspaceContextValue } from "./WorkspaceContext";

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
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [threadCollapsed, setThreadCollapsed] = useState(false);
  const [panelWidth, setPanelWidth] = useState(390);
  const [highlightAgentId, setHighlightAgentId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const userClosedRef = useRef(false);
  /** The deep link (`project:thread`) whose selection was applied; see the deep-link effect. */
  const appliedLinkRef = useRef<string | null>(null);
  /** Thread handed over by the link that opened this project (see `lib/pendingThread.ts`). */
  const requestedThread = useRef<{ projectId: string; taskId: string | null } | null>(null);

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
    toggleThread: () => setThreadCollapsed((collapsed) => !collapsed),
    closeThread,
    openAgent,
    deleteTask,
    openSidebar: () => setSidebarOpen(true),
    linkedConversationId: linkView === "conversation" && threadId ? threadId : null,
    linkedConversationClosed: linkView === "conversation" && link?.status !== "active",
  };

  const thread = selectedTaskId ? (
    <TaskThreadPanel
      key={selectedTaskId}
      taskId={selectedTaskId}
      collapsed={isDesktop && threadCollapsed}
      panelWidth={panelWidth}
      fullScreen={!isDesktop || deepLinked}
      onPanelWidthChange={setPanelWidth}
      onToggle={() => setThreadCollapsed((collapsed) => !collapsed)}
      onClose={closeThread}
    />
  ) : null;

  return (
    <WorkspaceProvider value={value}>
      <div className="flex h-dvh overflow-hidden bg-panel text-ink">
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
            !deepLinked && (
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
              {selectedTaskId && (
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
    </WorkspaceProvider>
  );
}

export default WorkspaceShell;
