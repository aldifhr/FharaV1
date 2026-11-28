import { resolveRoleKey } from "@/api/functions/lib/roles";
import { type AgentDefinition } from "@/types";
import { capabilitiesOf } from "@/utils/agentCapabilities";
import { isAgentEnabled } from "./capabilities";

export interface CtoDecision {
  role: string;
  capability: string;
  reason: string;
  answerSelf?: boolean;
}

export type CtoDecisionCode =
  | "unknown_role"
  | "unavailable_role"
  | "no_capability";

export type CtoDecisionValidation =
  | { ok: true; agent: AgentDefinition; capability: string }
  | { ok: false; code: CtoDecisionCode; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCtoDecision(raw: unknown): CtoDecision | null {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  const role = value.role;
  const capability = value.capability;
  const reason = value.reason;
  if (typeof role !== "string" || !role.trim()) return null;
  if (typeof capability !== "string" || !capability.trim()) return null;
  if (typeof reason !== "string" || !reason.trim()) return null;
  if (value.answerSelf !== undefined && typeof value.answerSelf !== "boolean") return null;
  return {
    role: role.trim(),
    capability: capability.trim(),
    reason: reason.trim(),
    ...(value.answerSelf === true ? { answerSelf: true as const } : {}),
  };
}

export function validateCtoDecision(
  decision: CtoDecision,
  agents: readonly AgentDefinition[]
): CtoDecisionValidation {
  if (decision.answerSelf === true) {
    const cto = agents.find((agent) => isAgentEnabled(agent) && resolveRoleKey(agent.role) === "cto");
    return cto
      ? { ok: true, agent: cto, capability: decision.capability }
      : { ok: false, code: "unavailable_role", reason: "No enabled CTO in this team" };
  }

  const key = resolveRoleKey(decision.role);
  if (!key) {
    return { ok: false, code: "unknown_role", reason: `Role "${decision.role}" is not in the registry` };
  }
  const candidates = agents.filter((agent) => resolveRoleKey(agent.role) === key && isAgentEnabled(agent));
  if (candidates.length === 0) {
    return { ok: false, code: "unavailable_role", reason: `No enabled agent for role "${decision.role}"` };
  }
  const agent =
    candidates.find((candidate) => capabilitiesOf(candidate).includes(decision.capability)) ?? null;
  if (!agent) {
    return {
      ok: false,
      code: "no_capability",
      reason: `Role "${decision.role}" does not declare capability "${decision.capability}"`,
    };
  }
  return { ok: true, agent, capability: decision.capability };
}
