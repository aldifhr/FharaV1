/**
 * Subtask contract, acceptance gates and escalation (plan 022). Pure
 * TypeScript (validators live in contractValidators.ts): shared by the backend (schema, plan
 * validator, plan edits, runs page), the worker (planner parser, executor,
 * acceptance stage) and the web UI. No Convex runtime, Node or DOM APIs.
 *
 * A contract tells an executor exactly what "done" means for one subtask:
 * one concrete objective, its scope (the subtask's `allowedPaths`), what it
 * must not change, the deliverable, and acceptance gates that are checked
 * AFTER the executor reports it delivered. Executor "done" is `delivered`;
 * only passing gates make a subtask `accepted`.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const ACCEPTANCE_CHECKS = ["test", "typecheck", "file_exists", "command", "review", "manual"] as const;
export type AcceptanceCheck = (typeof ACCEPTANCE_CHECKS)[number];

export interface AcceptanceGate {
  /** Stable slug within the subtask ("typecheck", "sources", "gate_2"). */
  id: string;
  /** Human-readable criterion (editable on the Plan card). */
  criterion: string;
  check: AcceptanceCheck;
  /** Check-specific target: a file path, a script name, "output", … */
  target?: string;
  /** Unset = required, except `manual` gates (a person checks them). */
  required?: boolean;
}

export interface SubtaskContract {
  objective?: string;
  constraints?: string[];
  deliverable?: string;
  acceptance?: AcceptanceGate[];
}

export type GateStatus = "pass" | "fail" | "skipped";

export interface GateEvidence {
  /** Where the evidence came from: verification | review | qa | workspace | output | none. */
  kind: string;
  /** A pointer to the evidence (check name, review subtask key, file path). */
  ref?: string;
  summary: string;
}

export interface GateResult {
  gateId: string;
  status: GateStatus;
  evidence: GateEvidence;
}

/**
 * Acceptance lifecycle of a subtask, separate from its execution status:
 * delivered (executor done, gates not evaluated yet) → accepted | rejected
 * (a required gate failed) | blocked (could not be evaluated / fix budget
 * spent) | escalated (the executor stopped and asked for a decision).
 */
export const ACCEPTANCE_STATUSES = ["delivered", "accepted", "rejected", "blocked", "escalated"] as const;
export type AcceptanceStatus = (typeof ACCEPTANCE_STATUSES)[number];

export const ESCALATION_KINDS = [
  "schema_change",
  "new_dependency",
  "security",
  "out_of_scope",
  "ambiguous",
] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];

export interface Escalation {
  kind: EscalationKind;
  reason: string;
  /** The concrete thing that triggered it (a file path, a package name). */
  detail?: string;
  /** Materially different outcomes the user could choose between. */
  options?: string[];
  /** "executor" = the model asked; "detected" = the runner's own guard. */
  source?: "executor" | "detected";
}

export const ESCALATION_LABELS: Record<EscalationKind, string> = {
  schema_change: "Schema change",
  new_dependency: "New dependency",
  security: "Security-sensitive choice",
  out_of_scope: "File outside scope",
  ambiguous: "Ambiguous requirement",
};

// ---------------------------------------------------------------------------
// Defaults (back-compat: plans without a contract still work)
// ---------------------------------------------------------------------------

/**
 * Gates derived from the kind when the planner gave none: code_change →
 * typecheck + relevant tests; research → deliverable non-empty with
 * sources; audit / analysis → deliverable non-empty; review → reviewer
 * verdict. QA and shell nodes carry their own verdicts and get none.
 */
export function defaultGatesForKind(kind: string): AcceptanceGate[] {
  switch (kind) {
    case "code_change":
      return [
        { id: "typecheck", criterion: "Typecheck passes on the changed workspace", check: "typecheck" },
        { id: "tests", criterion: "Relevant tests pass", check: "test" },
      ];
    case "research":
      return [
        { id: "deliverable", criterion: "The answer is non-empty", check: "review", target: "output" },
        { id: "sources", criterion: "The answer cites its sources (files or URLs)", check: "review", target: "output:sources" },
      ];
    case "audit":
    case "analysis":
      return [{ id: "deliverable", criterion: "The report is non-empty", check: "review", target: "output" }];
    case "review":
      return [{ id: "verdict", criterion: "The reviewer approves the diff", check: "review" }];
    default:
      return [];
  }
}

