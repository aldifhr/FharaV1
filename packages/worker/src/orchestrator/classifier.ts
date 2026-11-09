import { CAPABILITY, type Classification } from "./types";

const GREETING = /^(hi|hello|hey|halo|hai|yo|good (morning|afternoon|evening))[!.,?\s]*$/i;
// Expanded verb coverage (Stage A fast path only — semantic stage below
// correctly handles migrate/convert/indirect phrasing without this list).
// Strong change verbs only: generic words (perlu/menggunakan/pakai/jalankan)
// were removed — they match plain questions ("Kenapa API ini menggunakan
// Convex?" is research, not a code change). QUESTION is checked first below.
const CHANGE_VERB =
  /\b(add|create|build|implement|make|update|edit|fix|change|refactor|remove|delete|rename|move|style|redesign|tambah|buat|ubah|perbaiki|hapus|migrate|convert|scaffold|porting|port|setup|install|pindah|konversi|pasang|sesuaikan|ganti|switch|ganti ke|pindah ke|too slow|should switch|switch to|postgres)\b/i;
const AUDIT_ONLY =
  /\b(audit|review|inspect|analy[sz]e|check for|security review|code review)\b/i;
const QUESTION =
  /\b(explain|how does|how do|why|what is|what are|where is|document|describe|summari[sz]e|pelajari|learn|study|explore|understand|apa|mengapa|kenapa)\b/i;
const FRONTEND =
  /\b(frontend|front-end|ui|ux|react|next\.?js|component|page|button|form|layout|css|tailwind|responsive|design)\b/i;
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
const TESTING = /\b(test|tests|qa|e2e|playwright|vitest|coverage)\b/i;
const SECURITY = /\b(security|vulnerab|authz|xss|csrf|injection|secret)\b/i;

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

export function classifyCommand(command: string): Classification {
  const text = command.trim();

  if (!text || GREETING.test(text)) {
    return {
      kind: "conversation",
      strategy: "direct",
      reasons: ["greeting"],
      suggestedCapabilities: [CAPABILITY.GENERAL],
    };
  }

  const hasChangeVerb = CHANGE_VERB.test(text);
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
