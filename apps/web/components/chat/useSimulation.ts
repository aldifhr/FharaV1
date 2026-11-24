import { useEffect, useMemo, useRef, useState } from "react";
import type { SimulatedTaskThread } from "@/app/WorkspaceContext";

type SimRecord = { task: any; subtasks: any[] };

/**
 * Local "simulate replies" preview for a project chat: a self-contained
 * CTO → Frontend → QA → Review task flow that never calls an LLM or touches
 * project files. The generated messages/tasks are merged into the real chat
 * data so the rest of the panel renders them through the normal path.
 *
 * All state is scoped to `projectId` and invalidated when it changes; a
 * generation counter cancels the delayed preview steps so a stale project's
 * timers cannot write into the new one.
 */
export function useSimulation({
  projectId,
  agents,
  timeline,
  tasks,
  subtasksOf,
  onSelectTask,
  openSimulatedThread,
  updateSimulatedThread,
  simulatedThread,
}: {
  projectId: string;
  agents: any[];
  timeline: any[];
  tasks: any[] | undefined;
  subtasksOf: Map<string, any[]>;
  onSelectTask: (taskId: string) => void;
  openSimulatedThread: (thread: SimulatedTaskThread) => void;
  updateSimulatedThread: (thread: SimulatedTaskThread) => void;
  simulatedThread: SimulatedTaskThread | null;
}) {
  const [simulateReplies, setSimulateReplies] = useState(false);
  const [simulationMessages, setSimulationMessages] = useState<any[]>([]);
  const [simulationTasks, setSimulationTasks] = useState<SimRecord[]>([]);
  const simulationSequence = useRef(0);
  const simulationGeneration = useRef(0);

  useEffect(() => {
    simulationGeneration.current += 1;
    setSimulateReplies(false);
    setSimulationMessages([]);
    setSimulationTasks([]);
    simulationSequence.current = 0;
    return () => {
      simulationGeneration.current += 1;
    };
  }, [projectId]);

  const displayTimeline = useMemo(
    () => [...timeline, ...simulationMessages].sort((a, b) => a._creationTime - b._creationTime),
    [timeline, simulationMessages],
  );
  const displayTasks = useMemo(
    () => [...((tasks ?? []) as any[]), ...simulationTasks.map((record) => record.task)],
    [tasks, simulationTasks],
  );
  const displaySubtasksOf = useMemo(() => {
    const map = new Map(subtasksOf);
    for (const record of simulationTasks) map.set(String(record.task._id), record.subtasks);
    return map;
  }, [subtasksOf, simulationTasks]);

  // Keep an open simulated-thread panel in sync as preview steps advance.
  useEffect(() => {
    if (!simulatedThread) return;
    const record = simulationTasks.find((item) => item.task._id === simulatedThread.task._id);
    if (!record) return;
    updateSimulatedThread({
      ...record,
      messages: simulationMessages.filter((message) => message.taskId === record.task._id),
    });
  }, [simulationTasks, simulationMessages, simulatedThread?.task._id, updateSimulatedThread]);

  const openTaskOrSimulation = (taskId: string) => {
    const record = simulationTasks.find((item) => String(item.task._id) === taskId);
    if (!record) {
      onSelectTask(taskId);
      return;
    }
    openSimulatedThread({
      ...record,
      messages: simulationMessages.filter((message) => message.taskId === taskId),
    });
  };

  const addSimulationMessage = (taskId: string, role: string, content: string) => {
    const now = Date.now();
    const agent = agents.find((item: any) => String(item.role).toLowerCase() === role.toLowerCase());
    if (!agent) return;
    simulationSequence.current += 1;
    setSimulationMessages((current) => [...current, {
      _id: `simulation-${projectId}-${simulationSequence.current}`,
      _creationTime: now,
      authorType: "agent",
      agentId: agent._id,
      role: String(agent.role),
      content,
      projectId,
      taskId,
      simulated: true,
    }]);
  };

  const addSimulationReply = (content: string) => {
    const generation = simulationGeneration.current;
    simulationSequence.current += 1;
    const sequence = simulationSequence.current;
    const taskId = `simulation-task-${projectId}-${sequence}`;
    const now = Date.now();
    const cto = agents.find((agent: any) => String(agent.role).toLowerCase() === "cto") ?? agents[0];
    const frontend = agents.find((agent: any) => String(agent.role).toLowerCase() === "frontend");
    const qa = agents.find((agent: any) => String(agent.role).toLowerCase() === "qa");
    const title = content.replace(/\s+/g, " ").trim().slice(0, 88) || "Simulated task";
    const subtasks = [
      { _id: `${taskId}-frontend`, assignedAgentId: frontend?._id, title: "Implement request", status: "running" },
      { _id: `${taskId}-qa`, assignedAgentId: qa?._id, title: "Verify result", status: "queued" },
      { _id: `${taskId}-review`, assignedAgentId: cto?._id, title: "Review and summarize", status: "queued" },
    ];
    setSimulationMessages((current) => [...current, {
      _id: `simulation-${projectId}-${sequence}-user`,
      _creationTime: now,
      authorType: "user",
      content,
      projectId,
      taskId,
      simulated: true,
    }]);
    setSimulationTasks((current) => [...current, {
      task: { _id: taskId, title, status: "running", simulated: true },
      subtasks,
    }]);
    if (cto) addSimulationMessage(taskId, String(cto.role), "Simulation: @Frontend, please implement this request. I created a preview task and routed it to you. This run stays local; it won't call an LLM or change project files.");

    window.setTimeout(() => {
      if (generation !== simulationGeneration.current) return;
      setSimulationTasks((current) => current.map((record) => record.task._id !== taskId ? record : {
        ...record,
        subtasks: record.subtasks.map((subtask, index) => ({ ...subtask, status: index === 0 ? "completed" : index === 1 ? "running" : "queued" })),
      }));
      addSimulationMessage(taskId, "frontend", "Simulation: @QA, please verify the result. The implementation step is complete, but the actual repository was not edited in this preview.");
    }, 900);
    window.setTimeout(() => {
      if (generation !== simulationGeneration.current) return;
      setSimulationTasks((current) => current.map((record) => record.task._id !== taskId ? record : {
        ...record,
        subtasks: record.subtasks.map((subtask, index) => ({ ...subtask, status: index < 2 ? "completed" : "running" })),
      }));
      addSimulationMessage(taskId, "qa", "Simulation: @CTO, the preview checks are complete. No browser or build checks were actually run.");
    }, 1900);
    window.setTimeout(() => {
      if (generation !== simulationGeneration.current) return;
      setSimulationTasks((current) => current.map((record) => record.task._id === taskId ? {
        ...record,
        task: { ...record.task, status: "done" },
        subtasks: record.subtasks.map((subtask) => ({ ...subtask, status: "completed" })),
      } : record));
      addSimulationMessage(taskId, "cto", "Simulation complete: @Frontend and @QA have finished their preview steps. The task flow reached review with a preview result ready. This is illustrative only; no real code changes or verification were performed.");
    }, 3000);
  };

  return {
    simulateReplies,
    setSimulateReplies,
    addSimulationReply,
    openTaskOrSimulation,
    displayTimeline,
    displayTasks,
    displaySubtasksOf,
  };
}
