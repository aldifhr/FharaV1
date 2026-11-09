/**
 * Intent & Routing Inspector: a read-only extraction of how one task was
 * understood and routed, built ONLY from rows the worker already records
 * (taskEvents, subtasks, delegations). Pure, so it is unit-testable and the
 * runs query stays a projection.
 *
 * Events read: task.classified, orchestrator.plan, plan.created,
 * plan.planner_fallback, plan.degraded, plan.review_*, subtask.routed,
 * orchestrator.decision, orchestrator.decision_fallback. A run re-claimed
 * after a plan review logs task.classified / orchestrator.plan again; the
 * latest of each wins.
 */
import { roleLabel } from "./roles";

export interface RoutingEventInput {
  type: string;
  payload: unknown;
  subtaskKey?: string | null;
  createdAt: number;
}

export interface RoutingSubtaskInput {
  key: string;
  title: string;
  capability: string;
  kind: string;
  dependencies: string[];
  /** Role of the assigned agent, when the subtask has one. */
  role?: string | null;
  origin?: string | null;
}

export interface RoutingDelegationInput {
  fromRole: string;
  toRole: string;
  decision: string;
  reason?: string | null;
  capability?: string | null;
  createdAt: number;
}

export interface RoutingView {
  classification: {
    kind: string | null;
    complexity: string | null;
    concerns: string[];
    reasons: string[];
    strategy: string | null;
  } | null;
  planner: {
    /** cto: the team CTO planned; fallback: the global CTO planned (planner only); heuristic: deterministic fallback plan. */
    mode: "cto" | "fallback" | "heuristic" | "unknown";
    reason: string | null;
    strategy: string | null;
    reasoning: string | null;
    planVersion: number | null;
    createdBy: string | null;
  };
  subtasks: Array<{
    key: string;
    title: string;
    capability: string;
    kind: string;
    role: string | null;
    /** exact: the agent declares the capability; fallback: routed without an exact match; null: not routed yet. */
    match: "exact" | "fallback" | null;
    /** The load-aware router moved this subtask off a busier agent (roles). */
    loadAware: { fromRole: string | null; toRole: string | null; reason: string | null } | null;
    why: string[];
  }>;
  handoffs: Array<{
    from: string;
    to: string;
    kind: "dependency" | "delegation";
    decision?: string;
    reason?: string;
  }>;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const asString = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

function latest(events: RoutingEventInput[], type: string): RoutingEventInput | undefined {
  let found: RoutingEventInput | undefined;
  for (const event of events) if (event.type === type && (!found || event.createdAt >= found.createdAt)) found = event;
  return found;
}

export function extractRouting(input: {
  events: RoutingEventInput[];
  subtasks: RoutingSubtaskInput[];
  delegations: RoutingDelegationInput[];
  /** Agent name → role, for routed events that only carry the agent name. */
  roleByAgentName: Record<string, string>;
  /** Role that planned (from usage attribution); defaults to "cto". */
  plannerRole?: string | null;
}): RoutingView {
  const events = input.events.slice().sort((a, b) => a.createdAt - b.createdAt);

  const classified = latest(events, "task.classified");
  const cp = asRecord(classified?.payload);
  const classification = classified
    ? {
        kind: asString(cp.kind),
        complexity: asString(cp.complexity),
        concerns: asStrings(cp.concerns),
        reasons: asStrings(cp.reasons),
        strategy: asString(cp.strategy),
      }
    : null;

  const orchestratorPlan = asRecord(latest(events, "orchestrator.plan")?.payload);
  const planCreated = asRecord(latest(events, "plan.created")?.payload);
  const fallback = latest(events, "plan.planner_fallback");
  const degraded = latest(events, "plan.degraded");
  let mode: RoutingView["planner"]["mode"] = "unknown";
  let reason: string | null = null;
  if (degraded) {
    mode = "heuristic";
    reason = asString(asRecord(degraded.payload).reason);
  } else if (fallback) {
    const fp = asRecord(fallback.payload);
    mode = fp.planner ? "fallback" : "heuristic";
    reason = asString(fp.reason);
  } else if (Object.keys(orchestratorPlan).length > 0 || Object.keys(planCreated).length > 0) {
    mode = asString(planCreated.createdBy) === "fallback" ? "heuristic" : "cto";
  }
  const planner = {
    mode,
    reason,
    strategy: asString(orchestratorPlan.strategy) ?? asString(planCreated.strategy),
    reasoning: asString(orchestratorPlan.reasoning),
    planVersion: typeof planCreated.version === "number" ? planCreated.version : null,
    createdBy: asString(planCreated.createdBy),
  };

  const routedByKey = new Map<string, Record<string, unknown>>();
  const decisionsByKey = new Map<string, string[]>();
  for (const event of events) {
    const payload = asRecord(event.payload);
    const key = asString(payload.subtaskKey) ?? event.subtaskKey ?? null;
    if (!key) continue;
    if (event.type === "subtask.routed") routedByKey.set(key, payload); // latest attempt wins
    if (event.type === "orchestrator.decision" || event.type === "orchestrator.decision_fallback") {
      const action = asString(payload.action);
      const text = asString(payload.reasoning) ?? asString(payload.reason);
      const line =
        event.type === "orchestrator.decision_fallback"
          ? `Decision fallback: ${text ?? "request refused"}`
          : `Decision: ${action ?? "?"}${text ? ` — ${text}` : ""}`;
      const list = decisionsByKey.get(key) ?? [];
      if (!list.includes(line)) list.push(line);
      decisionsByKey.set(key, list);
    }
  }

  const roleByKey = new Map<string, string | null>();
  const subtasks = input.subtasks.map((subtask) => {
    const routed = routedByKey.get(subtask.key);
    const agentName = routed ? asString(routed.agent) : null;
    const role =
      (routed ? asString(routed.role) : null) ??
      (agentName ? input.roleByAgentName[agentName] ?? null : null) ??
      subtask.role ??
      null;
    roleByKey.set(subtask.key, role);
    let match: "exact" | "fallback" | null = null;
    const why: string[] = [];
    const la = asRecord(routed?.loadAware);
    const loadAware =
      Object.keys(la).length > 0
        ? {
            fromRole: asString(la.fromRole) ?? asString(la.from),
            toRole: asString(la.toRole) ?? asString(la.to),
            reason: asString(la.reason),
          }
        : null;
    if (routed) {
      const capability = asString(routed.capability) ?? subtask.capability;
      const declared = asStrings(routed.capabilities).map((c) => c.toLowerCase());
      const explicit = asString(routed.match);
      match =
        explicit === "exact" || explicit === "fallback"
          ? explicit
          : declared.includes(capability.toLowerCase())
            ? "exact"
            : "fallback";
      why.push(
        match === "exact"
          ? `Declares ${capability}`
          : `No agent declares ${capability}; routed to the closest available agent`
      );
    }
    if (loadAware) {
      why.push(`Load-aware: moved off ${loadAware.fromRole ? roleLabel(loadAware.fromRole) : "a busier agent"}${loadAware.reason ? ` — ${loadAware.reason}` : ""}`);
    }
    if (subtask.origin && subtask.origin !== "planned" && subtask.origin !== "plan") {
      why.push(`Added during the run (${subtask.origin.replace(/_/g, " ")})`);
    }
    why.push(...(decisionsByKey.get(subtask.key) ?? []).slice(-2));
    return {
      key: subtask.key,
      title: subtask.title,
      capability: subtask.capability,
      kind: subtask.kind,
      role,
      match,
      loadAware,
      why,
    };
  });

  const handoffs: RoutingView["handoffs"] = [];
  const seen = new Set<string>();
  const plannerRole = (input.plannerRole ?? "cto").toLowerCase();
  const push = (h: RoutingView["handoffs"][number]) => {
    if (!h.from || !h.to || h.from === h.to) return;
    const key = `${h.kind}:${h.from}->${h.to}:${h.reason ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    handoffs.push(h);
  };
  for (const subtask of input.subtasks) {
    const to = roleByKey.get(subtask.key);
    if (!to) continue;
    if (subtask.dependencies.length === 0) push({ from: plannerRole, to, kind: "dependency" });
    for (const dep of subtask.dependencies) {
      const from = roleByKey.get(dep);
      if (from) push({ from, to, kind: "dependency" });
    }
  }
  for (const d of input.delegations.slice().sort((a, b) => a.createdAt - b.createdAt)) {
    push({
      from: d.fromRole,
      to: d.toRole,
      kind: "delegation",
      decision: d.decision,
      ...(d.reason ? { reason: d.reason } : {}),
    });
  }

  return { classification, planner, subtasks, handoffs };
}
