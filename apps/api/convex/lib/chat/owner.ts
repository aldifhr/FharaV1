/**
 * Who answers a project chat message nobody was @mentioned in. System
 * routes, deterministically (no LLM chooser); there is no CTO default:
 *
 * 1. routeQuestion (dispatch.ts): a short status question → a System status
 *    line (no LLM); else the agent who answered the previous turn; else a
 *    greeting / short how-to → Support, planning → CTO, or the role that owns
 *    the topic.
 * 2. The request names files of one code role ("ultimate.html" → Frontend).
 * 3. Support, else the conversational fallback.
 *
 * Pure; unit-tested in owner.test.ts.
 */
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
      via: "route" | "previous" | "files" | "fallback";
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

export function resolveChatOwner<T extends Member>(input: {
  text: string;
  team: T[];
  history: Row[];
  repoToolsAvailable: boolean;
}): ChatOwner<T> | null {
  const { team } = input;
  if (team.length === 0) return null;
  const route = routeQuestion({ text: input.text, team, history: input.history, repoToolsAvailable: input.repoToolsAvailable });
  if (route.kind === "status") return { kind: "status" };
  if (route.kind === "specialist") {
    return { kind: "agent", agent: route.agent, domain: route.domain, topic: route.topic, via: route.followUp ? "previous" : "route" };
  }
  const byFiles = codeRoleForRequest(input.text);
  const fileOwner = byFiles ? team.find((a) => normalizeRoleKey(a.role) === byFiles) : undefined;
  if (fileOwner) return { kind: "agent", agent: fileOwner, domain: null, via: "files" };
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
