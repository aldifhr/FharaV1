import { CAPABILITY, type Classification, type Concern } from "@/types";
import { ALLOWED_ARGV, allowedCommandLines } from "@/utils/commandAllowlist";
import { unwrapSandboxBrief } from "@/api/convex/lib/sandboxBrief";

const GREETING = /^(hi|hello|hey|halo|hai|yo|good (morning|afternoon|evening))[!.,?\s]*$/i;
// Expanded verb coverage (Stage A fast path only — semantic stage below
// correctly handles migrate/convert/indirect phrasing without this list).
// Strong change verbs only: generic words (perlu/menggunakan/pakai/jalankan)
// were removed — they match plain questions ("Kenapa API ini menggunakan
// Convex?" is research, not a code change). QUESTION is checked first below.
// Indonesian verbs take suffixes (-kan, -lah, -in, -nya): "Tambahkan",
// "buatkan", "bikinin", "ubahlah" must match like their bare stems.
const ID_SUFFIX = "(?:kan|lah|in|nya|kanlah)?";
const CHANGE_VERB = new RegExp(
  "\\b(add|create|build|implement|make|update|edit|fix|change|refactor|refaktor|remove|delete|rename|move|style|redesign|" +
    `(?:tambah|buat|bikin|ubah|perbaiki|perbaik|hapus|pasang|sesuaikan|ganti|pindah|pisah|rapi|perbarui)${ID_SUFFIX}|` +
    "migrate|convert|scaffold|porting|port|setup|install|konversi|switch|ganti ke|pindah ke|too slow|should switch|switch to|postgres)\\b",
  "i"
);
const AUDIT_ONLY =
  /\b(audit|review|inspect|analy[sz]e|check for|security review|code review)\b/i;
const QUESTION =
  /\b(explain|how does|how do|why|what is|what are|where is|document|describe|summari[sz]e|pelajari|learn|study|explore|understand|apa|mengapa|kenapa)\b/i;
const FRONTEND =
  /\b(frontend|front-end|ui|ux|react|next\.?js|component|komponen|page|halaman|tampilan|header|navbar|footer|sidebar|button|tombol|toggle|form|layout|css|tailwind|responsive|design|dark ?mode|light ?mode|theme|tema)\b/i;
const DESIGN =
  /\b(design|ui\/ux|wireframe|mockup|layout direction|pricing direction|pricing layout|pricing tier|proposal)\b/i;
const BACKEND =
  /\b(backend|back-end|api|server|endpoint|database|db|schema|convex|query|mutation|auth|webhook)\b/i;
// Plain text/data files (notes, configs, fixtures) are not frontend work:
// when a change command touches only these — no frontend/backend/design
// keywords and no code file extensions — defaulting to frontend makes the
// Designer own every .txt file. Backend is the team's file/shell
// generalist, so route those to backend-development instead.
const PLAIN_DATA_FILE =
  /\.(txt|md|markdown|json|json5|csv|ya?ml|toml|ini|cfg|conf|env|log|xml|sql|lock)\b/i;
const CODE_FILE =
  /\.(html?|css|scss|sass|less|jsx?|tsx?|vue|svelte|py|go|rs|java|rb|php|cs|swift|kt|sh|bash|zsh)\b/i;
// "search bug", "find bugs", "cari bug", "temukan bug di src/": a hunt for
// unknown bugs. Without a described symptom it is an investigation, not a
// change request (live sandbox run "search bug" planned a frontend
// code_change + browser QA and invented files for a bug that did not exist).
const BUG_HUNT =
  /\b(?:search|find|look|hunt|scan|check|cari|carikan|cariin|temukan|temuin|nyari|mencari|menemukan|cek|periksa)\s+(?:for\s+)?(?:the\s+|some\s+|any\s+|possible\s+|potential\s+)?(?:bugs?|errors?|issues?|masalah|kesalahan|celah)\b/i;