/** Whether a gate must pass for acceptance (manual gates default to optional). */
export function isRequiredGate(gate: Pick<AcceptanceGate, "check" | "required">): boolean {
  if (typeof gate.required === "boolean") return gate.required;
  return gate.check !== "manual";
}

// ---------------------------------------------------------------------------
// Parsing (planner output, stored plans, user edits)
// ---------------------------------------------------------------------------

const GATE_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const TEXT_MAX = 500;
const CRITERION_MAX = 300;
const MAX_GATES = 8;
const MAX_CONSTRAINTS = 10;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 48);
}

export interface ParsedContract {
  contract: SubtaskContract;
  errors: string[];
  /** True when the gates were derived from the kind (none were given). */
  derivedGates: boolean;
}

/**
 * Parse the contract fields of one raw subtask. Missing fields stay
 * missing (old plans); missing gates are derived from the kind. An
 * explicit gate list is validated: unknown checks, empty criteria and
 * duplicate ids are errors. Plain-string gates (a planner shortcut) become
 * optional `manual` gates; a code_change whose gates are all manual still
 * gets the default typecheck/test gates in front.
 */
export function parseContract(raw: Record<string, unknown>, kind: string, key: string): ParsedContract {
  const errors: string[] = [];
  const contract: SubtaskContract = {};
  const objective = text(raw.objective, TEXT_MAX);
  if (objective) contract.objective = objective;
  const deliverable = text(raw.deliverable, TEXT_MAX);
  if (deliverable) contract.deliverable = deliverable;

  const rawConstraints = typeof raw.constraints === "string" ? [raw.constraints] : raw.constraints;
  if (Array.isArray(rawConstraints)) {
    const constraints = rawConstraints
      .map((entry) => text(entry, CRITERION_MAX))
      .filter((entry): entry is string => Boolean(entry))
      .slice(0, MAX_CONSTRAINTS);
    if (constraints.length > 0) contract.constraints = constraints;
  } else if (rawConstraints !== undefined && rawConstraints !== null) {
    errors.push(`subtask ${key}: constraints must be a list of strings`);
  }

  const rawGates = raw.acceptance;
  if (rawGates === undefined || rawGates === null) {
    contract.acceptance = defaultGatesForKind(kind);
    return { contract, errors, derivedGates: true };
  }
  if (!Array.isArray(rawGates)) {
    errors.push(`subtask ${key}: acceptance must be a list of gates`);
    return { contract, errors, derivedGates: false };
  }
  const gates: AcceptanceGate[] = [];
  const ids = new Set<string>();
  rawGates.slice(0, MAX_GATES).forEach((entry, index) => {
    if (typeof entry === "string") {
      const criterion = text(entry, CRITERION_MAX);
      if (!criterion) return;
      let id = slug(criterion).slice(0, 24) || `gate_${index + 1}`;
      while (ids.has(id)) id = `${id}_${index + 1}`;
      ids.add(id);
      gates.push({ id, criterion, check: "manual", required: false });
      return;
    }
    if (!entry || typeof entry !== "object") {
      errors.push(`subtask ${key}: acceptance[${index}] must be an object`);
      return;
    }
    const value = entry as Record<string, unknown>;
    const criterion = text(value.criterion, CRITERION_MAX);
    if (!criterion) {
      errors.push(`subtask ${key}: acceptance[${index}].criterion is required`);
      return;
    }
    const check = typeof value.check === "string" ? value.check.trim().toLowerCase() : "";
    if (!(ACCEPTANCE_CHECKS as readonly string[]).includes(check)) {
      errors.push(`subtask ${key}: acceptance[${index}].check must be one of ${ACCEPTANCE_CHECKS.join(", ")}`);
      return;
    }
    const givenId = typeof value.id === "string" ? slug(value.id) : "";
    const id = givenId && GATE_ID.test(givenId) ? givenId : `gate_${index + 1}`;
    if (ids.has(id)) {
      errors.push(`subtask ${key}: duplicate acceptance gate id ${id}`);
      return;
    }
    ids.add(id);
    const target = text(value.target, CRITERION_MAX);
    if (check === "file_exists" && !target) {
      errors.push(`subtask ${key}: acceptance gate ${id} (file_exists) needs a target path`);
      return;
    }
    gates.push({
      id,
      criterion,
      check: check as AcceptanceCheck,
      ...(target ? { target } : {}),
      ...(typeof value.required === "boolean" ? { required: value.required } : {}),
    });
  });
  if (kind === "code_change" && gates.length > 0 && gates.every((gate) => gate.check === "manual")) {
    const defaults = defaultGatesForKind(kind).filter((gate) => !ids.has(gate.id));
    gates.unshift(...defaults);
  }
  contract.acceptance = gates;
  return { contract, errors, derivedGates: false };
}

