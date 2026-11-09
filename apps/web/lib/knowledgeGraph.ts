/**
 * Knowledge graph derivation (frontend only, purely presentational).
 *
 * The graph is built from the live queries the app already has (projects,
 * tasks, subtasks, file changes, agents, memories, collaboration). Two
 * kinds of cross-project links are *inferred* on the client:
 *  - shared files: the same path was changed in two projects;
 *  - similar tasks: task titles/commands in different projects share a
 *    significant keyword (auth, payment, …) — e.g. an auth fix in Project
 *    A linked to the matching test task in Project B.
 *
 * This is a view, not a permission system: the backend still decides who
 * may see what (assertProjectAccess / visibleProjects). The page's
 * "Cross-project" toggle only filters what this view draws.
 */

export type KgKind = "project" | "task" | "agent" | "file" | "memory";

export interface KgNode {
  id: string;
  kind: KgKind;
  label: string;
  sublabel?: string;
  projectId?: string;
  /** Deep link rendered in the detail panel. */
  href?: string;
}

export type KgEdgeKind =
  | "contains"
  | "assigned"
  | "changed"
  | "shared-file"
  | "similar-task"
  | "collaborates";

export interface KgEdge {
  id: string;
  from: string;
  to: string;
  kind: KgEdgeKind;
  label?: string;
}

export interface KgGraph {
  nodes: KgNode[];
  edges: KgEdge[];
  truncated: string[];
}

export interface KgProject {
  _id: string;
  name: string;
}

export interface KgTask {
  _id: string;
  projectId: string;
  title: string;
  command?: string;
  status?: string;
  projectName?: string;
}

export interface KgAgent {
  _id: string;
  name: string;
  role: string;
  isEnabled?: boolean;
}

export interface KgSubtask {
  taskId: string;
  key: string;
  title: string;
  kind: string;
  capability: string;
  status: string;
  assignedAgentId?: string;
}

export interface KgFileChange {
  _id: string;
  filePath: string;
  changeType: string;
  taskId: string;
}

export interface KgMemory {
  _id: string;
  scope: string;
  projectId?: string;
  agentId?: string;
  title: string;
  content: string;
  tags?: string[];
  pinned: boolean;
}

export interface KgCollabEdge {
  from: string;
  to: string;
  total: number;
}

export interface KgInput {
  projects: KgProject[];
  /** Selected project (canvas centre) — may be null for "all". */
  selectedProjectId: string | null;
  /** Recent tasks across projects (search.global). */
  searchTasks: KgTask[];
  /** Tasks of the selected project (tasks.listByProject). */
  projectTasks: KgTask[];
  /** Subtasks of the selected project (workspace.listSubtasksByProject). */
  subtasks: KgSubtask[];
  /** File changes of the selected project (fileChanges.listByProject). */
  files: KgFileChange[];
  agents: KgAgent[];
  memories: KgMemory[];
  collabEdges: KgCollabEdge[];
  collabLabels: Record<string, string>;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "for", "on", "with", "this", "that", "make", "add", "fix",
]);

/** Significant lowercase keywords of a task title/command. */
export function keywords(text: string): string[] {
  const found = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 4 && !STOP_WORDS.has(raw)) found.add(raw);
  }
  return [...found];
}

function taskText(task: KgTask): string {
  return `${task.title} ${task.command ?? ""}`;
}