const BUG_SYMPTOM =
  /\b(?:when|whenever|after|saat|ketika|pas|waktu|setelah|habis|kalau|if|error:|exception|stack ?trace|crash\w*|gagal|fails?|failing|failed|broken|rusak|error \d{3}|\d{3} error|tidak (?:bisa|muncul|jalan|berfungsi|tampil|ke ?simpan|terkirim)|gak bisa|nggak bisa|ga bisa|ngga bisa|can'?t|cannot|doesn'?t|does not|won'?t|isn'?t|not (?:working|showing|loading|saving|rendering|updating)|blank|kosong|hilang|missing|stuck|freez\w*|hang\w*|lambat|slow|typeerror|referenceerror|undefined|nan)\b|["“'`][^"”'`]{6,}["”'`]/i;
// Change verbs that still fit a hunt ("cari bug lalu perbaiki"): the
// Reviewer reports findings first; a fix is a follow-up task.
const FIX_ONLY_VERB = /\b(?:fix|fixes|perbaiki|perbaikin|benerin|betulin)\b/gi;

/** A vague bug hunt with no symptom described (see BUG_HUNT). */
export function isVagueBugHunt(command: string): boolean {
  const request = requestText(command).trim();
  if (!BUG_HUNT.test(request) || BUG_SYMPTOM.test(request)) return false;
  return !CHANGE_VERB.test(request.replace(FIX_ONLY_VERB, " "));
}
const TESTING = /\b(test|tests|testing|qa|e2e|playwright|vitest|jest|coverage|uji|pengujian)\b/i;
const SECURITY = /\b(security|vulnerab|authz|xss|csrf|injection|secret)\b/i;

// Explicit "do not change code" / "research only" phrasing (Indonesian and
// English). The user's own words win over every change verb in the same
// message: "riset kenapa build lambat, jangan ubah kode" contains "ubah",
// yet it asks for a read-only answer. The e2e (B3) classified exactly that
// as code_change and failed with "no file changes".
const NO_CODE_NEGATION = new RegExp(
  "\\b(?:jangan|tanpa|tidak (?:perlu|usah)|nggak usah|gak usah|ga usah|ngga usah|tak perlu)\\s+" +
    "(?:(?:meng|di)?ubah|(?:meng|di)?edit|menyentuh|(?:di)?sentuh|(?:me|di)?modifikasi|(?:meng|di)?ganti|menulis|(?:di)?tulis|bikin|buat)\\w*\\s+" +
    "(?:(?:apa|apapun|apa pun|satu)\\s+)?(?:kode|code|kodenya|file|berkas|source|repo)\\w*" +
    "|\\b(?:do not|don'?t|dont|never|without|no need to)\\s+(?:change|changing|modify|modifying|edit|editing|touch|touching|write|writing)\\s+" +
    "(?:(?:any|the|a)\\s+)?(?:code|files?|source|repo)\\b" +
    "|\\bno code changes?\\b",
  "i"
);
const RESEARCH_ONLY =
  /\b(?:research[- ]only|riset saja|riset aja|analisa saja|analisa aja|analisis saja|analisis aja|hanya (?:riset|analisa|analisis)|cuma (?:riset|analisa|analisis)|just (?:research|analy[sz]e))\b/i;
// A research verb: research unless a real change verb remains once the
// negated phrases are removed ("riset library X lalu perbaiki Y" is a change).
const RESEARCH_WORD = /\b(?:riset|research|investigasi|investigate|analisa|analisis|telusuri|kaji)\b/i;

const ATTACHED_CONTEXT = /\n\s*(?:---\s*Conversation context\s*---|Attached file context:|---\s*File:)/i;
// Live tests 3/4: "jalankan tes" wrapped in the Sandbox brief was
// classified code_change from the wrapper's own words ("change",
// "production", "push"). Classification reads only the instruction.
export { unwrapSandboxBrief };

/** The user's own words: attached file contexts, conversation context and a Sandbox wrapper are not instructions. */
export function requestText(command: string): string {
  const unwrapped = unwrapSandboxBrief(command);
  return unwrapped.split(ATTACHED_CONTEXT)[0] ?? unwrapped;
}

/** True when the request explicitly asks for no code changes (research/question only). */
export function isExplicitNoCode(command: string): boolean {
  const text = requestText(command);
  return NO_CODE_NEGATION.test(text) || RESEARCH_ONLY.test(text);
}

function withoutNoCodePhrases(text: string): string {
  return text.replace(new RegExp(NO_CODE_NEGATION.source, "gi"), " ").replace(new RegExp(RESEARCH_ONLY.source, "gi"), " ");
}

const QUESTION_START =
  /^(kenapa|mengapa|apa|apakah|bagaimana|gimana|gmn|kapan|dimana|di mana|why|how come|what|when|where)\b/i;
const REQUEST_MARKER =
  /\b(tolong|please|pls|coba|minta|bisa(kah)? (kamu|tolong|bantu)|bantu|can you|could you|would you|can we|could we|shall we|bisakah|bisa nggak|bisa gak|silakan)\b/i;

function isPureQuestion(text: string): boolean {
  if (REQUEST_MARKER.test(text)) return false;
  const trimmed = text.trim();
  const endsWithQuestion = trimmed.endsWith("?");
  // A "?" in the middle means a question followed by an instruction.
  const innerQuestion = trimmed.slice(0, -1).includes("?");
  if (innerQuestion) return false;
  return endsWithQuestion || QUESTION_START.test(trimmed);
}


// ─── Run-command requests ("run npm test", "jalankan tes") ───────────────
//
// A request to RUN an allowlisted check is a shell task (run_command, which
// goes through command approval), not a code change: the live test planned
// "run npm test" as code_change and failed with "no file changes" (or wrote
// a TEST_REPORT.md saying the tests were not executed). The targets map onto
// the shared allowlist (utils/commandAllowlist), so a command is only ever
// suggested when the shell executor can actually run it.

const RUN_VERB =
  /\b(?:run|re-?run|execute|exec|jalankan|jalanin|jalankanlah|jalan(?:kan)?in|eksekusi(?:kan)?|lakukan)\b/gi;
/** Natural-language targets → allowlisted command line (checked against ALLOWED_ARGV below). */
const RUN_TARGETS: Array<{ pattern: RegExp; line: string }> = [
  { pattern: /\bnpx\s+tsc(?:\s+--noemit)?\b|\btsc(?:\s+--noemit)?\b/gi, line: "npx tsc --noEmit" },
  { pattern: /\bnpm\s+(?:run\s+)?typecheck\b|\btype[- ]?check(?:s|ing|nya)?\b|\bcek\s+tipe\b|\bpengecekan\s+tipe\b/gi, line: "npm run typecheck" },
  { pattern: /\bnpm\s+run\s+build\b|\bbuild(?:nya)?\b/gi, line: "npm run build" },
  {
    pattern:
      /\bnpm\s+(?:run\s+)?test\b|\bnpm\s+t\b|\b(?:the\s+)?(?:unit\s+)?(?:tests?|testing|testnya|tes|tesnya|test\s*suite|pengujian|ujinya|uji\s+unit)\b/gi,
    line: "npm run test",
  },
];
const NPM_ALIAS = /\bnpm\s+(?:run\s+)?(?:test|build|typecheck)\b|\bnpm\s+t\b|\bnpx\s+tsc\b/i;
// Words that carry no request of their own once the run verb and target are
// gone ("tolong jalankan semua tes sekarang ya", "please run the whole test suite").
const RUN_FILLER =
  /\b(?:tolong|please|pls|coba|dong|ya|yah|aja|saja|sekarang|now|again|lagi|semua|seluruh|all|the|whole|full|project|proyek|repo|repository|di|in|for|untuk|on|and|dan|lalu|then|kasih|tahu|tau|hasil(?:nya)?|results?|report|laporkan|show|me|tunjukkan|lihat|cek|check|can|could|you|kamu|bisa|bantu|minta|it|them|itu|ini|this|with|pakai|pake|using|via|npm|npx|command|perintah|sekali|once|first|dulu|terus)\b/gi;

function allowlistedLineMatches(text: string): Array<{ index: number; line: string; length: number }> {
  const hits: Array<{ index: number; line: string; length: number }> = [];
  // Exact allowlisted lines first, longest first, so "git status --short" wins over "git status".
  const lines = allowedCommandLines().sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();
  for (const line of lines) {
    let from = 0;
    const needle = line.toLowerCase();
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      const before = at === 0 ? " " : lower[at - 1];
      const after = lower[at + needle.length] ?? " ";
      const overlapped = hits.some((hit) => at < hit.index + hit.length && hit.index < at + needle.length);
      if (/[\s"'`(]/.test(before) && /[\s"'`).,;!?]/.test(after) && !overlapped) {
        hits.push({ index: at, line, length: needle.length });
      }
      from = at + needle.length;
    }
  }
  return hits;
}