/** The shared validator's gate rule: every code subtask has at least one gate. */
export function contractGateErrors(subtask: { key: string; kind: string; acceptance?: AcceptanceGate[] }): string[] {
  if (subtask.kind !== "code_change") return [];
  return (subtask.acceptance ?? []).length > 0
    ? []
    : [`subtask ${subtask.key}: code_change needs at least one acceptance gate`];
}

/** Contract of a stored subtask: its own fields, gates derived when absent. */
export function contractOf(subtask: {
  kind: string;
  objective?: string;
  constraints?: string[];
  deliverable?: string;
  acceptance?: AcceptanceGate[];
}): SubtaskContract & { acceptance: AcceptanceGate[] } {
  return {
    ...(subtask.objective ? { objective: subtask.objective } : {}),
    ...(subtask.constraints && subtask.constraints.length > 0 ? { constraints: subtask.constraints } : {}),
    ...(subtask.deliverable ? { deliverable: subtask.deliverable } : {}),
    acceptance: subtask.acceptance ?? defaultGatesForKind(subtask.kind),
  };
}

// ---------------------------------------------------------------------------
// Gate evaluation (maps existing verify / review / QA results to gates)
// ---------------------------------------------------------------------------

export interface VerificationEvidence {
  /** False when verification is disabled or was never run in this run. */
  ran: boolean;
  checks: Array<{ name: string; status: string; details?: string }>;
}

export interface GateEvaluationInput {
  kind: string;
  gates: AcceptanceGate[];
  /** The verification loop's last result, when it ran. */
  verification?: VerificationEvidence | null;
  /** The review verdict covering this subtask (latest review node). */
  review?: { verdict: string; reviewKey: string } | null;
  /** The subtask's own output (read-only kinds). */
  output?: string;
  /**
   * Whether a workspace-relative path exists after apply (staged files
   * count). Undefined = unknown (evaluated as skipped).
   */
  fileExists?: (path: string) => boolean | undefined;
}

/** "root:typecheck" / "web:test" → step name. */
function stepOf(name: string): string {
  const index = name.lastIndexOf(":");
  return (index >= 0 ? name.slice(index + 1) : name).trim().toLowerCase();
}

/** Verification-backed gate: pass/fail from the matching checks, skipped when none ran. */
function fromVerification(
  gate: AcceptanceGate,
  steps: string[],
  verification: VerificationEvidence | null | undefined
): GateResult {
  if (!verification || !verification.ran) {
    return {
      gateId: gate.id,
      status: "skipped",
      evidence: { kind: "none", summary: "Verification did not run in this run" },
    };
  }
  const matching = verification.checks.filter((check) => steps.includes(stepOf(check.name)));
  const ran = matching.filter((check) => check.status === "passed" || check.status === "failed");
  if (ran.length === 0) {
    return {
      gateId: gate.id,
      status: "skipped",
      evidence: {
        kind: "verification",
        summary: `No ${steps.join("/")} script in the workspace`,
      },
    };
  }
  const failed = ran.filter((check) => check.status === "failed");
  if (failed.length > 0) {
    return {
      gateId: gate.id,
      status: "fail",
      evidence: {
        kind: "verification",
        ref: failed.map((check) => check.name).join(", "),
        summary: (failed[0].details ?? "check failed").slice(0, 300),
      },
    };
  }
  return {
    gateId: gate.id,
    status: "pass",
    evidence: {
      kind: "verification",
      ref: ran.map((check) => check.name).join(", "),
      summary: `${ran.length} check(s) passed`,
    },
  };
}

