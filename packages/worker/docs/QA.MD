# QA Sistem — Per-Workspace Verification

## Status Saat Ini

Verifikasi otomatis sudah berjalan (typecheck → lint → test → build) tapi **salah sasaran**: selalu mengarahkan ke `127.0.0.1:3000`, bukan ke aplikasi yang sedang dikerjakan. Ini membuat QA selalu menghasilkan `inconclusive` untuk project non-web.

## Masalah Inti

`runResponsiveQa` membuka `127.0.0.1:3000` dengan Playwright screenshot. Tidak tahu app mana yang harus di-test karena:

- Tidak ada `devUrl`/`qaUrl` per project
- Worker tidak punya akses jaringan ke project yang dijalankan
- Setiap project punya stack berbeda (Next.js, Vite, Express, dsb.)

## Opsi Desain

### Opsi A: `devUrl`/`qaUrl` di Schema Project

Tambahkan field opsional ke `projects` table:

```ts
devUrl?: string;   // e.g. "http://localhost:3000"
qaUrl?: string;    // e.g. "https://staging.myapp.com"
```

- **Pro**: Paling straightforward, tidak perlu ubah worker logic
- **Con**: User harus isi manual, harus stabilize port per project

### Opsi B: Workspace-level Dev Server Management

Worker mengelola proses dev server sendiri:

```ts
interface DevServer {
  processId: number;
  port: number;
  workspacePath: string;
  startedAt: number;
}
```

- Worker `startDevServer(workspacePath)` → запускает `npm run dev` atau `next dev`
- Playwright membuka `http://localhost:<port>`
- Worker menghentikan server saat task selesai (atau idle timeout)
- **Pro**: Tidak perlu user mengkonfigurasi, works untuk semua project
- **Con**: Worker jadi lebih kompleks; port allocation; resource management; idempotency

### Opsi C: Hybrid — Auto-detect dari `package.json`

Jika project punya script dev tertentu (Next.js, Vite, dsb.), worker auto-starts dengan port default:

| Framework | Start command         | Port  |
|-----------|-----------------------|-------|
| Next.js   | `next dev`            | 3000  |
| Vite      | `vite`                | 5173  |
| CRA       | `react-scripts start`  | 3000  |
| Expo      | `expo start`          | 8081  |
| Express   | user-defined          | manual|

Worker deteksi dari `package.json` scripts + devDependencies.

- **Pro**: Zero-config untuk stack umum
- **Con**: Edge cases; harus maintain mapping; belum tentu support semua stack

### Opsi D: QA Agent sebagai Subtask

Daripada worker auto-start server, buat `qa` subtask kind baru yang menjalankan browser testing agent (Playwright/Cypress) secara self-contained dalam workspace:

- Agent menyiapkan env, install deps, start server, run tests, collect results, teardown
- Tidak ada port conflict; workspace-scoped
- **Pro**: Sangat fleksibel; setiap project bisa punya `qa` agent berbeda
- **Con**: Agent complexity + latency tinggi; perlu LLM call untuk setup

## Rekomendasi

**Opsi B (Workspace-level Dev Server Management)** paling robust untuk use case MOAgent: worker ephemeral, workspace sementara, tidak ada port conflict karena 1 task per workspace.

Implementasi bertahap:

1. **Fase 1**: Skema `projects.devUrl` + driver check di `runResponsiveQa` (paling simpel, langsung works)
2. **Fase 2**: Worker auto-starts dev server per workspace + port management
3. **Fase 3**: Port allocation pool + graceful teardown

## QA Check Types

Beyond screenshot (viewport regression), QA bisa ekspansi:

- **API smoke test** — `curl` endpoint kesehatan
- **Accessibility scan** — `axe-core` via Playwright
- **Performance budget** — bundle size, LCP threshold
- **Broken link check** — crawl + validate hrefs

## Pending

- [ ] Schema update: `projects.devUrl`
- [ ] `runResponsiveQa` baca `devUrl`
- [ ] Worker start/stop dev server lifecycle
- [ ] Port allocation pool
- [ ] Graceful teardown on task complete / timeout
