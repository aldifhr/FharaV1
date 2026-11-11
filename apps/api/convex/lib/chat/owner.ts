/**
 * Who answers a project chat message nobody was @mentioned in
 * (Orchestrator/CTO split O3, plan §2.2). System routes; the topic owner
 * answers. There is no CTO default:
 *
 * 1. An option pick goes back to the agent that offered the options.
 * 2. routeQuestion (dispatch.ts): the role that owns the topic, a greeting or
 *    short how-to → Support, planning / architecture → CTO, a short status
 *    question → a System status line (no LLM).
 * 3. The request names files of one code role ("ultimate.html" → Frontend):
 *    that role, so a write request goes to its implementer directly.
 * 4. Nothing matched: the neutral LLM chooser over the team without the CTO
 *    (architecture already routed to it above).
 * 5. Chooser unavailable: Support, else the conversational fallback.
 *
 * Pure apart from the injected chooser; unit-tested in owner.test.ts.
 */
import { isSystemLine } from "../systemLine";
import { routeQuestion, type DispatchDomain } from "./dispatch";
import { codeRoleForRequest } from "./intent";
import { normalizeRoleKey } from "../roles";

type Member = { _id: string; name: string; role: string };
type Row = { authorType: string; content: string; agentId?: string; voice?: string };

export type ChatOwner<T extends Member> =
  | { kind: "status" }
  | {
      kind: "agent";
      agent: T;
      /** The topic domain when routeQuestion matched one. */
      domain: DispatchDomain | null;
      topic?: string;
      via: "route" | "option-pick" | "files" | "chooser" | "fallback";
    };

const CTO_ROLE = /^(?:cto|architect)$/i;

/** The deterministic fallback owner: Support, General, Researcher, then anyone but the CTO. */
export function fallbackOwner<T extends Member>(team: T[]): T | null {
  const notCto = team.filter((a) => !CTO_ROLE.test(a.role.trim()));
  if (notCto.length === 0) return team[0] ?? null;
  return (
    notCto.find((a) => /^support/i.test(a.role)) ??
    notCto.find((a) => /^(general|assistant)/i.test(a.role)) ??
    notCto.find((a) => /^researcher/i.test(a.role)) ??
    notCto[0]
  );
}

/** The agent whose reply the latest user message (an option pick) answers. */
function offeringAgent<T extends Member>(history: Row[], team: T[]): T | null {
  for (let i = history.length - 2; i >= 0; i -= 1) {
    const row = history[i];
    if (row.authorType === "user") return null;
    if (row.authorType !== "agent" || isSystemLine(row) || !row.agentId) continue;
    return team.find((a) => String(a._id) === String(row.agentId)) ?? null;
  }
  return null;
}

export async function resolveChatOwner<T extends Member>(input: {
  text: string;
  team: T[];
  history: Row[];
  repoToolsAvailable: boolean;
  optionPick: boolean;
  /** The neutral LLM chooser; resolves to an agent id or null. */
  choose: (pool: T[]) => Promise<string | null>;
}): Promise<ChatOwner<T> | null> {
  const { team } = input;
  if (team.length === 0) return null;
  if (input.optionPick) {
    const agent = offeringAgent(input.history, team);
    if (agent) return { kind: "agent", agent, domain: null, via: "option-pick" };
  }
  const route = routeQuestion({ text: input.text, team, history: input.history, repoToolsAvailable: input.repoToolsAvailable });
  if (route.kind === "status") return { kind: "status" };
  if (route.kind === "specialist") return { kind: "agent", agent: route.agent, domain: route.domain, topic: route.topic, via: "route" };
  const byFiles = codeRoleForRequest(input.text);
  const fileOwner = byFiles ? team.find((a) => normalizeRoleKey(a.role) === byFiles) : undefined;
  if (fileOwner) return { kind: "agent", agent: fileOwner, domain: null, via: "files" };
  const pool = team.filter((a) => !CTO_ROLE.test(a.role.trim()));
  if (pool.length > 1) {
    const id = await input.choose(pool).catch(() => null);
    const picked = id ? pool.find((a) => String(a._id) === String(id)) : undefined;
    if (picked) return { kind: "agent", agent: picked, domain: null, via: "chooser" };
  }
  const fallback = fallbackOwner(team);
  return fallback ? { kind: "agent", agent: fallback, domain: null, via: "fallback" } : null;
}

const RUNNING = new Set(["running", "queued"]);
const WAITING: Record<string, string> = {
  needs_approval: "waiting for approval",
  waiting_input: "waiting for your answer",
  paused: "paused",
};

/**
 * System's status line from task state (§2.5, no LLM):
 * "2 tasks running: 'CSV export' (Backend), 'Login fix'" ·
 * "1 waiting for approval: 'Profile page'" / "Nothing running".
 */
export function buildTaskStatusLine(
  tasks: Array<{ title: string; status: string; assigneeNames?: string[] }>
): string {
  const label = (t: { title: string; assigneeNames?: string[] }) => {
    const who = (t.assigneeNames ?? []).filter(Boolean);
    return `'${t.title.trim().slice(0, 60)}'${who.length ? ` (${who.join(", ")})` : ""}`;
  };
  const parts: string[] = [];
  const running = tasks.filter((t) => RUNNING.has(t.status));
  if (running.length) {
    parts.push(`${running.length} ${running.length === 1 ? "task" : "tasks"} running: ${running.slice(0, 3).map(label).join(", ")}${running.length > 3 ? ", …" : ""}`);
  }
  for (const [status, words] of Object.entries(WAITING)) {
    const rows = tasks.filter((t) => t.status === status);
    if (rows.length) parts.push(`${rows.length} ${words}: ${rows.slice(0, 3).map(label).join(", ")}${rows.length > 3 ? ", …" : ""}`);
  }
  return parts.length ? parts.join(" · ") : "Nothing running";
}
