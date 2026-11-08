import { CAPABILITY, type Classification } from "./types";

const GREETING = /^(hi|hello|hey|halo|hai|yo|good (morning|afternoon|evening))[!.,?\s]*$/i;
// Expanded verb coverage (Stage A fast path only — semantic stage below
// correctly handles migrate/convert/indirect phrasing without this list).
const CHANGE_VERB =
  /\b(add|create|build|implement|make|update|edit|fix|change|refactor|remove|delete|rename|move|style|redesign|tambah|buat|ubah|perbaiki|hapus|migrate|convert|scaffold|porting|port|setup|install|pindah|konversi|pasang|sesuaikan|jalankan|ganti|perlu|perlu di|perlu di-refactor|perlu refactor|harusnya|kayaknya|kayaknya perlu|bisa jalan pakai|bisa jalan dengan|dapat jalan pakai|pakai docker|menggunakan|pakai next|switch|ganti ke|pindah ke|too slow|should switch|switch to|jalankan|pakai postgres|postgres)\b/i;
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
const TESTING = /\b(test|tests|qa|e2e|playwright|vitest|coverage)\b/i;
const SECURITY = /\b(security|vulnerab|authz|xss|csrf|injection|secret)\b/i;

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
      suggestedCapabilities: [CAPABILITY.RESEARCH, CAPABILITY.CODE_REVIEW],
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
    const suggested: string[] = [
      hasDesign
        ? CAPABILITY.DESIGN
        : hasFrontend || !hasBackend
          ? CAPABILITY.FRONTEND
          : CAPABILITY.BACKEND,
    ];
    if (hasTesting) suggested.push(CAPABILITY.BROWSER_TESTING);
    suggested.push(CAPABILITY.CODE_REVIEW);
    return {
      kind: "code_change",
      strategy: "single",
      reasons: ["change request detected"],
      suggestedCapabilities: Array.from(new Set(suggested)),
    };
  }

  return {
    kind: "code_change",
    strategy: "single",
    reasons: ["defaulted to a focused implementation task"],
    suggestedCapabilities: [CAPABILITY.FRONTEND, CAPABILITY.CODE_REVIEW],
  };
}

export function isGreeting(command: string): boolean {
  return GREETING.test(command.trim());
}
