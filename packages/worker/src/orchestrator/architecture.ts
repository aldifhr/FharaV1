/**
 * Orchestrator/CTO split O1: the architecture flag and the CTO decision node.
 *
 * The planner (system code, no persona) flags an architecture-level decision
 * in its output; a deterministic backstop adds the flag when the plan's own
 * scope shows one (package.json + "add a library", schema/migration files,
 * auth/session/permission scope, a service split). The backstop only ever
 * ADDS a flag. A flagged plan gets one `arch-decision` analysis node routed
 * to the CTO (capability `architecture`), and the gated subtasks depend on
 * it. Unflagged plans are returned unchanged: no CTO call at all.
 */
import { CAPABILITY, type AgentDefinition, type ArchitectureFlag, type ArchitectureReason, type ExecutionPlan, type PlanSubtask } from "@/types";
import { ARCH_DECISION_KEY, parseArchitectureFlag } from "@/api/convex/lib/architectureFlag";
import { capabilitiesOf, isAgentEnabled } from "./capabilities";
import { PLAN_NODE_INSTRUCTIONS } from "@/prompts/planner";

export { ARCH_DECISION_KEY } from "@/api/convex/lib/architectureFlag";

/** Plan note when a flagged plan has no CTO to decide (the work still runs). */
export const NO_CTO_NOTE = "No CTO in the team: architecture decision skipped";

const WRITE_KINDS = new Set<PlanSubtask["kind"]>(["code_change", "shell"]);
const MANIFEST = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i;
const ADD_LIBRARY =
  /\b(add|install|use|adopt|integrate|switch to|migrate to|pakai|pake|gunakan|pasang|install(?:kan)?|tambah(?:kan)?|integrasi(?:kan)?|ganti ke)\b[^.]{0,60}\b(librar(?:y|ies)|package|framework|sdk|dependency|dependencies|lib|pustaka|orm|[a-z0-9@][\w.-]*\/?[\w.-]*)\b/i;
const SCHEMA_PATH = /((^|\/)schema\.ts$|(^|\/)migrations?(\/|$)|\.sql$|(^|\/)prisma\/schema\.prisma$)/i;
const AUTH_PATH = /(^|\/)(auth|oauth|sessions?|permissions?|rbac|acl|middleware)(\/|\.|$)/i;
const AUTH_WORDS =
  /\b(auth(?:entication|orization)?|login|log[- ]?in|sign[- ]?(?:in|up)|oauth|sso|jwt|sessions?|permissions?|rbac|role[- ]based|hak akses|otentikasi|autentikasi)\b/i;
/** UI-only wording: an auth word alone does not flag "fix the typo on the login page". */
const UI_ONLY_WORDS = /\b(typo|warna|colou?r|copy|teks|text|label|font|spacing|padding|margin|ikon|icon|tooltip|placeholder)\b/i;
const INFRA_PATH = /((^|\/)\.github\/|(^|\/)Dockerfile[^/]*$|(^|\/)docker-compose[^/]*$|(^|\/)infra(\/|$))/i;
const ARCH_SPLIT =
  /\b(microservices?|split\b[^.]{0,40}\bservices?|service split|pisah\w*\b[^.]{0,40}\b(?:service|layanan)|separate services?|arsitektur|architecture|monorepo)\b/i;
const SPLIT_WORDS = /\b(microservices?|split|pisah\w*|separate)\b/i;

/** Deterministic architecture signals in a plan (the backstop). */
export function detectArchitectureSignals(plan: ExecutionPlan, command: string): ArchitectureReason[] {
  const writes = plan.subtasks.filter((s) => WRITE_KINDS.has(s.kind));
  if (writes.length === 0) return [];
  const paths = writes.flatMap((s) => s.allowedPaths ?? []);
  const reasons = new Set<ArchitectureReason>();
  const text = `${command}\n${writes.map((s) => `${s.title} ${s.description}`).join("\n")}`;
  if (paths.some((p) => MANIFEST.test(p)) && ADD_LIBRARY.test(text)) reasons.add("new_dependency");
  // Path evidence only: "tambah kolom tanggal di tabel" (UI table) is not a schema change.
  if (paths.some((p) => SCHEMA_PATH.test(p))) reasons.add("schema_change");
  if (paths.some((p) => AUTH_PATH.test(p)) || (AUTH_WORDS.test(command) && !UI_ONLY_WORDS.test(command))) {
    reasons.add("auth_boundary");
  }
  // A CI/Docker fix is DevOps's own decision; only a split/architecture change is flagged.
  if (ARCH_SPLIT.test(command) && (paths.some((p) => INFRA_PATH.test(p)) || SPLIT_WORDS.test(command))) {
    reasons.add("infra_deploy");
  }
  return [...reasons];
}

/** The enabled agent that can take the decision node (declares `architecture`). */
export function architectureDecider(agents: AgentDefinition[]): AgentDefinition | null {
  return agents.find((a) => isAgentEnabled(a) && capabilitiesOf(a).includes(CAPABILITY.ARCHITECTURE)) ?? null;
}