/**
 * The allowlisted command lines a "run …" request asks for, in request order,
 * or null when the message is not a plain run request: no run verb (and no
 * literal allowlisted command), no known target, a question about the
 * command ("kenapa npm test gagal?"), or a real change request left once the
 * run phrase is removed ("run the tests and fix the failures" is a change).
 */
export function detectRunCommands(command: string): string[] | null {
  const text = requestText(command).trim();
  if (!text) return null;
  if (isPureQuestion(text)) return null;

  const literal = allowlistedLineMatches(text);
  let rest = text;
  const found: Array<{ index: number; line: string }> = literal.map((hit) => ({ index: hit.index, line: hit.line }));
  // Blank out literal matches (same length keeps indexes stable).
  for (const hit of literal) rest = rest.slice(0, hit.index) + " ".repeat(hit.length) + rest.slice(hit.index + hit.length);

  const hasRunVerb = new RegExp(RUN_VERB.source, "i").test(rest);
  // A bare npm/npx command line ("npm test") is a run request without a verb.
  const hasCommandAlias = NPM_ALIAS.test(rest);
  if (hasRunVerb || hasCommandAlias) {
    for (const target of RUN_TARGETS) {
      rest = rest.replace(new RegExp(target.pattern.source, "gi"), (match, ...groups) => {
        const index = groups[groups.length - 2] as number;
        found.push({ index, line: target.line });
        return " ".repeat(match.length);
      });
    }
  }
  if (found.length === 0) return null;
  if (literal.length === 0 && !hasRunVerb && !hasCommandAlias) return null;

  // "jalankan tes, jangan ubah kode": the negated change verb is no request.
  const leftover = withoutNoCodePhrases(rest).replace(RUN_VERB, " ").replace(RUN_FILLER, " ");
  // A remaining change verb, or any other substantial instruction, means the
  // run is part of a bigger request: leave it to the normal classification.
  if (CHANGE_VERB.test(leftover)) return null;
  const words = leftover.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  if (words.length > 2) return null;

  const lines: string[] = [];
  for (const hit of found.sort((a, b) => a.index - b.index)) {
    const [binary, ...args] = hit.line.split(" ");
    const allowed = (ALLOWED_ARGV[binary] ?? []).some(
      (candidate) => candidate.length === args.length && candidate.every((value, i) => value === args[i])
    );
    if (allowed && !lines.includes(hit.line)) lines.push(hit.line);
  }
  return lines.length > 0 ? lines : null;
}

