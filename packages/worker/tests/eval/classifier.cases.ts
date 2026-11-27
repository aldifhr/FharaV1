/**
 * Ground-truth cases for the intent classifier eval.
 *
 * Expectations describe what a human would say is the CORRECT outcome for the
 * request, NOT what the classifier currently returns. A failing case is a
 * finding, not a typo: add it here and let it fail until the classifier is
 * fixed (it is then listed in baseline.json as a known failure).
 *
 * Only set optional fields (strategy / primaryCapability / investigation)
 * when the answer is unambiguous.
 */
export type CaseKind = "conversation" | "audit" | "research" | "code_change" | "multi" | "command";
export type CaseLang = "en" | "id" | "other";

export interface ClassifierCase {
  /** Stable id: used by baseline.json, never reuse or renumber. */
  id: string;
  command: string;
  lang: CaseLang;
  expect: {
    kind: CaseKind;
    strategy?: "direct" | "single" | "dag";
    /** suggestedCapabilities[0] */
    primaryCapability?: string;
    /** kind "research" only: vague bug hunt (no symptom). */
    investigation?: boolean;
    /** kind "command" only. */
    commands?: string[];
  };
}

const FE = "frontend-development";
const BE = "backend-development";

export const CLASSIFIER_CASES: ClassifierCase[] = [
  // ── conversation ───────────────────────────────────────────────────────
  { id: "conv-001", command: "hello", lang: "en", expect: { kind: "conversation", strategy: "direct" } },
  { id: "conv-002", command: "halo", lang: "id", expect: { kind: "conversation", strategy: "direct" } },
  { id: "conv-003", command: "good morning", lang: "en", expect: { kind: "conversation", strategy: "direct" } },
  { id: "conv-004", command: "thanks!", lang: "en", expect: { kind: "conversation", strategy: "direct" } },
  { id: "conv-005", command: "makasih ya", lang: "id", expect: { kind: "conversation", strategy: "direct" } },
  { id: "conv-006", command: "こんにちは", lang: "other", expect: { kind: "conversation", strategy: "direct" } },

  // ── command (allowlisted shell runs) ───────────────────────────────────
  { id: "cmd-001", command: "npm run test", lang: "en", expect: { kind: "command", commands: ["npm run test"] } },
  { id: "cmd-002", command: "run npm run build", lang: "en", expect: { kind: "command", commands: ["npm run build"] } },
  { id: "cmd-003", command: "jalankan npm run typecheck", lang: "id", expect: { kind: "command", commands: ["npm run typecheck"] } },
  { id: "cmd-004", command: "run the tests", lang: "en", expect: { kind: "command", commands: ["npm run test"] } },
  { id: "cmd-005", command: "jalankan tes, jangan ubah kode", lang: "id", expect: { kind: "command", commands: ["npm run test"] } },
  { id: "cmd-006", command: "run npm run typecheck and then npm run test", lang: "en", expect: { kind: "command", commands: ["npm run typecheck", "npm run test"] } },
  { id: "cmd-007", command: "テストを実行して", lang: "other", expect: { kind: "command" } },

  // ── audit (read-only review) ───────────────────────────────────────────
  { id: "aud-001", command: "audit the authentication flow for security issues", lang: "en", expect: { kind: "audit", strategy: "single" } },
  { id: "aud-002", command: "do a security review of the login module", lang: "en", expect: { kind: "audit" } },
  { id: "aud-003", command: "lakukan security review pada modul login", lang: "id", expect: { kind: "audit" } },
  { id: "aud-004", command: "review the code in src/api and report problems, don't change anything", lang: "en", expect: { kind: "audit" } },
  { id: "aud-005", command: "audit dependensi proyek ini", lang: "id", expect: { kind: "audit" } },

  // ── research (questions, explanations, vague bug hunts) ────────────────
  { id: "res-001", command: "how does the approval flow work?", lang: "en", expect: { kind: "research" } },
  { id: "res-002", command: "explain how the DAG scheduler retries failed nodes", lang: "en", expect: { kind: "research" } },
  { id: "res-003", command: "Kenapa API ini menggunakan FharaRuntime?", lang: "id", expect: { kind: "research" } },
  { id: "res-004", command: "apa fungsi file planner.ts?", lang: "id", expect: { kind: "research" } },
  { id: "res-005", command: "summarize the architecture of the worker package", lang: "en", expect: { kind: "research" } },
  { id: "res-006", command: "jelaskan cara kerja scheduler", lang: "id", expect: { kind: "research" } },
  { id: "res-007", command: "how do I add a new agent role?", lang: "en", expect: { kind: "research" } },
  { id: "res-008", command: "jangan ubah kode, jelaskan bagaimana auth bekerja", lang: "id", expect: { kind: "research" } },
  { id: "res-009", command: "search bug", lang: "en", expect: { kind: "research", investigation: true } },
  { id: "res-010", command: "cari bug di folder src", lang: "id", expect: { kind: "research", investigation: true } },
  { id: "res-011", command: "find bugs in the checkout flow", lang: "en", expect: { kind: "research", investigation: true } },
  { id: "res-012", command: "Wie funktioniert der Genehmigungsablauf?", lang: "other", expect: { kind: "research" } },
  { id: "res-013", command: "¿Cómo funciona el planificador de tareas?", lang: "other", expect: { kind: "research" } },

  // ── code_change (one concern) ──────────────────────────────────────────
  { id: "chg-001", command: "fix the button label in app/page.tsx", lang: "en", expect: { kind: "code_change", strategy: "single" } },
  { id: "chg-002", command: "rename getUser to fetchUser in src/api/users.ts", lang: "en", expect: { kind: "code_change", strategy: "single" } },
  { id: "chg-003", command: "perbaiki typo di README.md", lang: "id", expect: { kind: "code_change", primaryCapability: BE } }, // owner approval pending: repo policy routes plain data files to Backend
  { id: "chg-004", command: "Create seed-data.json with two records", lang: "en", expect: { kind: "code_change", primaryCapability: BE } },
  { id: "chg-005", command: "Add a timer to app.js", lang: "en", expect: { kind: "code_change", primaryCapability: FE } },
  { id: "chg-006", command: "ubah warna tombol jadi biru", lang: "id", expect: { kind: "code_change", primaryCapability: FE } },
  { id: "chg-007", command: "buat endpoint GET /health di server", lang: "id", expect: { kind: "code_change", primaryCapability: BE } },
  { id: "chg-008", command: "refactor the retry logic in dagScheduler.ts", lang: "en", expect: { kind: "code_change", strategy: "single" } },
  { id: "chg-009", command: "hapus fungsi yang tidak dipakai di utils/date.ts", lang: "id", expect: { kind: "code_change", strategy: "single" } },
  { id: "chg-010", command: "fix the crash when the cart is empty", lang: "en", expect: { kind: "code_change" } },
  { id: "chg-011", command: "update the Dockerfile to use node 22", lang: "en", expect: { kind: "code_change" } },
  { id: "chg-012", command: "tambahkan dark mode toggle di navbar", lang: "id", expect: { kind: "code_change", primaryCapability: FE } },
  { id: "chg-013", command: "Corrige el botón en la página de inicio", lang: "other", expect: { kind: "code_change" } },
  { id: "chg-014", command: "Ajoute un endpoint API pour lister les utilisateurs", lang: "other", expect: { kind: "code_change" } },
  { id: "chg-015", command: "bikin fungsi buat validasi email di utils/validate.ts", lang: "id", expect: { kind: "code_change" } },

  // ── multi (several domains / concerns, needs a DAG) ────────────────────
  { id: "mul-001", command: "add a billing page in the frontend and create a new API endpoint on the backend", lang: "en", expect: { kind: "multi", strategy: "dag" } },
  { id: "mul-002", command: "tambahkan halaman profil di frontend dan buat endpoint API di backend", lang: "id", expect: { kind: "multi", strategy: "dag" } },
  { id: "mul-003", command: "redesign the dashboard UI and add a metrics API on the server", lang: "en", expect: { kind: "multi", strategy: "dag" } },
  { id: "mul-004", command: "build a login form in the frontend, the auth endpoint in the backend, and a database migration", lang: "en", expect: { kind: "multi", strategy: "dag" } },
];
