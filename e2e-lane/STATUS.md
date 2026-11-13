# e2e chat lane, 2026-11-13 (backup ref, not for main)

Sandbox (aarch64, 8 GB, RAM-backed /) reset ~8 times; /workspace/work tooling was gone after the first reset.

Verified:
- fixtures-ui (mock, no LLM) on a91d768: 32/33; the one FAIL (held-resume "Resume now")
  was a test bug (clicked header breadcrumb). Fixed in 68b5383 + 4720c25; held-resume then 7/7.
- web tsc + unit tests taskDock/systemLine/optimisticChat/agentStatus pass for e681729 and 1affb3d.
- chat-hold-line present (fixtures-ui held-resume chat check ok); TaskDock + centered status line seen in held-resume chat shot.

Not verified (sandbox died before the run): chat routing in the browser, bubbles/avatars screenshots,
Plan-mode loop, zero-read nudge, Indonesian replies, live Nous scenarios 1-4.
