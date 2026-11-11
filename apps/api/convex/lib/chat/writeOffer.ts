/**
 * The Create task offer for a chat reply to a write request (create or change
 * files). Pure: no Convex or Node APIs.
 *
 * Chat never writes files and never starts a task by itself: a write request
 * gets a short reply plus this offer (messages.taskOffer), and the Create task
 * button or a bare "gas"/"lanjut" starts it. Only the speaker the message
 * was for offers: an @mentioned agent, or the owner System routed the
 * message to (O3: routed = addressed). The offer names its assignee:
 * an addressed code role (Frontend, Backend, DevOps) takes its own request;
 * otherwise the role the request's files belong to ("ultimate.html" →
 * Frontend), when the team has one.
 */
import { codeRoleForRequest, wantsCodeInChat, type ChatTaskOffer } from "./intent";
import { isCodeWritingRole, normalizeRoleKey } from "../roles";
import { buildOfferBrief, inferStack, offerPlanLine, replyNeedsTask } from "./offerBrief";

export interface WriteOfferPlan<A> {
  /** The offer to store on the reply, or null (no offer from this speaker). */
  offer: ChatTaskOffer | null;
  /** Who the task goes to, for the reply prompt ("Frontend"). */
  assignee: A | null;
  /** The user asked to see the code in chat. */
  codeInChat: boolean;
  /** The one-line plan the reply states ("I'll add a plain HTML index.html at the repo root."), when the request names a file. */
  plan: string | null;
  /**
   * The offer to attach when the classifier read the message as chat but the
   * reply found it needs file writes (offerForReply). Null for option picks,
   * run requests and speakers the user did not address.
   */
  fallback: ChatTaskOffer | null;
}

export function planWriteOffer<A extends { _id: string; name: string; role: string }>(opts: {
  speaker: A;
  isCto: boolean;
  /** The user @mentioned this speaker, or System routed the message to it. */
  addressed: boolean;
  team: A[];
  text: string;
  taskIntent: { kind: string; subtype?: string; runCommands?: string[] };
  optionPick: boolean;
  /** What the speaker can see of the repo (snapshot text), for the stack and the brief. */
  repoSnapshot?: string | null;
}): WriteOfferPlan<A> {
  const codeInChat = wantsCodeInChat(opts.text);
  const plan = offerPlanLine(opts.text, inferStack(opts.repoSnapshot));
  const brief = buildOfferBrief(opts.text, plan);
  const none: WriteOfferPlan<A> = { offer: null, assignee: null, codeInChat, plan, fallback: null };
  if (opts.optionPick || !opts.addressed) return none;
  const runCommands = opts.taskIntent.runCommands;
  const byFiles = codeRoleForRequest(opts.text);
  const roleAgent = byFiles ? opts.team.find((a) => normalizeRoleKey(a.role) === byFiles) ?? null : null;
  const assignee = !opts.isCto && isCodeWritingRole(opts.speaker.role) ? opts.speaker : roleAgent;
  if (opts.taskIntent.kind !== "task") {
    if (runCommands?.length) return none;
    const fallback: ChatTaskOffer = { kind: "implementation", ...(assignee ? { assigneeAgentId: String(assignee._id) } : {}), ...(brief ? { brief } : {}) };
    return { ...none, fallback };
  }
  const offer: ChatTaskOffer = {
    kind: opts.taskIntent.subtype ?? "implementation",
    ...(runCommands?.length ? { commands: runCommands } : {}),
    ...(assignee && !runCommands?.length ? { assigneeAgentId: String(assignee._id) } : {}),
    ...(brief && !runCommands?.length ? { brief } : {}),
  };
  return { offer, assignee: runCommands?.length ? null : assignee, codeInChat, plan: runCommands?.length ? null : plan, fallback: null };
}

/**
 * The offer stored on a finished reply: the planned one, else the fallback
 * when the reply itself says the request needs file writes ("Chat can't
 * change files. Want me to create a task for it?"). A greeting or a plain
 * answer stores none.
 */
export function offerForReply(write: { offer: ChatTaskOffer | null; fallback: ChatTaskOffer | null }, reply: string): ChatTaskOffer | null {
  if (write.offer) return write.offer;
  return write.fallback && replyNeedsTask(reply) ? write.fallback : null;
}
