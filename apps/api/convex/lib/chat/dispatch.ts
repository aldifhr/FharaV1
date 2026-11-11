/**
 * Chat routing (deterministic, no LLM). Orchestrator/CTO split O3: a chat
 * message with no @mention is routed by System to the role that owns the
 * topic; there is no CTO default.
 *
 * Domains: architecture (monorepo, data model, service split) → CTO,
 * planning / prioritisation → CTO, greetings and short how-to → Support,
 * "user can't log in" → Support, code audit → Reviewer, tests → QA,
 * research / comparisons → Researcher, security, UI/UX → Designer/Frontend,
 * backend/db → Backend, CI/deploy → DevOps. A short status question
 * ("sampai mana") gets a System status line from task state (no LLM). Only a
 * role that exists and is enabled in the project team is ever picked;
 * otherwise the route is "none" and the caller's chooser decides.
 *
 * Follow-ups ("coba cek lebih dalam", "lebih detail") route by the previous
 * turn: back to the specialist who answered it, else by the previous user
 * question's domain, else (a deep-dive on code) to the Reviewer.
 *
 * Pure: unit-tested in dispatch.test.ts.
 */

export type DispatchDomain =
  | "architecture"
  | "support"
  | "security"
  | "reviewer"
  | "qa"
  | "devops"
  | "researcher"
  | "designer"
  | "frontend"
  | "backend";

type TeamMember = { _id: string; name: string; role: string };
type HistoryRow = { authorType: string; content: string; agentId?: string; voice?: string };

export type ChatRoute<T extends TeamMember> =
  /** No owner matched (or its role is not in the team): the caller chooses. */
  | { kind: "none"; reason: string }
  /** A short status question: System answers from task state, no LLM. */
  | { kind: "status"; reason: string }
  | {
      kind: "specialist";
      domain: DispatchDomain;
      agent: T;
      /** A code path / identifier the question is about, when one is named. */
      topic?: string;
      /** Routed by the previous turn (follow-up) rather than this message alone. */
      followUp: boolean;
      reason: string;
    };

/** Roles each domain may go to, in preference order (lib/roles.ts keys). */
export const DOMAIN_ROLES: Record<DispatchDomain, string[]> = {
  architecture: ["cto", "architect"],
  support: ["support"],
  // The fixed team has no Security role; a custom "security" agent wins, else the Reviewer.
  security: ["security", "reviewer"],
  reviewer: ["reviewer"],
  qa: ["qa"],
  devops: ["devops"],
  researcher: ["researcher"],
  designer: ["designer", "ui-ux", "frontend"],
  frontend: ["frontend", "designer"],
  backend: ["backend"],
};

