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

- [ ] **Sinkronisasi state** — `use-theme.ts` dan `use-font.ts` terpisah; ganti di satu tempat tidak update di tempat lain sampai remount. Gabung jadi `useAppearance`.
- [ ] **Preferensi `system`** — tambah opsi System di Settings dan inline script (saat ini script awal pakai `prefers-color-scheme`, toggle hanya Light/Dark).

### Komponen Aceternity (dead code)

- [ ] **Keputusan pakai/hapus** — `moving-border`, `timeline`, `bento-grid`, `sparkles` terinstal tapi tidak dipakai di route mana pun (`components/ui/`). Pakai yang relevan atau hapus dari repo.
- [ ] **`3d-card-effect`** — kena **401 Unauthorized** saat install; tidak terpasang. Butuh akses Pro Aceternity atau substitusi manual.

### Query temporal / guard task

- [ ] **Sinkronkan `skip` di semua query anak** — `SectionPage`/`TaskThreadPanel` masih bergantung pada `tasks.listByProject` dan bisa flicker/empty saat mutasi cepat. Mitigasi read-side (`getVisibleTask`) sudah ada, tapi belum ada guard `"skip"` konsisten.

### Feature product (butuh tabel & UI)

- [ ] **Memory khusus** — tabel `memories` (projectId, kind, content) + UI pencarian; saat ini hanya derivasi dari `taskEvents` (`app/workspace/[projectId]/WorkspaceClient.tsx:279`).
- [ ] **Notifikasi in-app** — tabel `notifications` + badge di `IconRail` (saat ini hanya ikon).
- [ ] **Integrations / MCP / webhooks** — section integrations sendiri menyataka "not available in the backend yet" (`WorkspaceClient.tsx:263`). Mulai dari 1 connector (GitHub) + tabel `integrations`.

### Security / Auth (paling sulit)

- [ ] **Auth provider** — aktifkan Convex Auth (Clerk/Supabase/dll) agar `ownerId` wajib di semua `projects.create`.
- [ ] **Ownership enforcement** — `apps/api/convex/authz.ts`: saat ini ownership hanya enforce kondisional (single-user local mode). Sidebar/search masih ambil `api.agents.list` / `api.search.global` tanpa filter viewer konsisten.

---

## Selesai ✅

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
