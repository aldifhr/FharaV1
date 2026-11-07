# MOAgent — Roadmap & Defect Tracker

> Checklist urut dari yang **termudah** ke yang **paling sulit**.
> Last updated 2026-11-05. Sumber: audit manual UI/code
> (`apps/web`, `apps/api/convex`, `packages/worker`).

---

## Checklist (termudah → tersulit)

### File `apps/web/app/page.tsx`

- [ ] **EN-only sweep (4 string)** — ganti sisa Bahasa menjadi Inggris:
  - :194 "Task terbaru" → "Recent tasks"
  - :243 placeholder "Contoh: MOAgent" → "e.g. MOAgent"
  - :249 "Team project" → "Project team"
  - :272 "Path folder Windows" → "Folder path"
- [ ] **Audit sisa copy** — `grep -rn "Yang\|Contoh\|Task terbaru\|Path folder"` setelah sweep; pastikan nol hasil.

### File `apps/web/components/ui/animated-tooltip.tsx`

- [ ] **Dead code** — hapus import `useMemo` yang tidak terpakai.
- [ ] **Positional wrapper** — rapikan `<div>` wrapper posisi; saat ini hanya dipakai 1 agen aktif (bukan stack ala Aceternity).

### File `apps/web/components/AgentAvatar.tsx`

- [ ] **Loading progresif** — tambah `loading="lazy"` + `referrerPolicy="no-referrer"` pada `<img>` avatar.

### File `apps/web/app/chat/page.tsx`

- [ ] **Empty state jujur** — tombol "Open sidebar →" tanpa handler; ganti jadi `<Link href="/">View projects</Link>` + copy yang sesuai.

### File `apps/web/components/ChatPanel.tsx`

- [ ] **Tombol header mati (3 ikon)** — `PanelRight` / `Bell` / `MoreHorizontal` tanpa `onClick` (:176-178).
  - Opsi A: wire — Panel = toggle thread, Notifications = link ke `/inbox`, More = dropdown menu.
  - Opsi B: hapus tombol sampai ada fungsionalitas.

### File `apps/web/app/globals.css`

- [ ] **`@theme inline` warning** — Tailwind 4 syntax pada proyek Tailwind 3.4 (`globals.css:2428`). Pindahkan keyframes ke CSS biasa atau samakan versi Tailwind.

### File hook `useTheme` / `useFont`

- [ ] **Sinkronisasi state** — `use-theme.ts` dan `use-font.ts` terpisah; ganti di satu tempat tidak update di tempat lain sampai remount. Rencana: `plans/004-appearance-unification.md`.
- [ ] **Preferensi `system`** — tambah opsi System di Settings dan inline script (saat ini script awal pakai `prefers-color-scheme`, toggle hanya Light/Dark). Termasuk dalam `plans/004-appearance-unification.md`.

### Komponen Aceternity (dead code)

- [ ] **Keputusan pakai/hapus** — `moving-border`, `timeline`, `bento-grid`, `sparkles` terinstal tapi tidak dipakai di route mana pun (`components/ui/`). Pakai yang relevan atau hapus dari repo.
- [ ] **`3d-card-effect`** — kena **401 Unauthorized** saat install; tidak terpasang. Butuh akses Pro Aceternity atau substitusi manual.

### Query temporal / guard task

- [ ] **Sinkronkan `skip` di semua query anak** — `SectionPage`/`TaskThreadPanel` masih bergantung pada `tasks.listByProject` dan bisa flicker/empty saat mutasi cepat. Mitigasi read-side (`getVisibleTask`) sudah ada, tapi belum ada guard `"skip"` konsisten.

### Feature product (butuh tabel & UI)

- [ ] **Memory khusus** — tabel `memories` (projectId, kind, content) + UI pencarian; saat ini hanya derivasi dari `taskEvents` (`apps/web/app/WorkspaceClient.tsx`). Rencana: `plans/001-memory-store.md`.
- [ ] **Notifikasi in-app** — tabel `notifications` + unread state + badge di `IconRail` (saat ini `api.inbox.list` hanya menghitung masalah live, tanpa status baca). Rencana: `plans/002-in-app-notifications.md`.
- [ ] **Integrations UI** — backend GitHub **sudah ada** (`apps/api/convex/integrations.ts`: OAuth, webhook, list, refresh, `getMcpConfig`); yang belum ada hanya UI + route server-side. Rencana: `plans/003-integrations-ui.md`. Catatan: `getMcpConfig` sudah dijadikan `internalQuery` (2026-11-07) karena mengembalikan token plaintext.

### Security / Auth (paling sulit)