/** A source reference: a URL, or a file path with an extension (optionally :line). */
const SOURCE_PATTERN = /(https?:\/\/\S+|(?:^|[\s(`'"])[\w.@-]+(?:\/[\w.@-]+)*\.[a-z0-9]{1,8}(?::\d+)?\b)/i;

export function evaluateGates(input: GateEvaluationInput): GateResult[] {
  return input.gates.map((gate): GateResult => {
    switch (gate.check) {
      case "typecheck":
        return fromVerification(gate, ["typecheck", "tsc", "types"], input.verification);
      case "test":
        return fromVerification(gate, ["test", "tests"], input.verification);
      case "command": {
        // Commands are not run by the acceptance stage itself: a command
        // gate maps to the verification step of the same name (lint,
        // build, …). Anything else is not evidenced here.
        const step = (gate.target ?? "").trim().toLowerCase().replace(/^npm run\s+/, "");
        if (!step) {
          return { gateId: gate.id, status: "skipped", evidence: { kind: "none", summary: "No command target" } };
        }
        return fromVerification(gate, [step], input.verification);
      }
      case "file_exists": {
        const target = (gate.target ?? "").trim();
        const exists = target ? input.fileExists?.(target) : undefined;
        if (exists === undefined) {
          return { gateId: gate.id, status: "skipped", evidence: { kind: "workspace", ref: target, summary: "Could not check the workspace" } };
        }
        return {
          gateId: gate.id,
          status: exists ? "pass" : "fail",
          evidence: { kind: "workspace", ref: target, summary: exists ? "File exists" : "File is missing" },
        };
      }
      case "review": {
        const target = (gate.target ?? "").trim().toLowerCase();
        if (target === "output" || target === "output:sources") {
          const output = (input.output ?? "").trim();
          if (!output) {
            return { gateId: gate.id, status: "fail", evidence: { kind: "output", summary: "The deliverable is empty" } };
          }
          if (target === "output:sources") {
            const cited = SOURCE_PATTERN.test(output);
            return {
              gateId: gate.id,
              status: cited ? "pass" : "fail",
              evidence: {
                kind: "output",
                summary: cited ? "Cites at least one file or URL" : "No file or URL is cited",
              },
            };
          }
          return { gateId: gate.id, status: "pass", evidence: { kind: "output", summary: `${output.length} characters` } };
        }
        if (input.kind === "review") {
          // The review node itself: its own verdict is the evidence.
          if (!input.review) {
            return { gateId: gate.id, status: "skipped", evidence: { kind: "review", summary: "No verdict recorded" } };
          }
        }
        if (!input.review) {
          return { gateId: gate.id, status: "skipped", evidence: { kind: "review", summary: "No review node covers this subtask" } };
        }
        const approved = input.review.verdict === "approved";
        return {
          gateId: gate.id,
          status: approved ? "pass" : "fail",
          evidence: {
            kind: "review",
            ref: input.review.reviewKey,
            summary: approved ? "Reviewer approved" : `Reviewer verdict: ${input.review.verdict}`,
          },
        };
      }
      case "manual":
      default:
        return { gateId: gate.id, status: "skipped", evidence: { kind: "none", summary: "Needs a person to check" } };
    }
  });
}

/**
 * Acceptance from gate results: accepted when no REQUIRED gate failed
 * (a skipped gate — no script, no reviewer — is recorded but does not
 * block), otherwise rejected with the failing criteria as the reason.
 */
export function acceptanceFromGates(
  gates: AcceptanceGate[],
  results: GateResult[]
): { status: "accepted" | "rejected"; reason?: string; failed: string[] } {
  const byId = new Map(gates.map((gate) => [gate.id, gate]));
  const failed = results.filter((result) => result.status === "fail" && isRequiredGate(byId.get(result.gateId) ?? { check: "test" }));
  if (failed.length === 0) return { status: "accepted", failed: [] };
  const reason = failed
    .map((result) => `${byId.get(result.gateId)?.criterion ?? result.gateId}: ${result.evidence.summary}`)
    .join("; ")
    .slice(0, 500);
  return { status: "rejected", reason, failed: failed.map((result) => result.gateId) };
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

/** Read an `escalation` object from an executor answer; null when absent or malformed. */
export function parseEscalation(raw: unknown): Escalation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const kind = typeof value.kind === "string" ? value.kind.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  const aliases: Record<string, EscalationKind> = {
    schema: "schema_change",
    migration: "schema_change",
    dependency: "new_dependency",
    new_dep: "new_dependency",
    security_sensitive: "security",
    outside_scope: "out_of_scope",
    file_outside_scope: "out_of_scope",
    scope: "out_of_scope",
    ambiguous_requirement: "ambiguous",
    ambiguity: "ambiguous",
  };
  const normalized = (ESCALATION_KINDS as readonly string[]).includes(kind)
    ? (kind as EscalationKind)
    : aliases[kind];
  const reason = text(value.reason, TEXT_MAX);
  if (!normalized || !reason) return null;
  const detail = text(value.detail, CRITERION_MAX);
  const options = Array.isArray(value.options)
    ? value.options.map((option) => text(option, 120)).filter((option): option is string => Boolean(option)).slice(0, 4)
    : [];
  return {
    kind: normalized,
    reason,
    ...(detail ? { detail } : {}),
    ...(options.length > 0 ? { options } : {}),
    source: "executor",
  };
}

export type EscalationRoute =
  | { route: "replan"; note: string }
  | { route: "ask_user"; question: string; options?: string[] };

/**
 * The CTO's decision on an escalation (deterministic policy, no LLM call):
 * replan with a note when the CTO may widen the plan itself, ask the user
 * when only the user can decide.
 *
 * - ambiguous, security → ask the user (materially different outcomes /
 *   risk the CTO must not accept on the user's behalf).
 * - new_dependency → ask in supervised mode; in auto_edits / full_access
 *   the CTO allows it and replans with the dependency in scope.
 * - schema_change, out_of_scope → replan with the widened scope recorded.
 * - The same subtask escalating the same kind again (the replan did not
 *   resolve it), or no replans left → ask the user.
 */
export function routeEscalation(
  escalation: Escalation,
  input: { subtaskKey: string; permissionMode: string; replansLeft: number; repeated: boolean }
): EscalationRoute {
  const label = ESCALATION_LABELS[escalation.kind];
  const what = `${label}${escalation.detail ? ` (${escalation.detail})` : ""}`;
  const ask = (question: string, options?: string[]): EscalationRoute => ({
    route: "ask_user",
    question,
    ...(options && options.length > 0 ? { options } : {}),
  });
  const note = (decision: string): EscalationRoute => ({
    route: "replan",
    note: `Escalation from subtask ${input.subtaskKey}: ${what}: ${escalation.reason}. CTO decision: ${decision}`,
  });
  const userQuestion = `Subtask "${input.subtaskKey}" stopped: ${what}. ${escalation.reason}`;

  if (escalation.kind === "ambiguous") {
    return ask(`${userQuestion} Which outcome do you want?`, escalation.options);
  }
  if (escalation.kind === "security") {
    return ask(`${userQuestion} How should the team proceed?`, escalation.options);
  }
  if (input.repeated || input.replansLeft <= 0) {
    return ask(`${userQuestion} The CTO could not resolve it with a new plan. How should the team proceed?`, escalation.options);
  }
  if (escalation.kind === "new_dependency") {
    if (input.permissionMode === "supervised" || !input.permissionMode) {
      return ask(`${userQuestion} Allow the new dependency?`, [
        "Allow the dependency",
        "Do it without a new dependency",
      ]);
    }
    return note(
      "the dependency is allowed under this task's permission mode; plan the change with the dependency and its package.json entry explicitly in scope."
    );
  }
  if (escalation.kind === "schema_change") {
    return note(
      "the schema change is needed; plan it as its own backend subtask with the schema file listed explicitly in allowedPaths, additive (optional fields only), before the work that depends on it."
    );
  }
  return note(
    "widen the scope only where needed: list the extra file explicitly in the allowedPaths of the subtask that must change it, or give it its own subtask."
  );
}