// ─── Complexity / concerns ────────────────────────────────────────────────

const CONCERN_CATEGORIES: Array<{ category: Concern["category"]; pattern: RegExp }> = [
  { category: "tests", pattern: /\b(tests?|testing|unit[- ]?tests?|specs?|vitest|jest|playwright|e2e|coverage|uji|pengujian)\b/i },
  { category: "docs", pattern: /\b(readme|docs?|documentation|dokumentasi|changelog|guide|panduan)\b/i },
  { category: "theme", pattern: /\b(dark ?mode|light ?mode|mode gelap|mode terang|themes?|tema|toggle)\b/i },
  { category: "refactor", pattern: /\b(refactor|refaktor|extract|komponen terpisah|separate component|split|pisah\w*|restructure|rapi\w*)\b/i },
  { category: "style", pattern: /\b(css|styles?|styling|tampilan|warna|colou?rs?|font|layout)\b/i },
];

/** Category of one request clause (first match wins; order above matters). */
export function concernCategory(text: string): Concern["category"] {
  for (const { category, pattern } of CONCERN_CATEGORIES) if (pattern.test(text)) return category;
  return "change";
}

/**
 * Split a change request into its separate concerns: clauses separated by
 * commas, semicolons, new lines or a conjunction ("dan", "and", "serta",
 * "lalu", "then", "also", "juga") that carry their own change verb or a
 * concern keyword. "Tambahkan dark mode dengan toggle di header, refactor
 * header jadi komponen terpisah, tambah test, dan update README" yields
 * theme / refactor / tests / docs.
 */
export function extractConcerns(command: string): Concern[] {
  const text = command.split(/\n\s*---\s*Conversation context\s*---/i)[0] ?? command;
  const clauses = text
    .split(/(?:[,;\n]|\s+(?:dan|and|serta|lalu|kemudian|then|also|plus|juga)\s+)+/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 2);
  const concerns: Concern[] = [];
  for (const clause of clauses) {
    const category = concernCategory(clause);
    const isConcern = CHANGE_VERB.test(clause) || category !== "change";
    if (!isConcern) {
      // A trailing qualifier ("with a toggle") belongs to the previous concern.
      if (concerns.length > 0) concerns[concerns.length - 1].text += `, ${clause}`;
      continue;
    }
    const same = concerns.find((c) => c.category === category && category !== "change");
    if (same) same.text += `, ${clause}`;
    else concerns.push({ category, text: clause });
  }
  return concerns;
}

