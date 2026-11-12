/**
 * The task's routing hint on the worker side (P1a). Chat already decided who
 * owns a request, its kind and the files it names; the hint carries that
 * onto the task (tasks.routingHint) and the planner starts from it:
 *
 * - classification: the hint's kind replaces the text guess for the soft
 *   kinds (code_change / research / audit), so the worker does not re-decide
 *   what chat already decided. The text classifier's hard rules still win: a
 *   run request, an explicit "do not change code", a vague bug hunt, a
 *   greeting, a multi-concern change. A hint never turns a change into a
 *   read-only kind (a Create task offer is a write request; losing the
 *   change would be worse than planning one the user did not need).
 * - the planning prompt gets one short "Routing hint (prior)" block.
 * - a conversation-only reply goes to the hint's role before the domain
 *   matcher runs (plannerAgent.conversationReplyCapability).
 * - when the plan's Response Owner differs from a soft hint's role the runner
 *   logs plan.hint_overridden (no chat message).
 *
 * A hint is a prior, never a mandate; only `hard` (an explicit @mention)
 * binds, and that binding is the task's agent pool, as before.
 */
import { CAPABILITY, type Classification, type ExecutionPlan } from "@/types";
import { ROLES, isRoleKey } from "@/api/convex/lib/roles";
import { readRoutingHint, type RoutingHint } from "@/api/convex/lib/routingHint";
import { isExplicitNoCode } from "./classifier";

export { routingHintPromptLines } from "@/prompts/routingHint";

export type { RoutingHint };

/** The routing hint stored on a task row, if any. */
export function taskRoutingHint(task: unknown): RoutingHint | null {
  return readRoutingHint((task as { routingHint?: unknown } | null)?.routingHint);
}

/** Chat intent subtype → task kind. Subtypes with no clear kind ("other") map to nothing. */
const KIND_OF_SUBTYPE: Record<string, Classification["kind"]> = {
  implementation: "code_change",
  debugging: "code_change",
  testing: "code_change",
  research: "research",
  explanation: "research",
  recommendation: "research",
  audit: "audit",
};

/** The kind a hint asks for, or null. */
export function hintedKind(hint: RoutingHint | null | undefined): Classification["kind"] | null {
  return hint?.kind ? KIND_OF_SUBTYPE[hint.kind] ?? null : null;
}

/** The role's own first capability ("frontend" → frontend-development), or null. */
export function capabilityOfRole(role: string | undefined): string | null {
  return role && isRoleKey(role) ? ROLES[role].capabilities[0] ?? null : null;
}

/**
 * The task's classification with the hint applied. `base` is the text
 * classifier's result (still computed for complexity, concerns and the
 * hard rules).
 */
export function applyRoutingHint(base: Classification, command: string, hint: RoutingHint | null | undefined): Classification {
  if (!hint) return base;
  const hardRule =
    base.kind === "command" || base.kind === "conversation" || base.kind === "multi" || base.investigation === true || isExplicitNoCode(command);
  const kind = hintedKind(hint);
  const roleCapability = capabilityOfRole(hint.role);
  const capabilities = (lead: string[]) => Array.from(new Set([...lead, ...base.suggestedCapabilities]));
  if (hardRule || !kind || kind === base.kind || base.kind === "code_change") {
    if (hardRule || !roleCapability) return base;
    return { ...base, suggestedCapabilities: capabilities([roleCapability]), reasons: [...base.reasons, `routing hint: owner ${hint.role}`] };
  }
  const lead = kind === "audit" ? [CAPABILITY.CODE_REVIEW] : kind === "research" ? [CAPABILITY.RESEARCH] : [];
  return {
    kind,
    strategy: "single",
    reasons: [...base.reasons, `routing hint: ${hint.kind} from chat (${hint.source})`],
    suggestedCapabilities: capabilities([...(roleCapability ? [roleCapability] : []), ...lead]),
    // Complexity and concerns describe a change; a read-only kind carries none.
    ...(kind === "code_change" && base.complexity ? { complexity: base.complexity } : {}),
    ...(kind === "code_change" && base.concerns ? { concerns: base.concerns } : {}),
  };
}

/**
 * The plan.hint_overridden payload when a soft hint's role is not the plan's
 * Response Owner, else null. A hard hint is never "overridden" (the pool
 * enforces it).
 */
export function hintOverride(plan: Pick<ExecutionPlan, "responseOwner">, hint: RoutingHint | null | undefined): { hinted: string; planned: string; source: string } | null {
  if (!hint?.role || hint.hard || !plan.responseOwner) return null;
  if (plan.responseOwner === hint.role) return null;
  return { hinted: hint.role, planned: plan.responseOwner, source: hint.source };
}
