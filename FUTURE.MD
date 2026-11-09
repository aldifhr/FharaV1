# FUTURE.MD — Evaluasi paket & backlog fitur

Catatan evaluasi paket eksternal terhadap arsitektur Fhara saat ini
(Next.js 16 + Convex + worker terpisah). Paket yang dipasang harus punya
surface yang benar-benar memakainya — dependensi tak terpakai ditandai
`knip` dan menambah bundle.

## Sudah terinstal (dari evaluasi sebelumnya)

| Kebutuhan | Terpasang |
|---|---|
| Markdown renderer streaming | `streamdown` (+ `@streamdown/code`, `@streamdown/math`, `@streamdown/mermaid`, `@streamdown/cjk`) |
| Highlighting / Mermaid / LaTeX | Via plugin Streamdown (`shiki`, `mermaid`, `remark-math`, `rehype-katex`, `katex` transitif) |
| State global frontend | `zustand` (store toast) |
| Virtualisasi list panjang | `@tanstack/react-virtual` (MessageList ≥40 pesan) |
| Visualisasi graf force-directed | `sigma` + `graphology` + `@react-sigma/core` + `@react-sigma/layout-forceatlas2` + `graphology-layout-forceatlas2` + `graphology-communities-louvain` (`/intelligence`) |

## Diadopsi dari Threadbear (mikecann/threadbear)

Threadbear = app Mac/iPhone + `runner/` (daemon pengelola sesi CLI
Claude/Codex per thread) + backend Convex untuk sinkronisasi. Tidak ada
planner/DAG/delegasi antar-agent seperti Fhara — yang diambil hanya
gagasan UX & operasinya, sesuai tabel di bawah.

| Ide | Nilai | Ditulis di | Prasyarat sebelum dikerjakan |
|---|---|---|---|
| Approval/question sebagai kartu tombol inline di transcript + notifikasi saat task butuh user | Paling besar — `/inbox` saat ini berupa baris, Threadbear membuatnya bisa diklik langsung di chat | `TaskThreadPanel`, approval gate (`packages/worker/src/services/runner/applyStage.ts`), inbox (`apps/api/convex/inbox.ts`, `apps/web/app/inbox/page.tsx`) | Kartu approval interaktif di panel chat + notifikasi desktop untuk `waiting_input`/`needs_approval` |
| "Always allow" persisten per command | Mengurangi friksi approval berulang tanpa melemahkan gate | `governance/` (`packages/worker/src/governance/tools.ts`, policy + audit) | Daftar command terpercaya per project; tercatat di audit log, tetap bisa revoke |
| Tanpa project picker (task di project default, classifier yang mem-filing belakangan) | Workflow "start anywhere, file later" | `orchestrator/classifier.ts`, `apps/web/components/NewProject.tsx` | Project default "Unfiled" + auto-classify task baru |
| Idle session release + resume (pola Threadbear: hanya proses thread aktif yang hidup) | Hemat proses/cost pada native provider | `execution/nativeProvider.ts` | Sesi OpenCode dihentikan setelah idle, di-resume by session id |
| Self-update sebagai task (release harian → merge → test → minta izin land) | Dogfooding lewat pipeline QA sendiri | `runner/` (`runQaLoop`), repo update flow | Task khusus upgrade repo sendiri dengan QA gate |
| Task terjadwal (cron) | Threadbear: schedule thread berulang di mesin mana pun | Convex crons + `tasks.create` | Fitur memakai Convex Scheduler (konsisten dengan verdict `croner` di bawah) |
| Patches sebagai panel/tombol interaktif dari skill | Versi kecil: blok interaktif di chat | Skills registry (`apps/web/components/Settings.tsx`, skill v2) | Render blok "jalankan" dari skill, bukan sistem patch penuh |

Sengaja **tidak** diambil: app Swift (Fhara web + Electron), satu CLI per
thread (Fhara berbasis provider API), relay sharing (sudah ada task page/link).

## Backlog kecil dari pekerjaan Streamdown

## Dievaluasi, belum dipasang

| Paket | Verdict | Alasan | Prasyarat sebelum dipasang |
|---|---|---|---|
| `papaparse` | Skip | Tidak ada surface import/export CSV; export tabel di chat sudah ditangani Streamdown | Tentukan surface-nya (mis. export hasil analisis task) |
| `yaml` | Skip | Konfigurasi agent/MCP di Convex DB (`apps/api/convex/mcpServers.ts`), bukan file YAML | UI import/export konfigurasi di Settings |
| `codemirror` | Skip (editable) | `app/api/project-files/route.ts` hanya `GET` (read-only); editor yang bisa save melanggar boundary "UI never touches a workspace file" (`AGENTS.md`) | Jalur tulis resmi lewat worker + approval gate. Viewer read-only + highlight lebih kecil risikonya |
| `@codemirror/lang-sql` | Skip | Tidak ada SQL editor di aplikasi | Ada kebutuhan SQL editor dulu |
| `ag-grid-react` | Skip | Tidak ada permukaan data tabular kompleks; TaskBoard berupa kartu; AG Grid berat (~1MB+) | Surface tabel data yang benar-benar butuh grid interaktif |
| `jmespath` | Skip | Hasil tools berupa teks/diff; tidak ada UI query JSON | Viewer/query JSON untuk hasil tools |
| `croner` | Skip | Scheduling sudah ditangani Convex Scheduler (`ctx.scheduler.runAfter`) + DAG scheduler worker; Convex crons adalah cara platformnya | Fitur cron di luar Convex |
| `jose` | Skip | Auth adalah Convex + service token (`assertServiceToken`); lapisan JWT duplikasi dan menyentuh non-negotiable #2 (`AGENTS.md`) | Keputusan arsitektur auth baru, dicatat di `plans/` |
| `@modelcontextprotocol/ext-apps` | Skip | Integrasi MCP saat ini tool-call loop berbasis teks (`packages/worker/src/mcp/toolLoop.ts`); MCP Apps butuh dukungan resources/UI | Dukungan resources/UI di MCP registry + toolLoop |

## Backlog kecil dari pekerjaan Streamdown

- `ReasoningLine` (`components/ui/trace.tsx`) masih render teks polos — pertimbangkan markdown statis Streamdown setelah diuji visual.
- Virtualisasi `MessageList` belum diuji visual di browser dengan timeline >40 pesan.
- Smoke test visual menyeluruh untuk animasi streaming, caret, dan toast copy-code.