/**
 * low = one focused concern; medium = two; high = three, or a risky /
 * multi-domain change; ultra = four or more concerns, or three spanning
 * several domains.
 */
export function estimateComplexity(
  command: string,
  concerns: Concern[] = extractConcerns(command),
  domains = 1
): NonNullable<Classification["complexity"]> {
  const n = concerns.length;
  const risky = RISKY.test(command);
  if (n >= 4 || (n >= 3 && domains >= 2)) return "ultra";
  if (n >= 3 || risky || domains >= 2) return "high";
  if (n === 2) return "medium";
  return "low";
}

const RISKY =
  /\b(auth\w*|login|password|token|session|oauth|jwt|permission|security|keamanan|payment|pembayaran|billing|checkout|migrat\w*|migrasi|schema|database|concurr\w*|transaction|transaksi)\b/i;

function withComplexity(classification: Classification, command: string, domains: number): Classification {
  if (classification.kind !== "code_change" && classification.kind !== "multi") return classification;
  const concerns = extractConcerns(command);
  return { ...classification, concerns, complexity: estimateComplexity(command, concerns, domains) };
}

export function classifyCommand(command: string): Classification {
  // Classify the user's own request, never the Sandbox wrapper around it.
  command = unwrapSandboxBrief(command);
  const base = classifyCommandBase(command);
  const text = command.trim();
  const domains = [FRONTEND.test(text), BACKEND.test(text), DESIGN.test(text)].filter(Boolean).length;
  return withComplexity(base, text, Math.max(1, domains));
}