const REASON_TEXT: Record<ArchitectureReason, string> = {
  new_dependency: "a new dependency or framework",
  schema_change: "a schema / data-model change",
  auth_boundary: "an auth or security boundary",
  api_contract: "a new cross-component API contract",
  infra_deploy: "an infra change that alters the architecture",
};

/**
 * Merges the planner's flag with the backstop and, when the plan is
 * flagged and a CTO can decide, inserts the `arch-decision` node before the
 * gated subtasks. Unflagged plans come back unchanged.
 */
export function applyArchitectureGate(
  plan: ExecutionPlan,
  input: { command: string; agents: AgentDefinition[]; flag?: unknown },
  notes: string[] = []
): ExecutionPlan {
  const planned = parseArchitectureFlag(input.flag ?? plan.architecture);
  const backstop = detectArchitectureSignals(plan, input.command);
  const plannerNeeded = Boolean(planned?.needed);
  if (!plannerNeeded && backstop.length === 0) {
    if (!plan.architecture) return plan;
    const { architecture: _unused, ...rest } = plan;
    return rest;
  }
  const reasons = [...new Set([...(plannerNeeded ? planned!.reasons : []), ...backstop])];
  const writeKeys = plan.subtasks.filter((s) => WRITE_KINDS.has(s.kind)).map((s) => s.key);
  const known = new Set(plan.subtasks.map((s) => s.key));
  const requested = (planned?.gatedKeys ?? []).filter((k) => known.has(k) && k !== ARCH_DECISION_KEY);
  const gatedKeys = requested.length > 0 ? requested : writeKeys;
  if (gatedKeys.length === 0) return plan;
  const flag: ArchitectureFlag = {
    needed: true,
    reasons,
    question:
      planned?.question ||
      `Approve the approach for ${reasons.map((r) => REASON_TEXT[r]).join(", ")} in: ${input.command.slice(0, 160)}`,
    gatedKeys,
    source: plannerNeeded && backstop.length > 0 ? "both" : plannerNeeded ? "planner" : "backstop",
  };
  if (!architectureDecider(input.agents)) {
    notes.push(NO_CTO_NOTE);
    return { ...plan, architecture: flag };
  }
  return { ...insertDecisionNode(plan, flag), architecture: flag };
}

/** Keys that (transitively) depend on any of `roots`, roots included. */
function descendantsOf(plan: ExecutionPlan, roots: string[]): Set<string> {
  const out = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of plan.subtasks) {
      if (!out.has(s.key) && s.dependencies.some((d) => out.has(d))) {
        out.add(s.key);
        grew = true;
      }
    }
  }
  return out;
}

function insertDecisionNode(plan: ExecutionPlan, flag: ArchitectureFlag): ExecutionPlan {
  const existing = plan.subtasks.find((s) => s.key === ARCH_DECISION_KEY);
  const downstream = descendantsOf(plan, flag.gatedKeys);
  const gated = new Set(flag.gatedKeys);
  // The decision reads any research that does not itself wait for it.
  const researchDeps = plan.subtasks
    .filter((s) => s.kind === "research" && !downstream.has(s.key) && s.key !== ARCH_DECISION_KEY)
    .map((s) => s.key);
  const gatedTitles = plan.subtasks.filter((s) => gated.has(s.key)).map((s) => `${s.key} (${s.title})`);
  const node: PlanSubtask = existing ?? {
    key: ARCH_DECISION_KEY,
    title: `Architecture decision: ${flag.question}`.slice(0, 200),
    description: [
      PLAN_NODE_INSTRUCTIONS.archDecision,
      `Question: ${flag.question}`,
      `Why it was flagged: ${flag.reasons.map((r) => REASON_TEXT[r]).join("; ")}.`,
      `Subtasks waiting for the decision: ${gatedTitles.join(", ")}.`,
    ].join("\n"),
    kind: "analysis",
    capability: CAPABILITY.ARCHITECTURE,
    dependencies: researchDeps,
    order: 0,
  };
  const others = plan.subtasks
    .filter((s) => s.key !== ARCH_DECISION_KEY)
    .map((s) =>
      gated.has(s.key) && !s.dependencies.includes(ARCH_DECISION_KEY)
        ? { ...s, dependencies: [...s.dependencies, ARCH_DECISION_KEY] }
        : s
    );
  const firstGated = others.findIndex((s) => gated.has(s.key));
  const at = firstGated < 0 ? 0 : firstGated;
  // Its research dependencies must come before it in order.
  const lastDep = Math.max(-1, ...node.dependencies.map((d) => others.findIndex((s) => s.key === d)));
  const index = Math.max(at, lastDep + 1);
  const subtasks = [...others.slice(0, index), node, ...others.slice(index)].map((s, i) => ({ ...s, order: i }));
  return { ...plan, strategy: "dag", subtasks };
}
