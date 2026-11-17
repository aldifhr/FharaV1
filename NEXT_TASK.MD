B. Safety net reaktif: wire callWithOverflowRecovery ke jalur LLM utama (runLlmCallWithFallback) sehingga overflow di semua call role ter-recover, bukan cuma tool loop. Effort kecil, robustness besar.

Task-outcome memory otomatis (rekomendasi) — saat task finalize, tulis ringkasan ringkas ke table (atau row memories kind baru): title, outcome (done/failed + kenapa), files yang tersentuh, keputusan penting dari evaluator. getRunContext inject 3–5 outcome terakhir sebagai section "Recent task history" (bounded chars) ke planner + executor. Bounded, otomatis, terlihat di halaman Memory.

kenapa beberapa model jadi task only ? kenapa ga jadi semua aja