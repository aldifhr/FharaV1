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
import { ARCH_DECISION_KEY, parseArchitectureFlag } from "@/api/functions/lib/architectureFlag";
import { capabilitiesOf, isAgentEnabled } from "./capabilities";
import { PLAN_NODE_INSTRUCTIONS } from "@/prompts/planner";

export { ARCH_DECISION_KEY } from "@/api/functions/lib/architectureFlag";

/** Plan note when a flagged plan has no CTO to decide (the work still runs). */
export const NO_CTO_NOTE = "No CTO in the team: architecture decision skipped";

const WRITE_KINDS = new Set<PlanSubtask["kind"]>(["code_change", "shell"]);
const MANIFEST_NAMES = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]);
const AUTH_SEGMENTS = new Set(["auth", "oauth", "session", "sessions", "permission", "permissions", "rbac", "acl", "middleware"]);

function isWordChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    ch === "_"
  );
}

function tokenizeLower(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  let start = -1;
  for (let i = 0; i < lower.length; i++) {
    if (isWordChar(lower[i])) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      tokens.push(lower.slice(start, i));
      start = -1;
    }
  }
  if (start !== -1) tokens.push(lower.slice(start));
  return tokens;
}

function hasAnyWord(tokens: ReadonlySet<string>, words: readonly string[], prefixes: readonly string[] = []): boolean {
  for (const w of words) {
    if (tokens.has(w)) return true;
  }
  if (prefixes.length > 0) {
    for (const token of tokens) {
      for (const prefix of prefixes) {
        if (token.startsWith(prefix)) return true;
      }
    }
  }
  return false;
}

function hasAnyPhrase(lower: string, phrases: readonly string[]): boolean {
  for (const phrase of phrases) {
    let idx = lower.indexOf(phrase);
    while (idx !== -1) {
      const beforeOk = idx === 0 || !isWordChar(lower[idx - 1]);
      const afterIdx = idx + phrase.length;
      const afterOk = afterIdx >= lower.length || !isWordChar(lower[afterIdx]);
      if (beforeOk && afterOk) return true;
      idx = lower.indexOf(phrase, idx + 1);
    }
  }
  return false;
}

function pathSegments(raw: string): string[] {
  return raw.trim().replaceAll("\\", "/").toLowerCase().split("/").filter(Boolean);
}

function isManifestPath(raw: string): boolean {
  const segs = pathSegments(raw);
  const last = segs[segs.length - 1] ?? "";
  return MANIFEST_NAMES.has(last);
}

function isSchemaPath(raw: string): boolean {
  const segs = pathSegments(raw);
  const last = segs[segs.length - 1] ?? "";
  if (last === "schema.ts" || last.endsWith(".sql")) return true;
  if (segs.includes("migration") || segs.includes("migrations")) return true;
  return segs.length >= 2 && segs[segs.length - 2] === "prisma" && last === "schema.prisma";
}

function isAuthPath(raw: string): boolean {
  for (const seg of pathSegments(raw)) {
    const stem = seg.includes(".") ? seg.slice(0, seg.indexOf(".")) : seg;
    if (AUTH_SEGMENTS.has(seg) || AUTH_SEGMENTS.has(stem)) return true;
  }
  return false;
}

function isInfraPath(raw: string): boolean {
  const segs = pathSegments(raw);
  const last = segs[segs.length - 1] ?? "";
  return segs.includes(".github") || segs.includes("infra") || last.startsWith("dockerfile") || last.startsWith("docker-compose");
}

function mentionsAddLibrary(text: string): boolean {
  const lower = text.toLowerCase();
  const tokens = new Set(tokenizeLower(lower));
  const hasVerb =
    hasAnyWord(tokens, ["add", "install", "use", "adopt", "integrate", "pakai", "pake", "gunakan", "pasang", "install", "installkan", "tambah", "tambahkan", "integrasi", "integrasikan"]) ||
    hasAnyPhrase(lower, ["switch to", "migrate to", "ganti ke"]);
  if (!hasVerb) return false;
  return hasAnyWord(tokens, ["library", "libraries", "package", "framework", "sdk", "dependency", "dependencies", "lib", "pustaka", "orm"]);
}

function mentionsAuth(command: string): boolean {
  const lower = command.toLowerCase();
  const tokens = new Set(tokenizeLower(lower));
  const hasAuth =
    hasAnyWord(tokens, [
      "auth",
      "authentication",
      "authorization",
      "login",
      "oauth",
      "sso",
      "jwt",
      "session",
      "sessions",
      "permission",
      "permissions",
      "rbac",
      "otentikasi",
      "autentikasi",
    ]) || hasAnyPhrase(lower, ["log in", "log-in", "sign in", "sign-in", "sign up", "sign-up", "role based", "role-based", "hak akses"]);
  if (!hasAuth) return false;
  const uiOnly = hasAnyWord(tokens, ["typo", "warna", "color", "colour", "copy", "teks", "text", "label", "font", "spacing", "padding", "margin", "ikon", "icon", "tooltip", "placeholder"]);
  return !uiOnly;
}

function mentionsArchSplit(command: string): { arch: boolean; split: boolean } {
  const lower = command.toLowerCase();
  const tokens = new Set(tokenizeLower(lower));
  const split = hasAnyWord(tokens, ["microservice", "microservices", "split", "separate"], ["pisah"]);
  const arch =
    hasAnyWord(tokens, ["microservice", "microservices", "arsitektur", "architecture", "monorepo"]) ||
    hasAnyPhrase(lower, ["service split", "separate services"]) ||
    (split && hasAnyWord(tokens, ["service", "services", "layanan"]));
  return { arch, split };
}

/** Deterministic architecture signals in a plan (the backstop). */
export function detectArchitectureSignals(plan: ExecutionPlan, command: string): ArchitectureReason[] {
  const writes = plan.subtasks.filter((s) => WRITE_KINDS.has(s.kind));
  if (writes.length === 0) return [];
  const paths = writes.flatMap((s) => s.allowedPaths ?? []);
  const reasons = new Set<ArchitectureReason>();
  const text = `${command}\n${writes.map((s) => `${s.title} ${s.description}`).join("\n")}`;
  if (paths.some(isManifestPath) && mentionsAddLibrary(text)) reasons.add("new_dependency");
  // Path evidence only: "tambah kolom tanggal di tabel" (UI table) is not a schema change.
  if (paths.some(isSchemaPath)) reasons.add("schema_change");
  if (paths.some(isAuthPath) || mentionsAuth(command)) {
    reasons.add("auth_boundary");
  }
  // A CI/Docker fix is DevOps's own decision; only a split/architecture change is flagged.
  const splitInfo = mentionsArchSplit(command);
  if (splitInfo.arch && (paths.some(isInfraPath) || splitInfo.split)) {
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
