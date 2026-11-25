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
- `verifyPlanReadOnly.test.ts` checks the plan structure only: a verification
  plan is read-only-locked and has no write node. `verifyExecutionReadOnly.test.ts`
  is the execution guard: a QA agent is given a code_change node plus a fake LLM
  that proposes a write, the executor refuses, and a real git working tree is
  unchanged.
## Decision trace policy (approved 2026-11-25)

Each task gets one trace written on **every** path, including fast-path, LLM
success, invalid LLM output, budget veto and validator override. Fields: `at`,
`stage`, `choice`, `source` (`fast-path | llm | fallback | validator-override`),
`reasonCode` from a fixed enum (model prose is mapped, never stored as free
text), `proposedChoice` **in addition to** `choice` on validator override,
`model`, `tokensIn`, `tokensOut`, `decisionId`, `promptVersion`, `schemaVersion`.
No raw prompt, raw command, or tool output is stored; `traceCanary.test.ts`
pins that rule with a unique marker.

`taskEvents` is the existing sink. No TTL/pruning job was found in this tree:
rows live until the task/project is deleted. `TASK_EVENT_WINDOW_DEFAULT=500`,
`TASK_EVENT_WINDOW_MAX=1000` bound per-task reads. Readers: web task thread /
run trace through `taskEvents.listByTask`, `pageByTask`, `sinceByTask`
(`apps/api/functions/taskEvents.ts`), and worker/backend internals; public
queries filter by `visibleProjectIds` / `getVisibleTask`, and local mode has no
auth provider. Trace payloads must therefore stay non-sensitive.

- Hidden cases live in `hidden.cases.local.json` (gitignored, supplied by the
  owner). `pnpm --filter @fhara/worker eval:hidden` runs them once and prints
  only counts and accuracies; it has not been run.
- Owner-approved labels (2026-11-25): typo → backend-development **only for
  `.md`/`.txt`/plain data files**; verify → research + browser-testing, with a
  test proving the forced plan has no write node; design → research **only for
  the "show options" phase** — if a design task applies artifacts to the repo,
  this label is invalid and the case must be relabelled.
