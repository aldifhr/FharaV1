# Classifier eval dataset

- `classifier.cases.ts` (50 hand-written intent cases) + `classifier.extra-cases.ts`
  (24 cross-language shapes + 30 real DemoApp prompts) = **104 cases**.
- `held-out.json` is frozen: 31 ids, ~1/3 of every `(kind, language)` stratum.
  **Never tune prompts, regexes, or fixtures on held-out cases, and never use
  them as few-shot examples.** Report tuning and held-out numbers separately.
- `baseline.json` freezes the current known failures; regenerate with
  `pnpm --filter @fhara/worker eval:classifier --update-baseline`.
- Valid baseline measured at commit `5ddb90b945d7c822ec47af714e48b9a3944ed61a`
  on branch `fhara/plan-085-baseline` (created from `origin/main` 4395b2d9e4 with
  **only the eval files**; the earlier 148-file snapshot was rejected because
  it changed `orchestrator/planningHint.ts`, `providerCapability.ts` and
  `verificationPlan.ts`). 104 cases: overall kind **69.2%** / full **64.4%**;
  tuning 73 → **72.6% / 67.1%**; held-out 31 → **61.3% / 58.1%**. Step 2 must
  raise held-out by ≥3 clean cases, with no regression and tuning not lower.
- `verifyWorkingTree.test.ts` is the integration guard: a verification plan is
  read-only-locked and leaves a real git working tree unchanged.
- Owner-approved labels (2026-11-25): typo → backend-development **only for
  `.md`/`.txt`/plain data files**; verify → research + browser-testing, with a
  test proving the forced plan has no write node; design → research **only for
  the "show options" phase** — if a design task applies artifacts to the repo,
  this label is invalid and the case must be relabelled.
