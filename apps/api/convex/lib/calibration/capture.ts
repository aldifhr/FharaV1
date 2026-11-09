/**
 * Decision Outcome Calibration — capture. One orchestrator decision per
 * qualifying task event, derived deterministically from the event the
 * worker/backend already writes (no new decision path, no LLM).
 *
 * The same function serves the live hook (orchestration.logEvent,
 * recordDelegation, plan.created) and the backfill, so a decision row is
 * identified by its `dedupeKey` and recording it twice is a no-op.
 *
 * Pure: no Convex APIs. Payloads are `v.any()`; nothing here may throw.
 */

export const DECISION_TYPES = [
  "plan",
  "routing",
  "delegation",
  "replan",
  "escalation",
  "qa_loop",
  "review_loop",
  "engine",
] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];

export const DECISION_TYPE_LABELS: Record<DecisionType, string> = {
  plan: "Plan",
  routing: "Routing",
  delegation: "Delegation",
  replan: "Replan",
  escalation: "Escalation",
  qa_loop: "QA loop",
  review_loop: "Review loop",
  engine: "Decision engine",
};

/** Event types that carry a decision (everything else is ignored). */
export const DECISION_EVENT_TYPES = new Set([
  "plan.created",
  "subtask.routed",
  "orchestrator.delegation",
  "plan.replan_diff",
  "subtask.escalated",
  "qa.fix_started",
  "qa.loop_stopped",
  "review.fix_started",
  "review.loop_stopped",
  "stall.repeated_output",
  "orchestrator.decision",
]);

export interface CaptureEvent {
  id: string;
  taskId: string;
  type: string;
  payload?: unknown;
  subtaskKey?: string | null;
  agentId?: string | null;
  createdAt: number;
}

export interface CaptureContext {
  /** Other enabled agents declaring the capability (exact match), excluding `chosen`. */
  alternativesFor?: (capability: string, chosen: string) => string[];
}

export interface DecisionDraft {
  dedupeKey: string;
  type: DecisionType;
  subtaskKey?: string;
  chosen: string;
  alternatives: string[];
  reason?: string;
  agentName?: string;
  capability?: string;
  role?: string;
  planVersion?: number;
  /** Small structured extras (loadAware, performance, iteration…). */
  meta?: Record<string, unknown>;
  decidedAt: number;
}

const TEXT_CAP = 500;

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function str(value: unknown, cap = TEXT_CAP): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, cap) : undefined;
}
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function strings(value: unknown, limit = 20): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, limit) : [];
}

const ESCALATION_ROUTES = ["replan", "ask_user"];
const DELEGATION_DECISIONS = ["APPROVE", "REJECT", "REVISE", "COMPLETE", "BLOCKED"];

