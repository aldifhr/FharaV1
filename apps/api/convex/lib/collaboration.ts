/**
 * Collaboration graph: who works with whom, by role. Pure (no Convex APIs).
 * Every edge is a count of stored rows, never a guess by a model:
 *
 *  - delegation: `delegations` rows (fromAgentId → toAgentId).
 *  - chat: CTO @mention handoffs in chat. A teammate reply that carries
 *    `messages.handoffFromAgentId` is a recorded handoff; older replies are
 *    inferred from the stored text (the CTO reply in the same turn
 *    @mentioned that teammate, using the chat's own selectHandoffs rule).
 *  - review_loop: a review or QA pass that sent work back: review/QA
 *    subtask role → the role that ran the fix subtask it spawned
 *    (`review_fix_N` ← review nodes, `fix_qa_N` ← QA nodes, same task).
 *  - dependency: DAG edges between subtasks of different roles
 *    (dependency's role → dependent's role, same task).
 */
import { selectHandoffs } from "./chat/team";
import { ROLE_KEYS } from "./roles";
import { DAY_MS, roleBucket } from "./workload";

export const EDGE_TYPES = ["delegation", "chat", "review_loop", "dependency"] as const;
export type CollaborationEdgeType = (typeof EDGE_TYPES)[number];

export interface CollabSubtaskInput {
  taskId: string;
  key: string;
  kind: string;
  origin?: string | null;
  role: string | null;
  dependencies: string[];
  at: number;
}

export interface CollabDelegationInput {
  fromRole: string | null;
  toRole: string | null;
  at: number;
}

export interface CollabMessageInput {
  id: string;
  conversationId: string | null;
  authorType: "user" | "agent";
  agentId: string | null;
  content: string;
  handoffFromAgentId?: string | null;
  at: number;
}

export interface CollabAgentInput {
  id: string;
  name: string;
  role: string;
}

export interface CollaborationEdge {
  from: string;
  to: string;
  total: number;
  counts: Record<CollaborationEdgeType, number>;
}

export interface CollaborationNode {
  key: string;
  label: string;
  recognized: boolean;
  /** Sum of edge weights touching this node (both directions). */
  weight: number;
}

export interface CollaborationGraph {
  sinceDays: number;
  nodes: CollaborationNode[];
  edges: CollaborationEdge[];
  totals: Record<CollaborationEdgeType, number> & { chatRecorded: number; chatInferred: number };
}

const REVIEW_FIX = /^review_fix_\d+/;
const QA_FIX = /^fix_qa_\d+/;

/** Chat handoffs (CTO → teammate) found in stored messages. */
export function chatHandoffs(
  messages: CollabMessageInput[],
  agents: CollabAgentInput[]
): Array<{ fromAgentId: string; toAgentId: string; at: number; recorded: boolean }> {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const ctoIds = new Set(agents.filter((a) => roleBucket(a.role).key === "cto").map((a) => a.id));
  const team = agents.map((a) => ({ _id: a.id, name: a.name, role: a.role }));
  const byConversation = new Map<string, CollabMessageInput[]>();
  for (const m of messages) {
    if (!m.conversationId) continue;
    const list = byConversation.get(m.conversationId) ?? [];
    list.push(m);
    byConversation.set(m.conversationId, list);
  }
  const out: Array<{ fromAgentId: string; toAgentId: string; at: number; recorded: boolean }> = [];
  for (const list of byConversation.values()) {
    list.sort((a, b) => a.at - b.at);
    // Teammates the CTO addressed earlier in the current turn.
    let addressedBy: string | null = null;
    const addressed = new Set<string>();
    for (const m of list) {
      if (m.authorType === "user") {
        addressedBy = null;
        addressed.clear();
        continue;
      }
      if (!m.agentId) continue;
      if (m.handoffFromAgentId && byId.has(m.handoffFromAgentId)) {
        out.push({ fromAgentId: m.handoffFromAgentId, toAgentId: m.agentId, at: m.at, recorded: true });
        addressed.delete(m.agentId);
        continue;
      }
      if (ctoIds.has(m.agentId)) {
        for (const a of selectHandoffs(m.content, team, m.agentId)) addressed.add(String(a._id));
        if (addressed.size > 0) addressedBy = m.agentId;
        continue;
      }
      if (addressedBy && addressed.has(m.agentId)) {
        out.push({ fromAgentId: addressedBy, toAgentId: m.agentId, at: m.at, recorded: false });
        addressed.delete(m.agentId);
      }
    }
  }
  return out;
}

