# Classifier eval dataset

- `classifier.cases.ts` (50 hand-written intent cases) + `classifier.extra-cases.ts`
  (24 cross-language shapes + 30 real DemoApp prompts) = **104 cases**.
- `held-out.json` is frozen: 31 ids, ~1/3 of every `(kind, language)` stratum.
  **Never tune prompts, regexes, or fixtures on held-out cases, and never use
  them as few-shot examples.** Report tuning and held-out numbers separately.
- `baseline.json` freezes the current known failures; regenerate with
  `pnpm --filter @fhara/worker eval:classifier --update-baseline`.
- Owner-approved labels (2026-11-25): typo → backend-development **only for
  `.md`/`.txt`/plain data files**; verify → research + browser-testing, with a
  test proving the forced plan has no write node; design → research **only for
  the "show options" phase** — if a design task applies artifacts to the repo,
  this label is invalid and the case must be relabelled.
