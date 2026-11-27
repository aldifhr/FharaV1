/**
 * Extra gold cases: 24 cross-language shapes + 30 prompts taken from real
 * DemoApp task history. Labels are written from user intent, not from current
 * classifier output. The three decisions below are marked owner-approval-
 * pending: typo → backend-development (repo policy: plain data files go to
 * Backend), verify → research + browser-testing (read-only), design →
 * research (show_options writes only to a gitignored review dir).
 */
import type { ClassifierCase } from "./classifier.cases";
const FE = "frontend-development";
const BE = "backend-development";
const QA = "browser-testing";

export const EXTRA_CASES: ClassifierCase[] = [
  { id: "x-greet-en", command: "Hello, how are you?", lang: "en", expect: { kind: "conversation" } },
  { id: "x-greet-id", command: "Halo, apa kabar?", lang: "id", expect: { kind: "conversation" } },
  { id: "x-greet-es", command: "Hola, ¿cómo estás?", lang: "other", expect: { kind: "conversation" } },
  { id: "x-greet-ja", command: "こんにちは、元気ですか？", lang: "other", expect: { kind: "conversation" } },
  { id: "x-thanks-en", command: "thanks!", lang: "en", expect: { kind: "conversation" } },
  { id: "x-thanks-id", command: "makasih ya", lang: "id", expect: { kind: "conversation" } },
  { id: "x-question-en", command: "Which file renders the App component?", lang: "en", expect: { kind: "research", primaryCapability: FE } },
  { id: "x-question-id", command: "File mana yang merender komponen App?", lang: "id", expect: { kind: "research", primaryCapability: FE } },
  { id: "x-question-fr", command: "Quel fichier affiche le composant App ?", lang: "other", expect: { kind: "research" } },
  { id: "x-question-de", command: "Wie funktioniert der Genehmigungsablauf?", lang: "other", expect: { kind: "research" } },
  { id: "x-explain-id", command: "jelaskan cara kerja scheduler", lang: "id", expect: { kind: "research" } },
  { id: "x-typo-en", command: "fix typo in README.md", lang: "en", expect: { kind: "code_change", primaryCapability: BE }, /* owner approval pending */ },
  { id: "x-typo-id", command: "perbaiki typo di README.md", lang: "id", expect: { kind: "code_change", primaryCapability: BE }, /* owner approval pending */ },
  { id: "x-comment-en", command: "Add a one-line comment at the top of src/hello.tsx", lang: "en", expect: { kind: "code_change", primaryCapability: FE } },
  { id: "x-comment-id", command: "tambahkan komentar satu baris di atas src/hello.tsx", lang: "id", expect: { kind: "code_change", primaryCapability: FE } },
  { id: "x-comment-de", command: "Füge einen einzeiligen Kommentar oben in src/hello.tsx hinzu", lang: "other", expect: { kind: "code_change" } },
  { id: "x-api-en", command: "Create a /users endpoint in the API and update the docs", lang: "en", expect: { kind: "multi" } },
  { id: "x-api-id", command: "tambah endpoint /users dan perbarui README", lang: "id", expect: { kind: "multi" } },
  { id: "x-verify-en", command: "Verify that http://127.0.0.1:5173 loads and report the HTTP status", lang: "en", expect: { kind: "research", primaryCapability: QA }, /* owner approval pending */ },
  { id: "x-verify-id", command: "periksa apakah http://127.0.0.1:5173 dapat diakses dan laporkan statusnya", lang: "id", expect: { kind: "research", primaryCapability: QA }, /* owner approval pending */ },
  { id: "x-qa-nocode-en", command: "@QA check the build, do not change any file", lang: "en", expect: { kind: "research", primaryCapability: QA }, /* owner approval pending */ },
  { id: "x-qa-nocode-id", command: "@QA periksa build-nya, jangan ubah file apa pun", lang: "id", expect: { kind: "research", primaryCapability: QA }, /* owner approval pending */ },
  { id: "x-design-en", command: "Propose two wireframes for the Status page", lang: "en", expect: { kind: "research" }, /* owner approval pending */ },
  { id: "x-design-id", command: "usulkan dua wireframe untuk halaman Status", lang: "id", expect: { kind: "research" }, /* owner approval pending */ },
  { id: "real-001", command: "@DevOps, sebutkan secara singkat apakah repo ini punya konfigurasi CI dan di file apa. Jangan buat task.", lang: "id", expect: { kind: "research" } },
  { id: "real-002", command: "I choose A: Pesan status terpusat", lang: "id", expect: { kind: "conversation" } },
  { id: "real-003", command: "@Designer, usulkan dua wireframe sederhana untuk halaman Status dan tampilkan sebagai opsi A/B.", lang: "id", expect: { kind: "research" } },
  { id: "real-004", command: "Tanpa membuat task, jawab singkat: file mana yang merender komponen utama App? Sertakan pathnya.", lang: "id", expect: { kind: "research", primaryCapability: FE } },
  { id: "real-005", command: "audit DemoApp", lang: "en", expect: { kind: "audit" } },
  { id: "real-006", command: "inspect this project and report which framework is used, where the entry point is, and how to run the dev server. Do not edit files.", lang: "en", expect: { kind: "audit" } },
  { id: "real-007", command: "@QA verify the app at the QA base URL loads and report the HTTP status only. No screenshots, no file changes.", lang: "en", expect: { kind: "research", primaryCapability: QA } },
  { id: "real-008", command: "@Lead answer in one short sentence: what is the main goal of this project? Do not change files.", lang: "en", expect: { kind: "research" } },
  { id: "real-009", command: "@DevOps propose a minimal CI job name and the exact command for typecheck only. Answer in prose; do not change files.", lang: "en", expect: { kind: "research" } },
  { id: "real-010", command: "@Backend based on what we discussed, what command runs the app locally? Answer in one sentence; do not change files.", lang: "en", expect: { kind: "research", primaryCapability: BE } },
  { id: "real-011", command: "@Frontend which source file renders the About page? Answer only; do not change files.", lang: "en", expect: { kind: "research", primaryCapability: FE } },
  { id: "real-012", command: "@Designer propose two layout directions for the About page with wireframes, for me to pick from. Analysis only; do not change files.", lang: "en", expect: { kind: "research" } },
  { id: "real-013", command: "@CTO compare two ways to add a loading state to the About page. Answer in prose only; do not change files.", lang: "en", expect: { kind: "research" } },
  { id: "real-014", command: "@Designer propose a three-card About page layout: intro card, stack card, links card. Analysis only; do not change files.", lang: "en", expect: { kind: "research" } },
  { id: "real-015", command: "@Designer propose a two-section About page layout variant: a short intro and a tech list. Analysis only; do not change files.", lang: "en", expect: { kind: "research" } },
  { id: "real-016", command: "@CTO create a task: @Designer propose a compact layout spec for the About page with exactly three sections. Analysis only; do not change files.", lang: "en", expect: { kind: "research" } },
  { id: "real-017", command: "Create a task: @Backend based on the README section we just discussed, state in one sentence how to run the app. Answer only, do not change files.", lang: "en", expect: { kind: "research", primaryCapability: BE } },
  { id: "real-018", command: "Create a task: @DevOps propose a minimal CI job name and command for typecheck only, without changing files.", lang: "en", expect: { kind: "research" } },
  { id: "real-019", command: "Create a task: @QA verify the app loads and report only the HTTP status. No screenshots and no file changes.", lang: "en", expect: { kind: "research", primaryCapability: QA } },
  { id: "real-020", command: "Create a task: @Backend summarize what README.md says about running the app. Answer only, do not change files.", lang: "en", expect: { kind: "research", primaryCapability: BE } },
  { id: "real-021", command: "Create a task: @Frontend explain which source file renders the About page. Answer only, do not change files.", lang: "en", expect: { kind: "research", primaryCapability: FE } },
  { id: "real-022", command: "Create a task: @Designer propose a two-color accent scheme for the About page. Analysis only, do not change files.", lang: "en", expect: { kind: "research" } },
  { id: "real-023", command: "Create a task: add a second one-line comment directly below the existing comment in src/status.tsx saying the status is static demo data. Change only that file.", lang: "en", expect: { kind: "code_change", primaryCapability: FE } },
  { id: "real-024", command: "Create a task: check whether the app at the local preview URL loads without console errors and report the result. Do not change files.", lang: "en", expect: { kind: "research", primaryCapability: QA } },
  { id: "real-025", command: "Based on README.md, what is the main goal of this project? Answer only; do not change files.", lang: "en", expect: { kind: "research", primaryCapability: BE } },
  { id: "real-026", command: "Create a task: propose a simple color palette for the status page. Analysis only; do not change files.", lang: "en", expect: { kind: "research" } },
  { id: "real-027", command: "Create a task: check the app at the local preview URL and report whether the page loads without console errors. Do not change files.", lang: "en", expect: { kind: "research", primaryCapability: QA } },
  { id: "real-028", command: "Create a task: add a short 'Getting started' section to README.md saying 'Run npm install and npm run dev.' Change only README.md.", lang: "en", expect: { kind: "code_change", primaryCapability: BE } },
  { id: "real-029", command: "Add a one-line comment at the top of src/status.tsx saying this is the status page. Change only that file.", lang: "en", expect: { kind: "code_change", primaryCapability: FE } },
  { id: "real-030", command: "add new page about.tsx and add more details about About", lang: "en", expect: { kind: "code_change", primaryCapability: FE } },
];
