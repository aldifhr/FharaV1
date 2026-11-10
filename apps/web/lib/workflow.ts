/**
 * Workflow Studio model.
 *
 * A workflow is a visual DAG of agent steps. It is a *definition* only:
 * nothing here executes agents. The type shapes are intentionally close to
 * the backend `ExecutionPlan` subtasks (key + dependencies) so a future
 * backend compile can map 1:1. Persisted in the backend via `api.workflows.*`;
 * the pure helpers below stay framework-free (preview, validation, brief).
 */

export type WorkflowNodeType = "start" | "agent" | "approval" | "conditional" | "end";
export type EdgeCondition = "always" | "on_success" | "on_failure" | "custom";

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  title: string;
  /** Role key (see `@/api/convex/lib/roles`) for agent nodes. */
  role?: string;
  /** Instructions handed to the agent (agent nodes only). */
  prompt?: string;
  /** Max automatic retries for this node (agent nodes only). */
  retries?: number;
  /** Approval message (approval nodes) or condition text (conditional nodes). */
  message?: string;
  x: number;
  y: number;
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  condition: EdgeCondition;
  /** Short label drawn on the edge, e.g. "QA passes". */
  label?: string;
}

export interface Workflow {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowIssue {
  level: "error" | "warn" | "info";
  message: string;
}

export function newId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  return `${prefix}_${rand.slice(0, 8)}`;
}

/** The example from the spec: User → CTO → Developer → QA → Reviewer → Done. */
export function defaultWorkflow(): Workflow {
  const now = Date.now();
  const nodes: WorkflowNode[] = [
    { id: "start", type: "start", title: "User", x: 24, y: 240 },
    { id: "cto", type: "agent", title: "Plan", role: "cto", prompt: "Decide the technical approach and split the work.", retries: 0, x: 220, y: 240 },
    { id: "dev", type: "agent", title: "Developer", role: "frontend", prompt: "Implement the change.", retries: 2, x: 416, y: 240 },
    { id: "qa", type: "agent", title: "QA", role: "qa", prompt: "Verify the change; report pass or fail.", retries: 0, x: 612, y: 240 },
    { id: "reviewer", type: "agent", title: "Reviewer", role: "reviewer", prompt: "Review the implementation diff.", retries: 0, x: 808, y: 240 },
    { id: "done", type: "end", title: "Done", x: 1004, y: 240 },
  ];
  const edges: WorkflowEdge[] = [
    { id: newId("edge"), from: "start", to: "cto", condition: "always" },
    { id: newId("edge"), from: "cto", to: "dev", condition: "always" },
    { id: newId("edge"), from: "dev", to: "qa", condition: "always" },
    { id: newId("edge"), from: "qa", to: "reviewer", condition: "on_success", label: "QA passes" },
    { id: newId("edge"), from: "qa", to: "dev", condition: "on_failure", label: "QA fails → rework" },
    { id: newId("edge"), from: "reviewer", to: "done", condition: "on_success", label: "Approved" },
  ];
  return { id: newId("wf"), name: "Standard pipeline", createdAt: now, updatedAt: now, nodes, edges };
}


export function nodeById(workflow: Workflow, id: string): WorkflowNode | undefined {
  return workflow.nodes.find((node) => node.id === id);
}

export function outgoing(workflow: Workflow, nodeId: string): WorkflowEdge[] {
  return workflow.edges.filter((edge) => edge.from === nodeId);
}

export function incoming(workflow: Workflow, nodeId: string): WorkflowEdge[] {
  return workflow.edges.filter((edge) => edge.to === nodeId);
}

/** Topological-ish order from the start node (deduplicated). */
export function previewOrder(workflow: Workflow): string[] {
  const start = workflow.nodes.find((node) => node.type === "start") ?? workflow.nodes[0];
  if (!start) return [];
  const seen = new Set<string>([start.id]);
  const queue = [start.id];
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const edge of outgoing(workflow, id)) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return order;
}

