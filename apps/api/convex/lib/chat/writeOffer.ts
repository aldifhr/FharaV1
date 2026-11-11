/**
 * The Create task offer for a chat reply to a write request (create or change
 * files). Pure: no Convex or Node APIs.
 *
 * Chat never writes files and never starts a task by itself: a write request
 * gets a short reply plus this offer (messages.taskOffer), and the Create task
 * button or a bare "gas"/"lanjut" starts it. The offer names its assignee:
 * an @mentioned code role (Frontend, Backend, DevOps) takes its own request;
 * otherwise the role the request's files belong to ("ultimate.html" →
 * Frontend), when the team has one.
 */
import { codeRoleForRequest, wantsCodeInChat, type ChatTaskOffer } from "./intent";
import { isCodeWritingRole, normalizeRoleKey } from "../roles";

export interface WriteOfferPlan<A> {
  /** The offer to store on the reply, or null (no offer from this speaker). */
  offer: ChatTaskOffer | null;
  /** Who the task goes to, for the reply prompt ("Frontend"). */
  assignee: A | null;
  /** The user asked to see the code in chat. */
  codeInChat: boolean;
}

export function planWriteOffer<A extends { _id: string; name: string; role: string }>(opts: {
  speaker: A;
  isCto: boolean;
  /** The user @mentioned this speaker (a teammate offers only then). */
  addressed: boolean;
  team: A[];
  text: string;
  taskIntent: { kind: string; subtype?: string; runCommands?: string[] };
  optionPick: boolean;
}): WriteOfferPlan<A> {
  const codeInChat = wantsCodeInChat(opts.text);
  const none: WriteOfferPlan<A> = { offer: null, assignee: null, codeInChat };
  if (opts.optionPick || opts.taskIntent.kind !== "task") return none;
  if (!opts.isCto && !opts.addressed) return none;
  const runCommands = opts.taskIntent.runCommands;
  const byFiles = codeRoleForRequest(opts.text);
  const roleAgent = byFiles ? opts.team.find((a) => normalizeRoleKey(a.role) === byFiles) ?? null : null;
  const assignee = !opts.isCto && isCodeWritingRole(opts.speaker.role) ? opts.speaker : roleAgent;
  const offer: ChatTaskOffer = {
    kind: opts.taskIntent.subtype ?? "implementation",
    ...(runCommands?.length ? { commands: runCommands } : {}),
    ...(assignee && !runCommands?.length ? { assigneeAgentId: String(assignee._id) } : {}),
  };
  return { offer, assignee: runCommands?.length ? null : assignee, codeInChat };
}