/** The decision an event records, or null when it records none. */
export function decisionFromEvent(event: CaptureEvent, context: CaptureContext = {}): DecisionDraft | null {
  if (!DECISION_EVENT_TYPES.has(event.type)) return null;
  const p = obj(event.payload);
  const key = str(p.subtaskKey, 120) ?? str(event.subtaskKey, 120);
  const base = { decidedAt: event.createdAt };
  const evKey = (type: DecisionType) => `${event.taskId}:${type}:ev:${event.id}`;

  switch (event.type) {
    case "plan.created": {
      // A user's own plan edit is a human decision, not the orchestrator's.
      if (p.createdBy === "user") return null;
      const version = num(p.version);
      if (version === undefined) return null;
      const subtasks = strings(p.subtasks, 50);
      return {
        ...base,
        dedupeKey: `${event.taskId}:plan:v${version}`,
        type: "plan",
        chosen: `v${version} ${str(p.strategy, 40) ?? "plan"} (${subtasks.length} subtask${subtasks.length === 1 ? "" : "s"})`,
        alternatives: [],
        reason: p.createdBy === "fallback" ? "Deterministic fallback plan" : str(p.reason),
        planVersion: version,
        meta: { createdBy: str(p.createdBy, 20) ?? "orchestrator", subtasks },
      };
    }
    case "subtask.routed": {
      const agent = str(p.agent, 120);
      if (!key || !agent) return null;
      const capability = str(p.capability, 120) ?? "";
      const loadAware = obj(p.loadAware);
      const alternatives = new Set(context.alternativesFor?.(capability, agent) ?? []);
      const from = str(loadAware.from, 120);
      if (from && from !== agent) alternatives.add(from);
      const reasons = [
        p.match === "fallback" ? `No agent declares ${capability}; closest available` : `Declares ${capability}`,
        str(loadAware.reason, 300),
        // perf-routing (when it lands) may attach a performance pick reason.
        str(obj(p.performance).reason, 300),
      ].filter(Boolean);
      const meta: Record<string, unknown> = { match: str(p.match, 20) ?? "exact" };
      if (Object.keys(loadAware).length > 0) meta.loadAware = loadAware;
      if (p.performance && typeof p.performance === "object") meta.performance = p.performance;
      return {
        ...base,
        // Retries re-route the same node to the same agent: one decision.
        dedupeKey: `${event.taskId}:routing:${key}:${agent}`,
        type: "routing",
        subtaskKey: key,
        chosen: agent,
        alternatives: [...alternatives].slice(0, 10),
        reason: reasons.join(" · ").slice(0, TEXT_CAP),
        agentName: agent,
        capability,
        role: str(p.role, 60),
        meta,
      };
    }
    case "orchestrator.delegation": {
      const decision = str(p.decision, 20);
      if (!decision) return null;
      return {
        ...base,
        dedupeKey: evKey("delegation"),
        type: "delegation",
        ...(key ? { subtaskKey: key } : {}),
        chosen: decision,
        alternatives: DELEGATION_DECISIONS.filter((d) => d !== decision),
        reason: str(p.reason),
        capability: str(p.capability, 120),
      };
    }
    case "plan.replan_diff": {
      const from = num(p.fromVersion);
      const to = num(p.toVersion);
      if (from === undefined || to === undefined) return null;
      const failed = strings(p.failed);
      return {
        ...base,
        dedupeKey: `${event.taskId}:replan:v${from}-v${to}`,
        type: "replan",
        chosen: `v${from} → v${to}`,
        alternatives: ["fail the task", "ask the user"],
        reason: failed.length > 0 ? `Failed: ${failed.join(", ")}` : undefined,
        planVersion: to,
        meta: {
          fromVersion: from,
          toVersion: to,
          failed,
          impact: strings(p.impact),
          added: strings(p.added),
          modified: strings(p.modified),
          removed: strings(p.removed),
          attempts: num(p.attempts) ?? 1,
        },
      };
    }
    case "subtask.escalated": {
      const route = str(p.route, 20);
      if (!route) return null;
      return {
        ...base,
        dedupeKey: evKey("escalation"),
        type: "escalation",
        ...(key ? { subtaskKey: key } : {}),
        chosen: route,
        alternatives: ESCALATION_ROUTES.filter((r) => r !== route),
        reason: [str(p.kind, 40), str(p.reason)].filter(Boolean).join(": ") || undefined,
        meta: { kind: str(p.kind, 40), repeated: p.repeated === true },
      };
    }
    case "qa.fix_started":
    case "review.fix_started": {
      const loop = event.type.startsWith("qa") ? "qa" : "review";
      const iteration = num(p.iteration);
      return {
        ...base,
        dedupeKey: evKey(`${loop}_loop` as DecisionType),
        type: `${loop}_loop` as DecisionType,
        chosen: "continue",
        alternatives: ["stop"],
        reason: `${num(p.findings) ?? "?"} finding(s); fix round ${iteration ?? "?"}`,
        agentName: str(p.agent, 120),
        meta: { iteration, findings: num(p.findings) },
      };
    }
    case "qa.loop_stopped":
    case "review.loop_stopped": {
      const loop = event.type.startsWith("qa") ? "qa" : "review";
      return {
        ...base,
        dedupeKey: evKey(`${loop}_loop` as DecisionType),
        type: `${loop}_loop` as DecisionType,
        chosen: "stop",
        alternatives: ["continue"],
        reason: str(p.reason) ?? "Fix rounds exhausted",
        meta: { stopReason: "max_iterations", iteration: num(p.iteration), findings: num(p.findings) },
      };
    }
    case "stall.repeated_output": {
      const detail = obj(p.detail);
      const loop = str(detail.loop, 20);
      if (loop !== "qa" && loop !== "review") return null;
      return {
        ...base,
        dedupeKey: evKey(`${loop}_loop` as DecisionType),
        type: `${loop}_loop` as DecisionType,
        chosen: "stop",
        alternatives: ["continue"],
        reason: str(p.reason) ?? "Same output on unchanged code",
        meta: { stopReason: "repeated_output", count: num(detail.count) },
      };
    }
    case "orchestrator.decision": {
      const action = str(p.action, 40);
      if (!action) return null;
      return {
        ...base,
        dedupeKey: evKey("engine"),
        type: "engine",
        ...(key ? { subtaskKey: key } : {}),
        chosen: str(p.target, 120) ? `${action} → ${str(p.target, 120)}` : action,
        alternatives: [],
        reason: str(p.reasoning),
        planVersion: num(p.planVersion),
        meta: {
          action,
          target: str(p.target, 120) ?? null,
          decidedBy: str(p.decidedBy, 40),
          expectedOutcome: str(p.expectedOutcome, 200) ?? null,
          step: num(p.step),
        },
      };
    }
  }
  return null;
}