export function validateWorkflow(workflow: Workflow): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const ids = new Set(workflow.nodes.map((node) => node.id));
  if (ids.size !== workflow.nodes.length) {
    issues.push({ level: "error", message: "Duplicate node ids." });
  }
  for (const edge of workflow.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      issues.push({ level: "error", message: `Edge ${edge.id} references a missing node.` });
    } else if (edge.from === edge.to) {
      issues.push({ level: "error", message: `Node "${nodeTitle(workflow, edge.from)}" has a self-loop edge.` });
    }
  }
  if (workflow.nodes.length === 0) {
    issues.push({ level: "error", message: "The workflow has no nodes." });
  }
  if (!workflow.nodes.some((node) => node.type === "start")) {
    issues.push({ level: "warn", message: "No Start node. Add a User/start node so the flow has a single entry." });
  }
  if (!workflow.nodes.some((node) => node.type === "end")) {
    issues.push({ level: "warn", message: "No Done node. The flow never reaches a terminal state." });
  }
  for (const node of workflow.nodes) {
    if (node.type === "agent" && !node.role) {
      issues.push({ level: "error", message: `Agent node "${node.title}" has no role assigned.` });
    }
    if (node.type === "conditional" && outgoing(workflow, node.id).length < 2) {
      issues.push({ level: "warn", message: `Conditional node "${node.title}" needs at least 2 outgoing edges (branches).` });
    }
    if (node.type === "approval" && outgoing(workflow, node.id).length === 0) {
      issues.push({ level: "warn", message: `Approval node "${node.title}" has no downstream step. The flow would stall after approval.` });
    }
  }
  const start = workflow.nodes.find((node) => node.type === "start");
  if (start) {
    const reachable = new Set(previewOrder(workflow));
    for (const node of workflow.nodes) {
      if (!reachable.has(node.id)) {
        issues.push({ level: "warn", message: `Node "${node.title}" is not reachable from Start.` });
      }
    }
  }
  const cycle = findCycle(workflow);
  if (cycle) {
    const isRetryLoop = cycle.some((edgeId) => {
      const edge = workflow.edges.find((candidate) => candidate.id === edgeId);
      return edge?.condition === "on_failure";
    });
    issues.push(
      isRetryLoop
        ? { level: "info", message: "Retry loop detected (via an on-failure edge). This is a rework loop, not an error." }
        : { level: "error", message: "Cycle detected. Break the loop or mark the back-edge as on-failure (retry)." },
    );
  }
  const forks = workflow.nodes.filter((node) => outgoing(workflow, node.id).length > 1);
  for (const fork of forks) {
    issues.push({ level: "info", message: `Node "${fork.title}" fans out to ${outgoing(workflow, fork.id).length} steps — they can run in parallel.` });
  }
  return issues;
}

function nodeTitle(workflow: Workflow, id: string): string {
  return nodeById(workflow, id)?.title ?? id;
}

/** DFS cycle detection returning the edge ids on the cycle (or null). */
function findCycle(workflow: Workflow): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map(workflow.nodes.map((node) => [node.id, WHITE as number]));
  const stack: { nodeId: string; edgeId?: string }[] = [];
  let cycle: string[] | null = null;

  const visit = (nodeId: string): void => {
    if (cycle) return;
    color.set(nodeId, GRAY);
    for (const edge of outgoing(workflow, nodeId)) {
      if (!color.has(edge.to)) continue;
      const targetColor = color.get(edge.to);
      if (targetColor === GRAY) {
        cycle = [...stack.slice(stack.findIndex((entry) => entry.nodeId === edge.to)).map((entry) => entry.edgeId).filter(Boolean) as string[], edge.id];
        return;
      }
      if (targetColor === WHITE) {
        stack.push({ nodeId: edge.to, edgeId: edge.id });
        visit(edge.to);
        stack.pop();
      }
      if (cycle) return;
    }
    color.set(nodeId, BLACK);
  };

  for (const node of workflow.nodes) {
    if (color.get(node.id) === WHITE) {
      stack.push({ nodeId: node.id });
      visit(node.id);
      stack.pop();
      if (cycle) break;
    }
  }
  return cycle;
}

/** Human-readable run brief: what the CTO should execute, step by step. */
export function workflowToBrief(workflow: Workflow): string {
  const lines = workflow.nodes.map((node) => {
    switch (node.type) {
      case "start":
        return `- START: ${node.title}`;
      case "agent":
        return `- ${node.title} [role: ${node.role ?? "?"}${node.retries ? `, retries: ${node.retries}` : ""}]: ${node.prompt ?? "no instructions"}`;
      case "approval":
        return `- HUMAN APPROVAL: ${node.title} — ${node.message ?? "approve to continue"}`;
      case "conditional":
        return `- CONDITIONAL: ${node.title} — ${node.message ?? "choose branch by result"}`;
      case "end":
        return `- DONE: ${node.title}`;
    }
  });
  const edgeLines = workflow.edges.map((edge) => {
    const from = nodeTitle(workflow, edge.from);
    const to = nodeTitle(workflow, edge.to);
    const cond = edge.condition === "always" ? "" : ` (${edge.condition.replace("on_", "on ")}${edge.label ? `: ${edge.label}` : ""})`;
    return `  ${from} → ${to}${cond}`;
  });
  return `Workflow "${workflow.name}"\nSteps:\n${lines.join("\n")}\nConnections:\n${edgeLines.join("\n")}`;
}