- [ ] **Auth provider** — aktifkan Convex Auth (Clerk/Supabase/dll) agar `ownerId` wajib di semua `projects.create`.
- [ ] **Ownership enforcement** — `apps/api/convex/authz.ts`: saat ini ownership hanya enforce kondisional (single-user local mode). Sidebar/search masih ambil `api.agents.list` / `api.search.global` tanpa filter viewer konsisten.

---

## Selesai ✅

- [x] **Agent non-orchestrator tidak lagi mengaku orchestrator** (2026-11-07) — `apps/api/convex/chat.ts` memakai `agents.find(role ~= architect|lead|orchestrator|planner) ?? agents[0]`, sehingga agent pertama (mis. Faray, `frontend developer`) tetap menerima prompt "You are the orchestrator/planner." Fallback dihapus: hanya role yang cocok mendapat panduan planning, agent lain menjawab sesuai persona-nya. Pesan auto-dispatch juga diterjemahkan ke Inggris.
- [x] **Redirect `/workspace/[projectId]` → `/chats/[id]`** (2026-11-07) — kedua halaman legacy mengarah ke `/chat/:id` yang tidak ada (404). Sekarang mengarah ke route nyata `/chats/:id`.
- [x] **`integrations.getMcpConfig` bukan lagi query publik** (2026-11-07) — query tersebut mengembalikan `GITHUB_TOKEN` plaintext ke siapa pun yang bisa menjangkau deployment. Dijadikan `internalQuery`; belum ada pemanggil, jadi tidak ada perilaku yang berubah.
- [x] **Program perbaikan arsitektur Phase 1–6** (2026-11-07, commit `db25342`…`0c39d95` + Phase 6) — per fase:
  - [x] Phase 1 — race `QA_BASE_URL` dihapus (base URL eksplisit per task); mutation provider token-gated + route server-side; `getRunContext` tidak lagi mengirim field key legacy; validasi `assignedAgentIds`; perbandingan token timing-safe; retry scheduler tidak mengulang error permanen
  - [x] Phase 2 — resolver LLM + provider pool (priority/weighted/`modelPatterns` dikonsumsi); tabel Model Registry `llmModels`; assignment provider/model per agent; enkripsi kredensial AES-256-GCM + migrasi plaintext (`migrations:migrateProvidersAndAgents` / `verifyMigration`)
  - [x] Phase 3 — satu otoritas planning (orchestrator authoritative, planner jadi subrutin); delegasi actionable (APPROVE → subtask nyata, REVISE → fix subtask, BLOCKED → halt anggun); node dinamis scheduler
  - [x] Phase 4 — concurrency per-agent + semaphore LLM; cancellation end-to-end (signal ke LLM/QA/command/verification); retry menghormati deadline & budget; recovery requeue bercheckpoint (batas 3×); hardening: gerbang LLM dua tingkat, persistensi DAG dinamis, guard status terminal di backend, deadline sebelum planning
  - [x] Phase 5 — enforcement budget pra-panggilan (`budget.exhausted`, default mode `warn` satu siklus); usage per-agent/per-provider/per-model + `estimatedCost` dari pricing registry; metrik kesehatan provider di Settings + metrik delegasi di Analytics
  - [x] Phase 6 — validasi penuh terdokumentasi; harness test backend `convex-test` (guard terminal, gerbang token provider, kebersihan kredensial `getRunContext`); `integrations.upsertGithubIntegration` diperbaiki menjadi `internalMutation` (sebelumnya mutation publik yang menyimpan token OAuth)
  - Catatan: item **Auth provider** dan **Ownership enforcement** di atas sengaja tetap terbuka — owner memutuskan prototipe single-user lokal tanpa auth & tanpa rate limiting (accepted by owner); enforcement ownership tetap kondisional by design.
- [x] Orchestrator Phase 1–6 (plan, DAG, lease, approval, QA) — 51 tests hijau
- [x] Modal portal ke `document.body` (fix containing-block `backdrop-blur`)
- [x] Modal Edit agent full-screen, konten centered `max-w-3xl`
- [x] Meta-viewport overflow fix IconRail (tooltip portal, `overflow-x-hidden`)
- [x] New Project fallback `/?new=project` + Suspense `Home` page
- [x] Settings grid removal (`GridPattern` MagicUI di `/chat`)
- [x] SVGL 11 logo terpasang di `components/ui/svgs/`
- [x] Ibelick background (`ShellBackground`) + nav gradient baru
- [x] Aceternity 7 komponen terpasang (kecuali `3d-card-effect` Pro)
- [x] Fitur font (4 pilihan, `localStorage`, `data-font`)
- [x] Guard read-side (`getVisibleTask`) untuk messages/events/fileChanges/approvals/executionView
- [x] Avatar header project sekarang hanya agen project + klik buka Team dengan highlight
- [x] Typecheck + build (web) hijau berulang
