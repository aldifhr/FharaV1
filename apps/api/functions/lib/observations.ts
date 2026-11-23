/**
 * Execution Observation Engine (plan 025). Pure TypeScript, shared by the
 * backend (observations are derived from the events the run already
 * writes and stored in `executionObservations`), the worker (the decision
 * engine receives the same typed observations) and the web UI.
 *
 * Observations are DETERMINISTIC: each one is a mapping of an existing
 * fact (an execution settling, a verification check, a QA verdict, an
 * acceptance result, a scope check, a blocked dependency). No LLM is
 * involved in producing them.
 */

export const OBSERVATION_TYPES = [
  "agent_completed",
  "agent_failed",
  "test_failed",
  "gate_failed",
  "scope_violation",
  "no_progress",
  "dependency_blocked",
  "provider_error",
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

export interface ObservationSource {
  agentId?: string;
  subtaskKey?: string;
  /** The tool / stage that produced the fact (verify:test, qa, acceptance, native, apply_changes, …). */
  tool?: string;
}

export interface ObservationFacts {
  affectedFiles?: string[];
  errorCode?: string;
  findings?: string[];
}

export interface ExecutionObservation {
  eventType: ObservationType;
  source: ObservationSource;
  facts: ObservationFacts;
  /** Pointers to the evidence: `event:<type>`, `execution:<id>`, `gate:<subtask>/<gate>`. */
  evidenceRefs: string[];
  observedAt: number;
}

export interface ObservableEvent {
  type: string;
  payload?: unknown;
  subtaskKey?: string;
  executionId?: string;
  agentId?: string;
  createdAt?: number;
}

const MAX_FINDINGS = 10;
const MAX_FILES = 50;
const FINDING_MAX = 300;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strings(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry : str(record(entry).filePath) ?? str(record(entry).path) ?? str(record(entry).message) ?? str(record(entry).title) ?? str(record(entry).details)))
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => entry.slice(0, FINDING_MAX))
    .slice(0, max);
}

/**
 * Provider failure classification from an error text: rate limits, auth
 * failures and 5xx / network errors of an LLM provider. Returns the error
 * code, or null when the text does not look like a provider failure.
 */
export function providerErrorCode(error: string | undefined): string | null {
  if (!error) return null;
  const text = error.toLowerCase();
  if (/\b429\b|rate.?limit|too many requests|quota/.test(text)) return "rate_limited";
  if (/\b(401|403)\b|invalid api key|unauthori[sz]ed|incorrect api key/.test(text)) return "auth";
  if (/\b5\d\d\b|bad gateway|service unavailable|overloaded|internal server error/.test(text)) return "provider_5xx";
  if (/econnreset|econnrefused|etimedout|enotfound|fetch failed|socket hang up|network error/.test(text)) return "network";
  if (/\b(provider|llm|model)\b.*\b(error|failed|unavailable)\b|circuit (breaker )?open|decrypt/.test(text)) return "provider";
  return null;
}

function timedOut(error: string | undefined): boolean {
  return Boolean(error && /timed out|timeout|deadline exceeded/i.test(error));
}

/**
 * Map one event to the observations it carries (usually zero or one).
 * The mapping is a fixed table over the run's existing event vocabulary:
 *
 * | event                                   | observation                         |
 * | --------------------------------------- | ----------------------------------- |
 * | subtask.completed                       | agent_completed                     |
 * | subtask.failed                          | provider_error / no_progress (timeout) / agent_failed |
 * | task.check (verify:*, failed)           | test_failed (test) / gate_failed    |
 * | qa.failed                               | test_failed (tool qa)               |
 * | acceptance.evaluated (rejected entries) | gate_failed, one per subtask        |
 * | native.change.rejected, permission.denied, subtask.escalated (out_of_scope) | scope_violation |
 * | subtask.blocked                         | dependency_blocked                  |
 * | stall.dependency_deadlock / stall.no_runnable_nodes | dependency_blocked       |
 * | stall.agent_stalled / stall.repeated_output | no_progress                     |
 * | stall.provider_unavailable              | provider_error                      |
 * | task.stalled / *.no_progress            | no_progress                         |
 */