/** Domain rules, checked in this order (first match with an enabled role wins). */
const DOMAIN_RULES: Array<{ domain: DispatchDomain; pattern: RegExp }> = [
  {
    domain: "security",
    pattern:
      /\b(security|keamanan|vulnerab\w*|kerentanan|celah keamanan|xss|csrf|ssrf|sql\s*injection|injection|cve|owasp|exploit\w*|secrets? (?:bocor|leak\w*)|(?:key|token|secret)s? (?:bocor|leak\w*)|bypass auth\w*|auth\w* bypass|privilege escalation)\b/i,
  },
  {
    // A choice about the project's shape, not a library comparison.
    domain: "architecture",
    pattern:
      /\b(mono-?repo|poly-?repo|multi-?repo|monolit\w*|monolith\w*|micro-?services?|arsitektur\w*|architecture|architectural|system design|desain sistem|data model|model data|service split|pisah(?:kan)? (?:service|layanan)|struktur (?:repo|project|proyek|folder|kode)|tech stack|s3 vs local|local vs s3|auth (?:approach|strategy)|strategi auth\w*)\b/i,
  },
  {
    // A user's problem or how to use the product: Support.
    domain: "support",
    pattern:
      /\b((?:user|pengguna|customer|pelanggan)\w* (?:tidak|nggak|gak|ga|enggak|can'?t|cannot|could ?n[o']t) (?:bisa )?(?:login|log in|masuk|daftar|sign ?in|sign ?up|register)|(?:can'?t|cannot|tidak bisa|nggak bisa|gak bisa) (?:login|log in|sign ?in)|cara (?:pakai|memakai|menggunakan|install|instal|pasang)|how (?:do i|to) (?:use|install|get started)|keluhan (?:user|pengguna|pelanggan)|tiket support|support ticket)\b/i,
  },
  {
    domain: "reviewer",
    pattern:
      /\b(code review|review|reviu|audit|cek lebih dalam|cek (?:lebih )?detail|periksa (?:kode|code|fungsi|function|file)|cek (?:kode|code|fungsi|function|file)|deep[- ]?dive|telusuri|bedah|inspect)\b/i,
  },
  {
    domain: "qa",
    pattern:
      /\b(tests?|testing|tes|dites|ditest|testnya|tesnya|unit[- ]?tests?|e2e|qa|coverage|cakupan (?:tes|test)|regression|regresi|verifikasi|verification|verify|pengujian|uji|diuji|teruji|test ?cases?|flaky|vitest|jest|playwright)\b/i,
  },
  {
    domain: "devops",
    pattern:
      /\b(devops|ci|cd|ci\/cd|pipeline|deploy\w*|docker\w*|kubernetes|k8s|github actions|vercel|netlify|nginx|infra\w*|hosting|server produksi|production server)\b/i,
  },
  {
    domain: "researcher",
    pattern:
      /\b(riset|research|bandingkan|perbandingan|compare|comparison|vs\.?|versus|librar(?:y|ies)|pustaka|alternatif\w*|alternatives?|dokumentasi resmi|official docs|docs|documentation|benchmark|which (?:library|package|framework)|framework mana|library mana)\b/i,
  },
  {
    domain: "designer",
    pattern:
      /\b((?:desain|design)(?!\s+(?:tabel|tables?|schema|skema|database|db|api|endpoints?|data|query|index))|ux|ui\/ux|wireframe|mockup|warna|colou?rs?|palet\w*|palette|tipografi|typography|font|branding|logo|user flow|alur pengguna)\b/i,
  },
  {
    domain: "frontend",
    pattern:
      /\b(ui|frontend|front-end|komponen|components?|react|next\.?js|css|tailwind|halaman|tampilan|layout|tombol|button|modal|responsi(?:ve|f)|\.tsx)\b/i,
  },
  {
    domain: "backend",
    pattern:
      /\b(backend|back-end|api|endpoints?|database|db|schema|skema|tabel|tables?|convex|query|mutation|server|migrasi|migration|webhook|indexes|index db)\b/i,
  },
];

const GREETING_LIKE =
  /^(hi|hello|hey|halo|hai|yo|pagi|siang|sore|malam|selamat (?:pagi|siang|sore|malam)|thanks|thank you|makasih|terima kasih|ok(?:e|ay)?|sip|mantap)\b/i;
const STATUS =
  /\b(status|progress|progres|sampai mana|udah sampai mana|sudah sampai mana|update terbaru|what'?s the status|how'?s it going|gimana (?:task|progres)\w*)\b/i;
/** "status code 500", "HTTP status": a technical question, not a progress check. */
const NOT_PROGRESS = /\b(code|kode|http|\d{3}|field|kolom|enum|column)\b/i;
const PLANNING =
  /\b(prioritas\w*|prioriti[sz]e|priorit(?:y|ies)|roadmap|rencana\w*|planning|langkah (?:selanjutnya|berikutnya)|next steps?|apa yang (?:harus|sebaiknya|perlu) (?:kita|saya|aku|gue) (?:lakukan|kerjakan|buat)|what should (?:we|i) (?:do|work on|build|tackle)|mulai dari mana|where (?:should|do) (?:we|i) start|duluan (?:yang mana|mana)|mana (?:dulu|duluan))\b/i;
const HOW_TO = /^(?:how (?:do|can|to|should)|cara|gimana cara|bagaimana cara|gmn cara)\b/i;
/** Asks for depth: a short how-to with one of these is not light. */
const DEEP = /\b(audit|review|cek lebih dalam|lebih dalam|deep[- ]?dive|telusuri|bedah|security|keamanan)\b/i;

/** Follow-up phrases that point back at the previous turn. */
const FOLLOW_UP =
  /\b(cek lebih dalam|lebih dalam|lebih detail|lebih rinci|dalami|dalemin|deeper|go deeper|dig deeper|more detail\w*|detailnya|lanjut(?:kan)? cek|lanjut(?:kan)? periksa|cek lagi|check again|periksa lagi|cek ulang|elaborate|jelaskan lebih)\b/i;
/**
 * A whole short message that only asks to go on or for more ("lanjutkan",
 * "terus", "detailnya?", "more?"). "lanjut"/"gas" right after a CTO Create
 * task offer never reaches the pre-route (it starts the offered task).
 */
const BARE_FOLLOW_UP =
  /^(?:(?:ok(?:e|ay)?|sip|ya|yes)[\s,]+)?(?:lanjut(?:kan)?|teruskan|terus|continue|go on|keep going|detail(?:nya|s)?|rinciannya|more|lagi|terus gimana|then\??)(?:\s+(?:aja|ya|dong|lagi|please|kak|bro))?[\s!.?]*$/i;

/** A short follow-up that points back at the previous turn. */
export function isFollowUpText(text: string): boolean {
  const t = text.trim();
  if (BARE_FOLLOW_UP.test(t)) return true;
  return FOLLOW_UP.test(t) && words(t) <= 10 && matchDomains(t.replace(FOLLOW_UP, " ")).length === 0 && !codeTargetOf(t);
}

/**
 * Whether a chat message goes through the deterministic pre-route at all.
 * Chat is everything without an explicit task trigger (those are handled
 * before this: Create task button, /task, a leading kerjakan/jalankan/
 * eksekusi, a go reply to a CTO offer). The LLM intent never gates the route
 * for read-only work: nous often labels "tolong audit kode src/" or "cek
 * lebih dalam" as task/audit. Only these stay with the CTO (plan + Create
 * task offer): pasted content, an option pick, a deterministic change
 * request, a run request ("tolong jalankan tes"), and a message the LLM
 * itself calls an implementation (unless it is a follow-up).
 */
export function chatPreRouteAllowed(input: {
  text: string;
  /** The (suggestion-only) intent from resolveIntent. */
  intent: { intent: string; subtype: string };
  optionPick: boolean;
  pasted: boolean;
  /** classifyChatIntent says change request and the text has no ask shape. */
  workShaped: boolean;
  /** detectChatRunCommands found commands to run. */
  runRequest: boolean;
}): boolean {
  if (input.optionPick || input.pasted || input.workShaped || input.runRequest) return false;
  if (isFollowUpText(input.text)) return true;
  if (input.intent.intent === "task" && input.intent.subtype === "implementation") return false;
  return input.intent.intent === "ask" || input.intent.intent === "task";
}

const CODE_PATH = /(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.-]+|[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|css|scss|json|md|ya?ml|sql))(?=$|[\s`'"),.:;!?])/;
const BACKTICKED = /`([^`\n]{2,80})`/;
const CAMEL_IDENT = /\b([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)\b/;
const CODE_WORD = /\b(kode|code|fungsi|function|modul|module|file|class|kelas|method|komponen|component|hook)\b/i;

/** The code path or identifier a message names, if any. */
export function codeTargetOf(text: string): string | undefined {
  return (BACKTICKED.exec(text)?.[1] ?? CODE_PATH.exec(text)?.[1] ?? CAMEL_IDENT.exec(text)?.[1])?.trim();
}

function mentionsCode(text: string): boolean {
  return Boolean(codeTargetOf(text)) || CODE_WORD.test(text);
}

function words(text: string): number {
  return (text.trim().match(/\S+/g) ?? []).length;
}

function normRole(role: string): string {
  return role.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/** The enabled teammate for a role key ("qa" matches "qa", "QA", "qa-engineer"). */
function agentForRole<T extends TeamMember>(team: T[], key: string): T | undefined {
  return team.find((a) => {
    const r = normRole(a.role);
    return r === key || r.startsWith(`${key}-`);
  });
}

/** The domain a teammate's role belongs to (for follow-ups that go back to it). */
export function domainOfRole(role: string): DispatchDomain | null {
  const r = normRole(role);
  for (const domain of Object.keys(DOMAIN_ROLES) as DispatchDomain[]) {
    if (DOMAIN_ROLES[domain][0] === r || r.startsWith(`${DOMAIN_ROLES[domain][0]}-`)) return domain;
  }
  return r === "ui-ux" ? "designer" : null;
}

/** Domains the text matches, in rule order. */
export function matchDomains(text: string): DispatchDomain[] {
  return DOMAIN_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.domain);
}

/**
 * A light message that no topic domain owns, or null. greeting / short
 * how-to → Support, planning → CTO, status → a System status line.
 */
export function lightReason(text: string): "empty" | "greeting" | "planning" | "status" | "short how-to" | null {
  const t = text.trim();
  if (!t) return "empty";
  if (GREETING_LIKE.test(t) && words(t) <= 4) return "greeting";
  if (PLANNING.test(t)) return "planning";
  if (STATUS.test(t) && !DEEP.test(t) && !NOT_PROGRESS.test(t) && words(t) <= 8) return "status";
  if (HOW_TO.test(t) && words(t) <= 10 && !DEEP.test(t)) return "short how-to";
  return null;
}

/** Domains that need the repo tools to be useful (else the next domain or the chooser). */
function needsRepo(domain: DispatchDomain, text: string): boolean {
  if (domain === "reviewer") return true;
  // A question about specific code ("schema.ts", "fungsi parseConfig") needs
  // the repo whatever the domain; research, architecture and support do not.
  return domain !== "researcher" && domain !== "architecture" && domain !== "support" && mentionsCode(text);
}

function pick<T extends TeamMember>(
  text: string,
  team: T[],
  repoTools: boolean
): { domain: DispatchDomain; agent: T } | null {
  const domains = matchDomains(text);
  // Prefer a domain that can be answered now; without repo tools a
  // code-bound domain still goes to its owner (no CTO to fall back on, O3),
  // which says plainly what it has not checked.
  for (const strict of [true, false]) {
    for (const domain of domains) {
      if (strict && !repoTools && needsRepo(domain, text)) continue;
      const agent = agentForDomain(team, domain);
      if (agent) return { domain, agent };
    }
  }
  return null;
}

/**
 * The previous turn: the user message before the latest one, and the
 * teammates who replied after it, nearest first. System lines are skipped.
 */
function previousTurn(history: HistoryRow[]): { userText: string; agentIds: string[]; replies: string[] } | null {
  let last = history.length - 1;
  while (last >= 0 && history[last].authorType !== "user") last -= 1;
  if (last < 1) return null;
  const agentIds: string[] = [];
  const replies: string[] = [];
  for (let i = last - 1; i >= 0; i -= 1) {
    const row = history[i];
    if (row.authorType === "user") return { userText: row.content, agentIds, replies };
    // System lines and old CTO handoff lines are routing, not replies.
    if (row.authorType === "agent" && row.voice !== "system" && row.content?.trim() && !isHandoffLine(row.content)) {
      if (row.agentId) agentIds.push(String(row.agentId));
      replies.push(row.content);
    }
  }
  return agentIds.length ? { userText: "", agentIds, replies } : null;
}

/** The first enabled agent for a domain's roles, in preference order. */
function agentForDomain<T extends TeamMember>(team: T[], domain: DispatchDomain): T | undefined {
  for (const key of DOMAIN_ROLES[domain]) {
    const agent = agentForRole(team, key);
    if (agent) return agent;
  }
  return undefined;
}

/**
 * Route one message that has no @mention. `team` is the enabled project
 * team (the CTO included: it owns architecture and planning); `history`
 * ends with the message being answered.
 */
export function routeQuestion<T extends TeamMember>(input: {
  text: string;
  team: T[];
  history?: HistoryRow[];
  repoToolsAvailable?: boolean;
}): ChatRoute<T> {
  const text = input.text.trim();
  const repoTools = input.repoToolsAvailable !== false;
  const { team } = input;

  if (isFollowUpText(text)) {
    const prev = previousTurn(input.history ?? []);
    if (prev) {
      // 1) Back to the teammate who answered the previous turn.
      for (const id of prev.agentIds) {
        const agent = team.find((a) => String(a._id) === id);
        const domain = agent ? domainOfRole(agent.role) : null;
        if (agent && domain && (repoTools || !needsRepo(domain, prev.userText))) {
          return { kind: "specialist", domain, agent, topic: codeTargetOf(prev.userText), followUp: true, reason: "follow-up to the teammate who answered" };
        }
      }
      // 2) By the previous question's own domain.
      if (prev.userText && !lightReason(prev.userText)) {
        const hit = pick(prev.userText, team, repoTools);
        if (hit) return { kind: "specialist", ...hit, topic: codeTargetOf(prev.userText), followUp: true, reason: "follow-up routed by the previous question" };
      }
      // 3) A deep-dive on code the previous turn talked about → Reviewer.
      const prevText = [prev.userText, ...prev.replies].join("\n");
      if (repoTools && mentionsCode(prevText)) {
        const agent = agentForRole(team, "reviewer");
        if (agent) {
          return { kind: "specialist", domain: "reviewer", agent, topic: codeTargetOf(prev.userText) ?? codeTargetOf(prevText), followUp: true, reason: "deep-dive on code from the previous turn" };
        }
      }
    }
    return { kind: "none", reason: "follow-up with nobody to route to" };
  }

  const light = lightReason(text);
  if (light === "status") return { kind: "status", reason: "status" };
  if (light === "planning") {
    const cto = agentForDomain(team, "architecture");
    return cto ? { kind: "specialist", domain: "architecture", agent: cto, followUp: false, reason: "planning" } : { kind: "none", reason: "planning, no CTO in the team" };
  }
  if (light === "greeting" || light === "empty") {
    const support = agentForDomain(team, "support");
    return support ? { kind: "specialist", domain: "support", agent: support, followUp: false, reason: light } : { kind: "none", reason: `${light}, no Support in the team` };
  }
  // A depth phrase ("cek lebih dalam tesnya") must not drown the message's own
  // domain: route by the rest first, then by the whole text.
  const stripped = text.replace(new RegExp(FOLLOW_UP.source, "gi"), " ");
  const hit =
    (stripped !== text && matchDomains(stripped).length ? pick(stripped, team, repoTools) : null) ??
    pick(text, team, repoTools);
  if (hit) return { kind: "specialist", ...hit, topic: codeTargetOf(text), followUp: false, reason: `domain ${hit.domain}` };
  // "cara pakai …", "how do I …" with no topic domain: Support guides.
  if (light === "short how-to") {
    const support = agentForDomain(team, "support");
    if (support) return { kind: "specialist", domain: "support", agent: support, followUp: false, reason: "short how-to" };
  }
  return { kind: "none", reason: "no domain matched (or its role is not in the team)" };
}

// ─── Copy ─────────────────────────────────────────────────────────────────

const ID_WORDS =
  /\b(yang|dan|ini|itu|tolong|coba|cek|apa|apakah|gimana|bagaimana|kenapa|untuk|dong|saya|kita|lebih|dalam|jalankan|bandingkan|desain|halaman|keamanan|tes|aja|nggak|gak|bisa|sudah|udah|mana|dulu|buat|kode|fungsi)\b/i;

/** The message reads as Indonesian (for fixed copy). */
export function looksIndonesian(text: string): boolean {
  return ID_WORDS.test(text);
}

/**
 * System's routing line (§2.5): English only, no @name, no opinion.
 * "Sent to Backend" / "Sent to Backend and Designer".
 */
export function systemRoutingLine(agents: Array<{ name: string }>): string {
  const names = agents.map((a) => a.name.trim()).filter(Boolean);
  if (names.length === 0) return "";
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Sent to ${list}`;
}

/**
 * A message that is only the CTO's old fixed handoff line (pre-O3 rows,
 * "Handing this to @X for …"). It carries no content for the next speaker,
 * and kept in a specialist's transcript it gets echoed.
 */
const HANDOFF_LINE = /^(?:Handing this to @[\w.-]+ for [^\n]{1,160}\.|Saya serahkan ke @[\w.-]+ untuk [^\n]{1,160}\.)$/;
export function isHandoffLine(text: string): boolean {
  return HANDOFF_LINE.test((text ?? "").trim());
}

/**
 * The answer subtype for a routed specialist reply. A code review or
 * security question is an audit (read the code, list findings) whatever the
 * LLM called it; an implementation label becomes an explanation (a routed
 * message is chat, never a plan). Live test 4: the routed Reviewer answered
 * with a plan + "klik Create task" instead of auditing.
 */
export function routedAnswerSubtype<S extends string>(domain: DispatchDomain, subtype: S): S | "audit" | "explanation" {
  if (domain === "reviewer" || domain === "security") return "audit";
  return subtype === "implementation" ? "explanation" : subtype;
}
