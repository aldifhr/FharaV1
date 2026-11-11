/**
 * GOAT G13: who may answer a question an agent asks (audit/goat-plan-2026-11-11.md, idea #10).
 *
 * A question goes to the CTO first only when it is a technical or architecture
 * decision inside the CTO's ceiling. Everything else reaches the user:
 *
 *  - secrets (keys, tokens, passwords, credentials, env values),
 *  - push / merge / PR / deploy / release,
 *  - destructive actions (delete, drop, wipe, force, reset),
 *  - security-sensitive choices, product or ambiguous requirements,
 *  - a new dependency while the task runs in supervised mode (the user's own
 *    ceiling is lower than the CTO's there).
 *
 * The hard categories are checked first and on every text the question
 * carries (question, reason, detail, options), so a technical kind never
 * smuggles a push or a secret past the user. Pure: the Convex side
 * (decisionTurns.ts) and the worker run the same function.
 */

export type QuestionCategory = "secret" | "push" | "destructive" | "security" | "product" | "dependency" | "technical";

export type QuestionRoute =
  | { route: "cto"; category: "dependency" | "technical"; reason: string }
  | { route: "user"; category: QuestionCategory; reason: string };

/** Categories that always reach the user, whatever the kind or the permission mode. */
export const USER_ONLY_CATEGORIES: ReadonlySet<QuestionCategory> = new Set(["secret", "push", "destructive", "security", "product"]);

const SECRET =
  /\b(secrets?|api[\s_-]?keys?|access[\s_-]?keys?|tokens?|passwords?|passphrases?|credentials?|private[\s_-]?keys?|ssh[\s_-]?keys?|client[\s_-]?secrets?|env(ironment)?[\s_-]?(vars?|variables?|values?))\b|(^|[\s/"'`])\.env(\.[a-z]+)?\b/i;
const PUSH =
  /\b(push(es|ed|ing)?|force[\s-]?push|git\s+push|merg(e|es|ed|ing)|pull[\s-]?requests?|PRs?|release[sd]?|deploy(s|ed|ing|ment)?|publish(es|ed|ing)?|ship\s+it)\b/i;
const DESTRUCTIVE =
  /\b(delet(e|es|ed|ing)|remov(e|es|ed|ing)\s+(all|every|the\s+(data|table|database|branch|repo))|drop(s|ped|ping)?\s+(the\s+)?(table|column|database|index|collection)|truncat(e|es|ed|ing)|wip(e|es|ed|ing)|purg(e|es|ed|ing)|destroy(s|ed|ing)?|overwrit(e|es|ing)|rm\s+-rf|reset\s+--hard|force)\b/i;
const SECURITY = /\b(security|auth(entication|orization)?\s+bypass|disable\s+(auth|csrf|tls|ssl)|permissions?\s+model|encryption)\b/i;
const DEPENDENCY = /\b(new\s+)?(dependenc(y|ies)|npm\s+(install|i)\b|package\.json|librar(y|ies)|packages?)\b/i;
const TECHNICAL =
  /\b(architecture|architectural|schema|migration|data\s+model|api\s+(design|contract|shape)|endpoint|refactor|module|interface|types?|framework|librar(y|ies)|dependenc(y|ies)|package|file\s+(layout|structure)|folder|scope|allowedPaths|pattern|approach|implementation|algorithm|cache|index|query|component|hook|state\s+management|test(s|ing)?|typescript|function)\b/i;

/** Escalation kinds (plan 022) the CTO may decide; security and ambiguous never. */
const TECHNICAL_KINDS = new Set(["new_dependency", "schema_change", "out_of_scope"]);
const USER_KINDS: Record<string, QuestionCategory> = { security: "security", ambiguous: "product" };

export interface QuestionInput {
  /** An escalation kind when the question came from one; absent for free text. */
  kind?: string;
  question: string;
  reason?: string;
  detail?: string;
  options?: readonly string[];
  /** The task's permission mode (lib/permissionModes). */
  permissionMode?: string;
}

/** The hard category any of the texts falls in, else null. Order: secret, push, destructive, security. */
export function hardCategory(texts: readonly string[]): "secret" | "push" | "destructive" | "security" | null {
  const all = texts.filter(Boolean).join("\n");
  if (SECRET.test(all)) return "secret";
  if (PUSH.test(all)) return "push";
  if (DESTRUCTIVE.test(all)) return "destructive";
  if (SECURITY.test(all)) return "security";
  return null;
}

const HARD_REASON: Record<"secret" | "push" | "destructive" | "security", string> = {
  secret: "secrets or credentials",
  push: "push, merge or deploy",
  destructive: "a destructive action",
  security: "security",
};

/** Route one question: the CTO when it is technical and inside its ceiling, else the user. */
export function classifyQuestion(input: QuestionInput): QuestionRoute {
  const texts = [input.question, input.reason ?? "", input.detail ?? "", ...(input.options ?? [])];
  const hard = hardCategory(texts);
  if (hard) return { route: "user", category: hard, reason: `The question touches ${HARD_REASON[hard]}, which only the user decides` };
  const kind = input.kind?.trim().toLowerCase();
  if (kind && USER_KINDS[kind]) {
    const category = USER_KINDS[kind];
    return { route: "user", category, reason: category === "security" ? "Security-sensitive choices are the user's" : "Ambiguous requirements are product decisions for the user" };
  }
  const supervised = !input.permissionMode || input.permissionMode === "supervised";
  const isDependency = kind === "new_dependency" || (!kind && DEPENDENCY.test(texts.join("\n")));
  if (isDependency) {
    if (supervised) return { route: "user", category: "dependency", reason: "Supervised mode: a new dependency is the user's call" };
    return { route: "cto", category: "dependency", reason: "A new dependency inside this task's permission mode" };
  }
  if (kind && TECHNICAL_KINDS.has(kind)) return { route: "cto", category: "technical", reason: `A ${kind.replace(/_/g, " ")} decision is technical` };
  if (!kind && TECHNICAL.test(texts.join("\n"))) return { route: "cto", category: "technical", reason: "A technical or architecture question" };
  return { route: "user", category: "product", reason: "Not a technical or architecture question" };
}

/** True when a CTO answer's own text falls in a hard category (it is escalated instead of delivered). */
export function answerCrossesCeiling(answer: string, chosenOption?: string): boolean {
  return hardCategory([answer, chosenOption ?? ""]) !== null;
}
