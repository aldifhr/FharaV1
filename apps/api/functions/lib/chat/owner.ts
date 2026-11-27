/**
 * Who answers a project chat message nobody was @mentioned in. System
 * routes, deterministically (no LLM chooser):
 *
 * 1. The agent who answered the previous turn keeps the conversation.
 * 2. A validated classifier role picks the owner; an explicit named file picks
 *    the role that owns that file path.
 * 3. A question with no owner goes to the CTO, the conversational owner. The
 *    General/Researcher fallback chain only applies on a team without a CTO.
 *
 * Pure; unit-tested in owner.test.ts.
 */
import { previousResponder, type DispatchDomain } from "./dispatch";
import { codeRoleForRequest } from "./intent";
import { isCtoRole, normalizeRoleKey, resolveRoleKey } from "../roles";
import type { RoutingClassification } from "./routingClassification";

type Member = { _id: string; name: string; role: string };
type Row = { authorType: string; content: string; agentId?: string; voice?: string };

export type ChatOwner<T extends Member> =
  | { kind: "status" }
  | {
      kind: "agent";
      agent: T;
      /** The validated classifier kind, when one owns the message. */
      domain: DispatchDomain;
      topic?: string;
      via: "route" | "previous" | "files" | "fallback" | "llm";
    };

/** The deterministic fallback owner: General, Researcher, then anyone but the CTO. */
export function fallbackOwner<T extends Member>(team: T[]): T | null {
  const notCto = team.filter((a) => !isCtoRole(a.role));
  if (notCto.length === 0) return team[0] ?? null;
  const named = (role: string) => notCto.find((a) => normalizeRoleKey(a.role) === role);
  return named("general") ?? named("assistant") ?? named("researcher") ?? notCto[0];
}

export function resolveChatOwner<T extends Member>(input: {
  text: string;
  team: T[];
  history: Row[];
  repoToolsAvailable?: boolean;
  routing?: RoutingClassification | null;
}): ChatOwner<T> | null {
  const { team } = input;
  if (team.length === 0) return null;
  const prev = previousResponder(input.history, team);
  if (prev) return { kind: "agent", agent: prev, domain: null, via: "previous" };
  if (input.routing?.role) {
    const owner = team.find((a) => resolveRoleKey(a.role) === input.routing!.role && !isCtoRole(a.role));
    if (owner) {
      return {
        kind: "agent",
        agent: owner,
        domain: input.routing.kind,
        ...(input.routing.files[0] ? { topic: input.routing.files[0] } : {}),
        via: "route",
      };
    }
  }
  const byFiles = codeRoleForRequest(input.text);
  const fileOwner = byFiles ? team.find((a) => resolveRoleKey(a.role) === byFiles) : undefined;
  if (fileOwner) return { kind: "agent", agent: fileOwner, domain: null, via: "files" };
  // A question with no owner goes to the CTO, which answers or hands off.
  const cto = team.find((a) => isCtoRole(a.role));
  if (cto) return { kind: "agent", agent: cto, domain: null, via: "route" };
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