function classifyCommandBase(command: string): Classification {
  const text = command.trim();

  if (!text || GREETING.test(text)) {
    return {
      kind: "conversation",
      strategy: "direct",
      reasons: ["greeting"],
      // O1: greetings go to Support (topic owner), not the CTO.
      suggestedCapabilities: [CAPABILITY.DOCUMENTATION],
    };
  }

  // "run npm test" / "jalankan tes": a shell task on the allowlist, checked
  // before the no-code and change-verb rules ("build" is a change verb, and
  // running the tests changes no code even when the user adds "jangan ubah
  // kode").
  const runCommands = detectRunCommands(text);
  if (runCommands) {
    return {
      kind: "command",
      strategy: "single",
      reasons: [`run request for allowlisted command(s): ${runCommands.join(", ")}`],
      suggestedCapabilities: [CAPABILITY.SHELL_EXECUTION],
      commands: runCommands,
    };
  }

  // A vague bug hunt is a read-only Reviewer investigation (findings),
  // before any change-verb or domain rule can turn it into a code_change.
  if (isVagueBugHunt(text)) {
    return {
      kind: "research",
      strategy: "single",
      reasons: ["vague bug hunt without a symptom: read-only investigation (findings, no changes)"],
      suggestedCapabilities: [CAPABILITY.CODE_REVIEW, CAPABILITY.RESEARCH],
      investigation: true,
    };
  }

  const hasChangeVerb = CHANGE_VERB.test(text);
  const request = requestText(text);
  const explicitNoCode = isExplicitNoCode(text);
  const hasFrontend = FRONTEND.test(text);
  const hasDesign = DESIGN.test(text);
  const hasBackend = BACKEND.test(text);
  const hasTesting = TESTING.test(text);
  const hasSecurity = SECURITY.test(text);

  // Questions keep their domain hints ("How do I style a React button?"
  // is a frontend question): domain capabilities first, then research and
  // code-review, so routing picks the domain expert, not the reviewer.
  const researchCapabilities = (): string[] =>
    Array.from(
      new Set([
        ...(hasFrontend ? [CAPABILITY.FRONTEND] : []),
        ...(hasBackend ? [CAPABILITY.BACKEND] : []),
        ...(hasDesign ? [CAPABILITY.DESIGN] : []),
        CAPABILITY.RESEARCH,
        CAPABILITY.CODE_REVIEW,
      ])
    );

  // Explicit no-code request: always research (read-only, locked plan),
  // whatever verbs it carries. An audit phrased that way keeps its reviewer
  // capability but is still research: an audit task may delegate a fix, and
  // the user said not to change code.
  if (explicitNoCode) {
    const auditLike = AUDIT_ONLY.test(request);
    return {
      kind: "research",
      strategy: "single",
      reasons: [
        "explicit no-code request (research/question only)",
        ...(auditLike ? ["read-only audit requested"] : []),
      ],
      suggestedCapabilities: Array.from(
        new Set([
          ...(auditLike ? [hasSecurity ? CAPABILITY.SECURITY : CAPABILITY.CODE_REVIEW] : []),
          ...researchCapabilities(),
        ])
      ),
    };
  }

  // "riset …" / "research …" with no change verb left: a research task.
  if (RESEARCH_WORD.test(request) && !CHANGE_VERB.test(withoutNoCodePhrases(request))) {
    return {
      kind: "research",
      strategy: "single",
      reasons: ["research requested without a change request"],
      suggestedCapabilities: researchCapabilities(),
    };
  }

  if (AUDIT_ONLY.test(text) && !hasChangeVerb) {
    return {
      kind: "audit",
      strategy: "single",
      reasons: ["read-only audit requested"],
      suggestedCapabilities: [
        hasSecurity ? CAPABILITY.SECURITY : CAPABILITY.CODE_REVIEW,
      ],
    };
  }

  if (!hasChangeVerb && QUESTION.test(text)) {
    return {
      kind: "research",
      strategy: "single",
      reasons: ["question without a change request"],
      suggestedCapabilities: researchCapabilities(),
    };
  }

  // Pure question: "Kenapa kita perlu refactor ini?" asks about a change,
  // it does not request one. A change verb alone is not enough to start a
  // code-change plan when the whole message is a single question (starts
  // with a question word or ends with "?") and carries no request marker
  // ("tolong", "please", "can you", ...). "Kenapa lambat? ganti ke postgres"
  // does not end with "?", so its trailing instruction still wins.
  if (hasChangeVerb && isPureQuestion(text)) {
    return {
      kind: "research",
      strategy: "single",
      reasons: ["question about a change, not a change request"],
      suggestedCapabilities: researchCapabilities(),
    };
  }

  const domains = [hasFrontend, hasBackend, hasDesign].filter(Boolean).length;
  if (domains >= 2) {
    const suggested: string[] = [];
    if (hasDesign) suggested.push(CAPABILITY.DESIGN);
    if (hasFrontend) suggested.push(CAPABILITY.FRONTEND);
    if (hasBackend) suggested.push(CAPABILITY.BACKEND);
    suggested.push(CAPABILITY.CODE_REVIEW, CAPABILITY.BROWSER_TESTING);

    return {
      kind: "multi",
      strategy: "dag",
      reasons: ["request spans multiple domains", "requires coordinated changes"],
      suggestedCapabilities: Array.from(new Set(suggested)),
    };
  }

  if (hasChangeVerb) {
    const plainFileOnly =
      !hasFrontend &&
      !hasBackend &&
      !hasDesign &&
      PLAIN_DATA_FILE.test(text) &&
      !CODE_FILE.test(text);
    const suggested: string[] = [
      hasDesign
        ? CAPABILITY.DESIGN
        : plainFileOnly
          ? CAPABILITY.BACKEND
          : hasFrontend || !hasBackend
            ? CAPABILITY.FRONTEND
            : CAPABILITY.BACKEND,
    ];
    if (hasTesting) suggested.push(CAPABILITY.BROWSER_TESTING);
    suggested.push(CAPABILITY.CODE_REVIEW);
    return {
      kind: "code_change",
      strategy: "single",
      reasons: plainFileOnly
        ? ["plain text/data file change", "no frontend/backend domain indicated"]
        : ["change request detected"],
      suggestedCapabilities: Array.from(new Set(suggested)),
    };
  }

  const plainFileOnly =
    !hasFrontend &&
    !hasBackend &&
    !hasDesign &&
    PLAIN_DATA_FILE.test(text) &&
    !CODE_FILE.test(text);
  return {
    kind: "code_change",
    strategy: "single",
    reasons: ["defaulted to a focused implementation task"],
    suggestedCapabilities: [
      plainFileOnly ? CAPABILITY.BACKEND : CAPABILITY.FRONTEND,
      CAPABILITY.CODE_REVIEW,
    ],
  };
}

export function isGreeting(command: string): boolean {
  return GREETING.test(command.trim());
}
