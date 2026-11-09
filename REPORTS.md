# Audit Report — Fhara

Audit bug seluruh repo (report only — tidak ada perbaikan yang dikerjakan).
Metode: 3 audit paralel (backend / worker / web), lalu verifikasi ulang P1
teratas dengan membaca kode langsung. Tidak menjalankan tes, merge, atau
perubahan kode apa pun.

## Backend — `apps/api/convex`

| # | Temuan | Severity | Bukti |
|---|--------|----------|-------|
| B1 | `overview.get` mengembalikan dokumen agent mentah termasuk `llmApiKey` plaintext | P1 | `apps/api/convex/overview.ts:18,76` |
| B2 | `tasks.cancel` menimpa task yang sudah `failed` ("Cancelled by user") | P1 | `apps/api/convex/tasks.ts:284` (terminal = done/rejected/failed) |
| B3 | `rotateEncryptionKeys` hanya rotasi `llmProviders` — ciphertext GitHub/MCP/webhook jadi tidak bisa didekripsi | P1 | `apps/api/convex/migrations.ts:210-213` vs `integrations.ts:275,723`, `mcpServers.ts:177` |
| B4 | `setTaskStatus` tanpa lease fencing — zombie worker bisa menghidupkan/mindahkan task orang lain | P1 | `apps/api/convex/orchestration.ts:1703`, `holdsTaskLease:107` fail-open |
| B5 | Intent `pause` dari chat tidak ada handler-nya | P2 | `apps/api/convex/chat.ts:331,1001` |
| B6 | `pauseForInput` tidak renew lease → task `waiting_input` dicap `leaseLost` bila user >60 dtk | P2 | `apps/api/convex/orchestration.ts:1759`, `heartbeat:373` |
| B7 | `completeTask` menstamp `completedAt` untuk status non-terminal | P2 | `apps/api/convex/orchestration.ts:1662` |
| B8 | `projects.remove` / `tasks.remove` meninggalkan baris credential/history yatim (integrations, mcpServers, tokenUsage, decisions, incidents, contextSnapshots, dll.) | P2 | `apps/api/convex/projects.ts:202` |
| B9 | `agents.getRegistryView/getDetail` + `chatContext.getContext` full-scan `.collect()` | P2 | `apps/api/convex/agents.ts:89,105,458`, `chatContext.ts:230,265` |
| B10 | `getMcpConfig` dead code dan mengembalikan plaintext token | P3 | `apps/api/convex/integrations.ts:1013` |
| B11 | `createFromCommand` `slice(-0)` meniadakan cap 4000 char | P3 | `apps/api/convex/tasks.ts:194-195` |
| B12 | `saveFileChange` saat rewrite mempertahankan `appliedAt`/`appliedByWorkerId` basi | P3 | `apps/api/convex/orchestration.ts:1544` |

## Worker — `packages/worker`

| # | Temuan | Severity | Bukti |
|---|--------|----------|-------|
| W1 | Budget gate ditelan `catch` advisor — task tetap jalan meski `budget.exhausted` dalam enforce mode | P1 | `packages/worker/src/orchestrator/decision.ts:822-827` |
| W2 | Subtask `shell` tidak ada budget gate sebelum panggil LLM | P1 | `packages/worker/src/execution/agentExecutor.ts:1716-1737` (vs 1008/1324/1601 yang bergate) |
| W3 | `withFileContexts` meng-inline `.env`/symlink ke prompt LLM (bypass `resolveSandboxPath`) | P1 | `packages/worker/src/services/runner/setup.ts:344-367` |
| W4 | `readGitHead` pakai argv `rev-parse` yang tidak ada di allowlist → undo commit native mati | P1 | `packages/worker/src/execution/agentExecutor.ts:1867` vs `runCommand.ts:14-27` |
| W5 | Gagal persist dynamic subtask ditelan `catch` — node hilang dari DAG & recovery | P1 | `packages/worker/src/services/runner/decision.ts:460,470,654-669` |
| W6 | Scheduler timeout: attempt lama jadi zombie, controller attempt baru ikut terhapus | P2 | `packages/worker/src/scheduler/dagScheduler.ts:329,368-380,390-394` |
| W7 | `applyStaged` verifikasi via `path.join` mentah (bypass sandbox) | P2 | `packages/worker/src/services/runner/runContext.ts:197` |
| W8 | `incrementRetry` tidak pernah dipanggil di production — budget retry selalu 0 | P2 | `packages/worker/src/orchestrator/budget.ts:163` |
| W9 | `finalize` mengulang seluruh verification suite yang sudah jalan di verify loop | P2 | `packages/worker/src/services/runner/finalize.ts:56` vs `verifyLoop.ts:57` |
| W10 | `compactIfNeeded` dead code (hanya dipanggil test) | P3 | `packages/worker/src/context/compaction.ts:40` |
| W11 | `executeShell` mengeksekusi command tanpa approval gate (`run_command` seharusnya approval) | P3 | `packages/worker/src/execution/agentExecutor.ts:1769` |