export function buildCollaborationGraph(input: {
  now: number;
  sinceDays: number;
  agents: CollabAgentInput[];
  /** Roles of enabled agents: always drawn as nodes, even with no edges. */
  rosterRoles?: string[];
  subtasks: CollabSubtaskInput[];
  delegations: CollabDelegationInput[];
  messages: CollabMessageInput[];
}): CollaborationGraph {
  const since = input.now - input.sinceDays * DAY_MS;
  const inWindow = (at: number) => at >= since;
  const roleOfAgent = new Map(input.agents.map((a) => [a.id, a.role]));

  const nodes = new Map<string, CollaborationNode>();
  const node = (raw: string | null | undefined): CollaborationNode | null => {
    const b = roleBucket(raw);
    if (b.key === "unattributed") return null;
    let n = nodes.get(b.key);
    if (!n) {
      n = { key: b.key, label: b.label, recognized: b.recognized, weight: 0 };
      nodes.set(b.key, n);
    }
    return n;
  };
  for (const role of input.rosterRoles ?? []) node(role);

  const edges = new Map<string, CollaborationEdge>();
  const totals = { delegation: 0, chat: 0, review_loop: 0, dependency: 0, chatRecorded: 0, chatInferred: 0 };
  const add = (fromRaw: string | null | undefined, toRaw: string | null | undefined, type: CollaborationEdgeType) => {
    const a = node(fromRaw);
    const b = node(toRaw);
    if (!a || !b || a.key === b.key) return false;
    const id = `${a.key}->${b.key}`;
    let e = edges.get(id);
    if (!e) {
      e = { from: a.key, to: b.key, total: 0, counts: { delegation: 0, chat: 0, review_loop: 0, dependency: 0 } };
      edges.set(id, e);
    }
    e.counts[type] += 1;
    e.total += 1;
    a.weight += 1;
    b.weight += 1;
    totals[type] += 1;
    return true;
  };

  for (const d of input.delegations) if (inWindow(d.at)) add(d.fromRole, d.toRole, "delegation");

  for (const h of chatHandoffs(input.messages.filter((m) => inWindow(m.at)), input.agents)) {
    if (add(roleOfAgent.get(h.fromAgentId), roleOfAgent.get(h.toAgentId), "chat")) {
      if (h.recorded) totals.chatRecorded += 1;
      else totals.chatInferred += 1;
    }
  }

  const byTask = new Map<string, CollabSubtaskInput[]>();
  for (const s of input.subtasks) {
    if (!inWindow(s.at)) continue;
    const list = byTask.get(s.taskId) ?? [];
    list.push(s);
    byTask.set(s.taskId, list);
  }
  for (const list of byTask.values()) {
    const byKey = new Map(list.map((s) => [s.key, s]));
    const reviewRoles = [...new Set(list.filter((s) => s.kind === "review" && s.role).map((s) => s.role!))];
    const qaRoles = [...new Set(list.filter((s) => s.kind === "qa" && s.role).map((s) => s.role!))];
    for (const s of list) {
      if (!s.role) continue;
      if (s.kind !== "review" && s.kind !== "qa") {
        const sources = REVIEW_FIX.test(s.key) ? reviewRoles : QA_FIX.test(s.key) ? qaRoles : [];
        for (const from of sources) add(from, s.role, "review_loop");
      }
      for (const dep of s.dependencies) {
        const d = byKey.get(dep);
        if (d?.role) add(d.role, s.role, "dependency");
      }
    }
  }

  const order = (key: string) => {
    const i = (ROLE_KEYS as readonly string[]).indexOf(key);
    return i === -1 ? ROLE_KEYS.length : i;
  };
  return {
    sinceDays: input.sinceDays,
    nodes: [...nodes.values()].sort((a, b) => order(a.key) - order(b.key) || a.label.localeCompare(b.label)),
    edges: [...edges.values()].sort((a, b) => b.total - a.total || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    totals,
  };
}