export function observationsFromEvent(event: ObservableEvent, now = Date.now()): ExecutionObservation[] {
  const payload = record(event.payload);
  const observedAt = event.createdAt ?? now;
  const subtaskKey = event.subtaskKey ?? str(payload.subtaskKey);
  const refs = [`event:${event.type}`, ...(event.executionId ? [`execution:${event.executionId}`] : [])];
  const source = (tool?: string): ObservationSource => ({
    ...(event.agentId ? { agentId: event.agentId } : {}),
    ...(subtaskKey ? { subtaskKey } : {}),
    ...(tool ? { tool } : {}),
  });
  const one = (eventType: ObservationType, facts: ObservationFacts, tool?: string, extraRefs: string[] = []) => [
    { eventType, source: source(tool), facts, evidenceRefs: [...refs, ...extraRefs], observedAt },
  ];

  switch (event.type) {
    case "subtask.completed":
      return one("agent_completed", {}, "executor");
    case "subtask.failed": {
      const error = str(payload.error);
      const code = providerErrorCode(error);
      if (code) return one("provider_error", { errorCode: code, findings: error ? [error.slice(0, FINDING_MAX)] : [] }, "llm");
      if (timedOut(error)) return one("no_progress", { errorCode: "timeout", findings: error ? [error.slice(0, FINDING_MAX)] : [] }, "executor");
      return one("agent_failed", { ...(error ? { findings: [error.slice(0, FINDING_MAX)] } : {}) }, "executor");
    }
    case "task.check": {
      const label = str(payload.label) ?? "";
      if (payload.status !== "failed" || !label.startsWith("verify:")) return [];
      const name = label.slice("verify:".length);
      const details = str(payload.details);
      const isTest = /(^|[:\s-])tests?\b/i.test(name);
      return one(isTest ? "test_failed" : "gate_failed", { errorCode: name, ...(details ? { findings: [details.slice(0, FINDING_MAX)] } : {}) }, label);
    }
    case "qa.failed":
      return one("test_failed", { errorCode: "qa", findings: strings(payload.findings, MAX_FINDINGS) }, "qa");
    case "acceptance.evaluated": {
      const rejected = Array.isArray(payload.rejected) ? payload.rejected : [];
      const gatesByKey = new Map<string, string[]>();
      if (Array.isArray(payload.subtasks)) {
        for (const entry of payload.subtasks) {
          const row = record(entry);
          const key = str(row.key);
          if (!key || !Array.isArray(row.gates)) continue;
          gatesByKey.set(
            key,
            row.gates.map(record).filter((gate) => gate.status === "fail").map((gate) => String(gate.id))
          );
        }
      }
      return rejected.map(record).flatMap((entry) => {
        const key = str(entry.key);
        if (!key) return [];
        const gates = gatesByKey.get(key) ?? [];
        return [
          {
            eventType: "gate_failed" as const,
            source: { ...(event.agentId ? { agentId: event.agentId } : {}), subtaskKey: key, tool: "acceptance" },
            facts: { errorCode: gates[0] ?? "acceptance", findings: [str(entry.reason) ?? "gate failed"].map((s) => s.slice(0, FINDING_MAX)) },
            evidenceRefs: [...refs, ...gates.map((gate) => `gate:${key}/${gate}`)],
            observedAt,
          },
        ];
      });
    }
    case "native.change.rejected":
      return one("scope_violation", { affectedFiles: strings(payload.files, MAX_FILES), errorCode: "outside_allowed_paths" }, "native");
    case "permission.denied":
      return one("scope_violation", { errorCode: "permission_denied", findings: [str(payload.reason) ?? "denied"].map((s) => s.slice(0, FINDING_MAX)) }, str(payload.action) ?? "permission");
    case "subtask.escalated": {
      if (payload.kind !== "out_of_scope") return [];
      const detail = str(payload.detail);
      return one("scope_violation", { errorCode: "out_of_scope", ...(detail ? { affectedFiles: [detail] } : {}), findings: [str(payload.reason) ?? ""].filter(Boolean) }, "escalation");
    }
    case "subtask.blocked":
      return one("dependency_blocked", { findings: [str(payload.reason) ?? "blocked"].map((s) => s.slice(0, FINDING_MAX)) }, "scheduler");
    // Deadlock & stall detector (`stall.<kind>`, utils/stallDetector.ts).
    case "stall.dependency_deadlock":
    case "stall.no_runnable_nodes":
      return one("dependency_blocked", { errorCode: event.type.slice("stall.".length), findings: [str(payload.reason) ?? ""].filter(Boolean) }, "stall_detector");
    case "stall.agent_stalled":
    case "stall.repeated_output":
      return one("no_progress", { errorCode: event.type.slice("stall.".length), findings: [str(payload.reason) ?? ""].filter(Boolean) }, "stall_detector");
    case "stall.provider_unavailable":
      return one("provider_error", { errorCode: "provider_unavailable", findings: [str(payload.reason) ?? ""].filter(Boolean) }, "stall_detector");
    default:
      if (/(^|\.)(stalled|stall_detected|no_progress)$/.test(event.type) || event.type === "task.stalled") {
        return one("no_progress", { errorCode: "stalled", findings: [str(payload.reason) ?? str(payload.message) ?? ""].filter(Boolean) }, "stall_detector");
      }
      return [];
  }
}

/**
 * The observation for one settled execution, built in the worker from the
 * executor outcome (the same mapping as `subtask.completed` /
 * `subtask.failed` above, plus the files the execution staged).
 */
export function observationFromOutcome(input: {
  subtaskKey: string;
  agentId?: string;
  status: "completed" | "failed";
  error?: string;
  affectedFiles?: string[];
  executionId?: string;
  observedAt?: number;
}): ExecutionObservation {
  const [base] = observationsFromEvent(
    {
      type: input.status === "completed" ? "subtask.completed" : "subtask.failed",
      payload: { subtaskKey: input.subtaskKey, ...(input.error ? { error: input.error } : {}) },
      subtaskKey: input.subtaskKey,
      executionId: input.executionId,
      agentId: input.agentId,
      createdAt: input.observedAt,
    },
    input.observedAt
  );
  const files = (input.affectedFiles ?? []).slice(0, MAX_FILES);
  return files.length > 0 ? { ...base, facts: { ...base.facts, affectedFiles: files } } : base;
}

export const OBSERVATION_LABELS: Record<ObservationType, string> = {
  agent_completed: "Agent completed",
  agent_failed: "Agent failed",
  test_failed: "Test failed",
  gate_failed: "Gate failed",
  scope_violation: "Scope violation",
  no_progress: "No progress",
  dependency_blocked: "Dependency blocked",
  provider_error: "Provider error",
};

/** One line per observation for prompts and logs. */
export function describeObservation(observation: ExecutionObservation): string {
  const where = [observation.source.subtaskKey, observation.source.tool].filter(Boolean).join(" · ");
  const facts = [
    observation.facts.errorCode ? `code=${observation.facts.errorCode}` : "",
    observation.facts.affectedFiles?.length ? `files=${observation.facts.affectedFiles.slice(0, 5).join(",")}` : "",
    observation.facts.findings?.length ? observation.facts.findings[0].slice(0, 160) : "",
  ].filter(Boolean);
  return `${observation.eventType}${where ? ` (${where})` : ""}${facts.length ? `: ${facts.join("; ")}` : ""}`;
}
