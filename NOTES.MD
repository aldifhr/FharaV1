https://github.com/csantisdev/ai-orchestrator/tree/production/orchestrator
https://github.com/zvenoai/coder/tree/main/prompts ini juga

Daftar `prompts/` orch: `agent_system`, `agent_memory_entry`, `agent_message`, `allowed_tools`, `commit_message`, `control_system`, `plan_roadmap`, `review_system`, `review_task`, `route` (+ `jobs/`). Fhara yang sama di `packages/worker/src/prompts/` (builder bertipe TS, output di-parse `utils/json.ts`).

Yang menarik, cocok buat Fhara:

| Ide orch | Nilai untuk Fhara |
| --- | --- |
| Kontrak output JSON ketat: `status` enum + `files_changed` + `learnings` | **Adaptasi ringan.** `learnings` adalah loop umpan-kembali yang belum ada di Fhara (ada carry-forward & replan feedback, tapi insight lintas-retry tidak dipersisten). Parser `json.ts` sudah ada — tinggal tambah field. |
| Review decision tree (required vs non-required, pre-existing vs introduced, definisi “auto-fixable”) | **Layak disalin.** `review.ts` + `review_task`-nya Fhara masih generik; pohon keputusan ini jauh lebih teruji. |
| “Check sudah fixed sebelum file issue baru” (`gh issue list` + `git log`) | **Layak.** Planner bisa cek duplicate/closed sebelum emit subtask — menghemat token & antrean. |
| Checklist wajib sebelum output (status git, log) | **Sudah tertutup mitigasi** — verification loop Fhara sudah memaksa. Framing-nya bisa dipinjam saat menulis ulang prompt CodeChange. |

masukin ke langsung aja

Yang menarik untuk diterapkan ke Fhara:

| Job orch | Adaptasi ke Fhara |
| --- | --- |
| **agent-debugger** | **Paling berguna.** Pola `self-review` Fhara yang terjadwal: agregasi failure + rate-limit + cost dari `tokenUsage`/`taskEvents`/`lifecycleHistory`, lalu issue ber-`path:line` + root cause. Tanpa perubahan arsitektur — cukup cron Convex + agent `audit`. |
| **weekly-review** | Layak untuk konteks lokal: rangkuman mingguan (shipped vs gagal vs prioritas) ke `memories`/doc. Beda dengan self-review: weekly informatif, self-review dedup+actionable. |
| **code-development-orch** | Cocok sebagai “planner audit” mingguan: prioritas simplifikasi > fitur baru, verifikasi sebelum file (aturan orch: cek git log 7 hari + `rg` dulu), maks 2–3 issue/run. **Sengaja tidak** file issue di luar Fhara sendiri — task-nya langsung menjadi task Fhara. |
| **refactor-orch** | Adaptasi dengan batasan Fhara (tanpa Rust/cargo pedantic): characterization test dulu, diff <10 menit, skip file yang baru berubah <2 hari — mirip audit `improve` yang sudah ada. |
| **code-review-orch** | Bingkai auditnya (manifest: correctness > fitur, observability, kontrak) sudah dicover plan 023 (reviewer). Jika dirender sebagai job terjadwal, hanya sebagai bingkai audit tanpa agen injeksi LLM. |

gas terapin