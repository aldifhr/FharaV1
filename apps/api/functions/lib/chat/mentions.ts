/**
 * Who a chat message addresses by an inline "@Role" or "@Name" written by hand.
 *
 * The mention menu sends agent ids (`preferredAgentIds`); a mention TYPED into
 * the box sends only text, so before this a message addressed to "@Backend" or
 * "@DevOps" was routed as if nobody had been addressed and the CTO answered it.
 * A typed mention is as binding as a picked one: the same `resolveRoleKey` that
 * every role menu reads turns "@Backend Developer" or "@support" into its live
 * role, and the agent's own name matches too.
 *
 * Pure; unit-tested in mentions.test.ts.
 */
import { resolveRoleKey } from "../roles";

type Mentionable = { _id: string; name: string; role: string };

/** "@Frontend", "@Backend Developer", "@QA" — the role key, then the name. */
const MENTION = /@([\w-]+)/gu;

export function mentionTargets<T extends Mentionable>(text: string, pool: T[], alreadyPicked: T[] = []): T[] {
  const targets: T[] = [];
  const taken = new Set(alreadyPicked.map((a) => String(a._id)));
  for (const match of text.matchAll(MENTION)) {
    const raw = (match[1] ?? "").trim().toLowerCase();
    if (!raw) continue;
    const key = resolveRoleKey(raw);
    const agent =
      (key ? pool.find((a) => resolveRoleKey(a.role) === key) : undefined) ??
      pool.find((a) => a.name.trim().toLowerCase() === raw);
    if (!agent || taken.has(String(agent._id))) continue;
    taken.add(String(agent._id));
    targets.push(agent);
  }
  return targets;
}