export function buildGraph(input: KgInput): KgGraph {
  const truncated: string[] = [];
  const nodes: KgNode[] = [];
  const edges: KgEdge[] = [];
  const seenNode = new Set<string>();
  const id = (kind: KgKind, key: string) => `${kind}:${key}`;

  const addNode = (node: KgNode) => {
    if (seenNode.has(node.id)) return;
    seenNode.add(node.id);
    nodes.push(node);
  };
  const addEdge = (edge: KgEdge) => {
    if (edge.from === edge.to) return;
    if (edges.some((e) => e.from === edge.from && e.to === edge.to && e.kind === edge.kind)) return;
    edges.push(edge);
  };

  const selected = input.selectedProjectId;
  const projectName = new Map(input.projects.map((p) => [p._id, p.name]));

  // Projects.
  for (const project of input.projects) {
    addNode({ id: id("project", project._id), kind: "project", label: project.name, sublabel: "Project", projectId: project._id, href: `/chats/${project._id}` });
  }

  // Tasks: selected project's own tasks + recent tasks elsewhere.
  const taskMap = new Map<string, KgTask>();
  for (const task of input.projectTasks) taskMap.set(task._id, task);
  for (const task of input.searchTasks) {
    if (!taskMap.has(task._id)) taskMap.set(task._id, task);
  }
  const taskList = [...taskMap.values()];
  if (taskList.length > 60) truncated.push(`tasks (showing first 60 of ${taskList.length})`);
  for (const task of taskList.slice(0, 60)) {
    addNode({
      id: id("task", task._id),
      kind: "task",
      label: task.title,
      sublabel: [projectName.get(task.projectId) ?? task.projectName, task.status].filter(Boolean).join(" · "),
      projectId: task.projectId,
      href: `/runs/${task._id}`,
    });
    addEdge({ id: `e:${id("task", task._id)}:project`, from: id("project", task.projectId), to: id("task", task._id), kind: "contains" });
  }

  // Subtasks → agents.
  const agentById = new Map(input.agents.map((a) => [a._id, a]));
  const perTaskSubtasks = new Map<string, KgSubtask[]>();
  for (const subtask of input.subtasks) {
    const list = perTaskSubtasks.get(subtask.taskId) ?? [];
    list.push(subtask);
    perTaskSubtasks.set(subtask.taskId, list);
  }
  for (const [taskId, subtasks] of perTaskSubtasks) {
    for (const subtask of subtasks) {
      if (subtask.assignedAgentId) {
        const agent = agentById.get(subtask.assignedAgentId);
        if (agent) {
          addEdge({
            id: `e:${id("task", taskId)}:agent:${agent._id}`,
            from: id("task", taskId),
            to: id("agent", agent._id),
            kind: "assigned",
            label: subtask.title,
          });
        }
      }
    }
  }

  // Agents (enabled first, capped).
  const sortedAgents = [...input.agents].sort((a, b) => Number(b.isEnabled !== false) - Number(a.isEnabled !== false));
  if (sortedAgents.length > 24) truncated.push(`agents (showing first 24 of ${sortedAgents.length})`);
  for (const agent of sortedAgents.slice(0, 24)) {
    addNode({
      id: id("agent", agent._id),
      kind: "agent",
      label: agent.name,
      sublabel: agent.role,
      href: `/team/${agent._id}`,
    });
  }

  // Files (selected project) → task + project.
  const sortedFiles = [...input.files].sort((a, b) => a.filePath.localeCompare(b.filePath));
  if (sortedFiles.length > 60) truncated.push(`files (showing first 60 of ${sortedFiles.length})`);
  for (const file of sortedFiles.slice(0, 60)) {
    const fileId = id("file", file.filePath);
    addNode({ id: fileId, kind: "file", label: file.filePath.split("/").pop() ?? file.filePath, sublabel: file.filePath, projectId: selected ?? undefined });
    if (selected) addEdge({ id: `e:${fileId}:project`, from: id("project", selected), to: fileId, kind: "contains" });
    if (file.taskId) addEdge({ id: `e:${id("task", file.taskId)}:file:${file.filePath}`, from: id("task", file.taskId), to: fileId, kind: "changed" });
  }

  // Memories → project / agent (decisions).
  const memoryList = input.memories;
  if (memoryList.length > 30) truncated.push(`memories (showing first 30 of ${memoryList.length})`);
  for (const memory of memoryList.slice(0, 30)) {
    const memoryId = id("memory", memory._id);
    addNode({
      id: memoryId,
      kind: "memory",
      label: memory.title,
      sublabel: memory.pinned ? "Pinned decision" : "Decision / memory",
      projectId: memory.projectId,
      href: "/memory",
    });
    if (memory.projectId) addEdge({ id: `e:${memoryId}:project`, from: id("project", memory.projectId), to: memoryId, kind: "contains" });
    if (memory.agentId) addEdge({ id: `e:${memoryId}:agent`, from: id("memory", memory._id), to: id("agent", memory.agentId), kind: "assigned" });
  }

  // Cross-project: similar tasks across different projects (shared keyword).
  const byKeyword = new Map<string, KgTask[]>();
  for (const task of [...input.projectTasks, ...input.searchTasks]) {
    for (const word of new Set(keywords(taskText(task)))) {
      const list = byKeyword.get(word) ?? [];
      list.push(task);
      byKeyword.set(word, list);
    }
  }
  const similarBudget = [...byKeyword.entries()]
    .filter(([, tasks]) => {
      const projects = new Set(tasks.map((t) => t.projectId));
      return projects.size > 1 && tasks.length >= 2;
    })
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 40);
  for (const [word, tasks] of similarBudget) {
    const seen = [...new Map(tasks.map((t) => [t._id, t])).values()];
    // Link each task to the first one (star), labelled by the shared keyword.
    for (let i = 1; i < Math.min(seen.length, 4); i++) {
      addEdge({
        id: `e:similar:${word}:${seen[0]._id}:${seen[i]._id}`,
        from: id("task", seen[0]._id),
        to: id("task", seen[i]._id),
        kind: "similar-task",
        label: `shared: ${word}`,
      });
    }
  }

  // Collaboration edges between roles (data-driven, from orgIntel).
  const agentByRole = new Map<string, KgAgent[]>();
  for (const agent of input.agents) {
    const list = agentByRole.get(agent.role) ?? [];
    list.push(agent);
    agentByRole.set(agent.role, list);
  }
  for (const edge of input.collabEdges.slice(0, 40)) {
    const fromAgents = agentByRole.get(edge.from) ?? [];
    const toAgents = agentByRole.get(edge.to) ?? [];
    if (fromAgents.length && toAgents.length) {
      addEdge({
        id: `e:collab:${edge.from}:${edge.to}`,
        from: id("agent", fromAgents[0]._id),
        to: id("agent", toAgents[0]._id),
        kind: "collaborates",
        label: `${edge.total} collaborations`,
      });
    }
  }

  // "Only selected project" filter.
  if (selected) {
    return {
      nodes: nodes.filter((node) => !node.projectId || node.projectId === selected),
      edges: edges.filter((edge) => {
        if (edge.kind !== "similar-task" && edge.kind !== "collaborates") return true;
        return false;
      }),
      truncated,
    };
  }
  return { nodes, edges, truncated };
}

/** Neighbours of a node id, with the edge reaching them. */
export function neighbours(graph: KgGraph, nodeId: string): Array<{ node: KgNode; edge: KgEdge }> {
  const out: Array<{ node: KgNode; edge: KgEdge }> = [];
  for (const edge of graph.edges) {
    if (edge.from === nodeId) {
      const node = graph.nodes.find((n) => n.id === edge.to);
      if (node) out.push({ node, edge });
    }
    if (edge.to === nodeId) {
      const node = graph.nodes.find((n) => n.id === edge.from);
      if (node) out.push({ node, edge });
    }
  }
  return out;
}
