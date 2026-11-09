# FUTURE.MD — Evaluasi paket & backlog fitur

Catatan evaluasi paket eksternal terhadap arsitektur MOAgent saat ini
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