## Web — `apps/web`

| # | Temuan | Severity | Bukti |
|---|--------|----------|-------|
| F1 | `resolveSpecifier` tidak menormalisasi `..` — import `../` tidak pernah resolve, edge hilang | P1 | `apps/web/lib/projectGraph.ts:107-118` |
| F2 | Browser Lab: dua poller capture (4 dtk + 8 dtk) masing-masing meluncurkan Chromium penuh | P1 | `apps/web/components/browser-lab/BrowserLab.tsx:117-134`, `app/api/browser-lab/route.ts:47` |
| F3 | `?project=`/`?status=` invalid di Incident Room → query error crash tanpa error boundary | P2 | `apps/web/app/incidents/page.tsx:54-60`, `[id]/page.tsx:33` |
| F4 | Scanner memotong diam-diam di ~350 file tapi toast bilang "Scan complete" | P2 | `apps/web/components/intelligence/ProjectIntelligence.tsx:88`, `app/api/project-files/route.ts:94` |
| F5 | Knowledge Graph me-render graf setengah jadi sebagai graf final (query project belum resolve → `?? []`) | P2 | `apps/web/components/knowledge/KnowledgeGraph.tsx:85-92,101,199` |
| F6 | Route `POST /api/browser-lab` SSRF tanpa auth/allowlist | P2 | `apps/web/app/api/browser-lab/route.ts:14-32` |
| F7 | Ganti project di tengah scan → race, graf project lama bisa tampil atas nama baru | P2 | `apps/web/components/intelligence/ProjectIntelligence.tsx:73,150-155` |
| F8 | Input timebox Sandbox meng-clamp per keystroke (tidak bisa mengetik normal) | P3 | `apps/web/components/sandbox/SandboxStudio.tsx:192-201` |
| F9 | Validasi Sandbox loloskan instruksi >4000 char yang pasti ditolak backend | P3 | `apps/web/lib/sandbox.ts:47-57`, `tasks.ts:140` |
| F10 | `iframe key={url}` reload tiap keystroke di Browser Lab | P3 | `apps/web/components/browser-lab/BrowserLab.tsx:197,226-233` |
| F11 | Selector viewport tidak mengubah ukuran preview iframe live | P3 | `apps/web/components/browser-lab/BrowserLab.tsx:185,231-232` |
| F12 | Knowledge Graph recenter hanya saat node count berubah | P3 | `apps/web/components/knowledge/KnowledgeGraph.tsx:183-186` |
| F13 | "Shared-file" cross-project links diklaim tapi tidak pernah dibuat | P3 | `apps/web/lib/knowledgeGraph.ts:33` |

## Diverifikasi bersih (tidak ada bug)

- Backend: semua action `worker.ts` memakai `withoutToken`/`assertServiceToken`; stripping `getRunContext`; token gate `llmProviders`/`llmModels`; webhook HMAC-before-parse; `autoApprove` re-check mode/task/lease; terminal guard `completeTask`.
- Web: entry IconRail baru semuanya wired; lifecycle Sigma di `SigmaFileGraph.tsx` (single container, reducer stabil, Louvain dijaga pada graf kosong); `llm-providers`/`mcp-servers` route token-at-server + fail closed; tidak ada hook tema kedua, global CSS di luar `app/`, copy non-English, atau tombol tanpa handler dalam scope yang diaudit.

## Verifikasi live-UI (localhost:3000, Playwright, 2026-11-09)

Server dev sedang jalan (`next dev`, HTTP 200 di 17 route; Convex terhubung —
2 project "Fharas"/"Genlatter", 9 agen tampil). Driving dengan console
error + page-error capture per route.

| # | Temuan | Severity | Bukti |
|---|--------|----------|-------|
| L1 | `/team`: hydration mismatch — server render "Loading…", client render "9 agents · all idle"; React me-regenerate tree (flicker + error di console dev) | P2 | `apps/web/app/team/page.tsx:95-99` (teks header dari `useQuery`); pageerror `Hydration failed...` dengan diff `+ 9 agents · all idle / - Loading…` |

Route lain (`/`, `/intelligence`, `/knowledge`, `/incidents`, `/sandbox`,
`/browser-lab`, `/chats`, `/runs`, `/memory`, `/inbox`, `/search`,
`/playground`, `/workflows`, `/evals`, `/audit`, `/library`): **nol console
error / page error**, data Convex tampil normal.

Catatan: bug F1–F13 di atas bersifat runtime/scenario-specific dan tidak
muncul pada kunjungan normal; L1 hanya manifest di dev build (React prod
memperbaiki diam-diam).

## Usulan prioritas perbaikan

1. F1, B1, B2, W1, W2, W3 (keamanan/budget/correctness kritis).
2. F2, F6 (Browser Lab).
3. W5, W6 (ketahanan scheduler).
4. Sisanya P2/P3 sesuai tabel.
