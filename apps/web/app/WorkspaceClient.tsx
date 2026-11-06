"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import IconRail from "../components/IconRail";
import Sidebar from "../components/Sidebar";
import TaskThreadPanel from "../components/TaskThreadPanel";
import { useMutation, useQuery } from "convex/react";
import { AnimatePresence } from "framer-motion";
import ConfirmDialog, { type ConfirmRequest } from "../components/ConfirmDialog";
import { useToast } from "../components/Toasts";
import { api } from "../../api/convex/_generated/api";
import { WorkspaceProvider, type Agent, type Task } from "./WorkspaceContext";

function WorkspaceShell({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [threadCollapsed, setThreadCollapsed] = useState(false);
  const [highlightAgentId, setHighlightAgentId] = useState<string | null>(null);
  const userClosedRef = useRef(false);

  const openAgent = (agentId: string) => {
    setHighlightAgentId(agentId);
  };
  const tasks = useQuery(api.tasks.listByProject, { projectId: projectId as never });
  const allAgents = useQuery(api.agents.list, {});
  const project = useQuery(api.projects.get, { projectId: projectId as never });
  const projectAgentIds = project?.agentIds;
  const agents = projectAgentIds
    ? allAgents?.filter((agent) => projectAgentIds.includes(agent._id))
    : allAgents;

  useEffect(() => {
    if (project === null) router.push("/chats");
  }, [project, router]);

  const removeTask = useMutation(api.tasks.remove);
  const toast = useToast();
  const [confirmReq, setConfirmReq] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);

  const deleteTask = (task: Task) => {
    setConfirmReq({
      title: `Delete task "${task.title}"?`,
      message: "This task and all of its history will be deleted permanently.",
      onOk: () => { void confirmDeleteTask(task); },
    });
  };

  const confirmDeleteTask = async (task: Task) => {
    try {
      await removeTask({ taskId: task._id as never });
      if (selectedTaskId === task._id) setSelectedTaskId(null);
      toast("success", "Task deleted", task.title);
      setConfirmReq(null);
    } catch (err) {
      toast("error", "Failed to delete task", err instanceof Error ? err.message : "Failed to delete task");
    }
  };

  useEffect(() => {
    setSelectedTaskId(null);
    setThreadCollapsed(false);
    userClosedRef.current = false;
  }, [projectId]);

  useEffect(() => {
    if (!userClosedRef.current && !selectedTaskId && tasks?.[0]) setSelectedTaskId(tasks[0]._id);
  }, [selectedTaskId, tasks]);

  const value = {
    projectId,
    agents: agents as Agent[] | undefined,
    tasks: tasks as Task[] | undefined,
    selectedTaskId,
    threadCollapsed,
    highlightAgentId,
    selectTask: (taskId: string) => { userClosedRef.current = false; setSelectedTaskId(taskId); setThreadCollapsed(false); },
    toggleThread: () => setThreadCollapsed((collapsed) => !collapsed),
    closeThread: () => { userClosedRef.current = true; setSelectedTaskId(null); },
    openAgent,
  };

  return (
    <WorkspaceProvider value={value as any}>
      <div className="flex h-screen overflow-hidden bg-transparent text-[#24232d] dark:text-gray-100 max-[979px]:h-auto max-[979px]:flex-col max-[979px]:overflow-y-auto">
        <ConfirmDialog request={confirmReq} onCancel={() => setConfirmReq(null)} onConfirm={() => confirmReq?.onOk()} />
        <IconRail projectId={projectId} />
        <Sidebar projectId={projectId} />
        {children}
        <motion.div
          animate={{ width: selectedTaskId ? 318 : 0 }}
          transition={{ duration: 0.24, ease: [0.32, 0.72, 0, 1] }}
          className="shrink-0 overflow-hidden"
        >
          <AnimatePresence initial={false}>
            {selectedTaskId && (
              <TaskThreadPanel
                key={selectedTaskId}
                taskId={selectedTaskId}
                collapsed={threadCollapsed}
                onToggle={() => setThreadCollapsed((collapsed) => !collapsed)}
                onClose={() => { userClosedRef.current = true; setSelectedTaskId(null); }}
              />
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </WorkspaceProvider>
  );
}

export default WorkspaceShell;
