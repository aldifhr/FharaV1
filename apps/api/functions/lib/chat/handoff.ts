/**
 * Structured CTO/Lead handoffs. The model returns one JSON object with a
 * verbatim `message` and a bounded list of `{ role, instruction }` entries;
 * roles come from the shared `ROLE_KEYS` enum. Nothing here reads role names
 * out of free text.
 */
import { resolveRoleKey, type RoleKey } from "../roles";

export type HandoffEntry = { role: RoleKey; instruction: string };
export type StructuredReply = { message: string; handoff: HandoffEntry[] };

export const MAX_HANDOFFS = 3;
const MAX_INSTRUCTION_CHARS = 400;

/** Literal-only normalisation: no regex, just word tokens. */
function normaliseWords(value: string): string {
  return value.trim().toLowerCase().split(" ").filter(Boolean).join(" ");
}

/** A long user request copied verbatim into a handoff is a failed handoff. */
export function echoedRequest(instruction: string, userRequest: string): boolean {
  return userRequest.trim().length > 60 && normaliseWords(instruction) === normaliseWords(userRequest);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict validation of one LLM JSON reply; null means "not valid". */
export function parseStructuredReply(raw: string): StructuredReply | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.message !== "string" || !parsed.message.trim()) return null;
  if (!Array.isArray(parsed.handoff) || parsed.handoff.length > MAX_HANDOFFS) return null;
  const handoff: HandoffEntry[] = [];
  for (const item of parsed.handoff) {
    if (!isRecord(item) || typeof item.role !== "string" || typeof item.instruction !== "string") return null;
    // The same resolver the registry, the seed and the web app use: a title
    // ("Backend Developer") or a retired alias ("support") maps to its roster
    // role. Only a name the registry does not know invalidates the reply.
    const role = resolveRoleKey(item.role);
    const instruction = item.instruction.trim();
    if (!role || !instruction || instruction.length > MAX_INSTRUCTION_CHARS) return null;
    if (handoff.some((entry) => entry.role === role)) continue;
    handoff.push({ role, instruction });
  }
  return { message: parsed.message, handoff };
}

/** The team member that owns each handoff role, in model order; the speaker is excluded. */
export function resolveHandoffTargets<T extends { _id: string; role: string }>(
  handoff: HandoffEntry[],
  team: T[],
  speakerId?: string
): Array<{ agent: T; instruction: string }> {
  const targets: Array<{ agent: T; instruction: string }> = [];
  for (const entry of handoff) {
    const agent = team.find((member) => resolveRoleKey(member.role) === entry.role && String(member._id) !== String(speakerId ?? ""));
    if (agent) targets.push({ agent, instruction: entry.instruction });
  }
  return targets;
}

/** Roles in a validated handoff that the current team cannot answer. */
export function unmatchedHandoffRoles<T extends { role: string }>(handoff: HandoffEntry[], team: T[]): RoleKey[] {
  return handoff.filter((entry) => !team.some((member) => resolveRoleKey(member.role) === entry.role)).map((entry) => entry.role);
}
