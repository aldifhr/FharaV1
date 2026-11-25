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
  runs the executor with a QA agent, a code_change node and a fake LLM that
  proposes a write; `saveFileChange` is a STUB, so the proof is the `failed`
  result with `/Refused/`, plus the negative control where the permission
  check is mocked off and the write is reached. The check that the real git
  working tree stays clean is corroborating, not the primary assertion.
## Decision trace policy (approved 2026-11-25)

Each task gets one trace written on **every** path, including fast-path, LLM
success, invalid LLM output, budget veto and validator override. Fields: `at`,
`stage`, `choice`, `source` (`fast-path | llm | fallback | validator-override`),
`reasonCode` from a fixed enum (model prose is mapped, never stored as free
text), `proposedChoice` **in addition to** `choice` on validator override,
`model`, `tokensIn`, `tokensOut`, `decisionId`, `promptVersion`, `schemaVersion`.
No raw prompt, raw command, or tool output is stored; `traceCanary.test.ts`
pins that rule with a unique marker. Proof it is load-bearing: adding a
`rawReason` field containing the canary made that test **red once**
(2026-11-25), then the field was removed and the test is green again.

`taskEvents` is the existing sink. No TTL/pruning job was found in this tree:
rows live until the task/project is deleted. **Adding any free-text column to
the trace or to `taskEvents` requires the owner's explicit approval**, because
retention has no TTL. `TASK_EVENT_WINDOW_DEFAULT=500`,
`TASK_EVENT_WINDOW_MAX=1000` bound per-task reads — a long task's trace can be
cut off by that window, so the trace is NOT the sole source for measuring
decision quality; the eval datasets are. Readers: web task thread / run trace
through `taskEvents.listByTask`, `pageByTask`, `sinceByTask`
(`apps/api/functions/taskEvents.ts`), and worker/backend internals; public
queries filter by `visibleProjectIds` / `getVisibleTask`, and local mode has no
auth provider. Trace payloads must therefore stay non-sensitive.

- Hidden cases live in `hidden.cases.local.json` (gitignored, supplied by the
  owner). `pnpm --filter @fhara/worker eval:hidden` runs them once and prints
  only counts and accuracies; it has not been run.
- `baseline.json` notes: `chg-013` and `chg-014` (ES/FR code changes without a
  file path) are known failures to be fixed by the semantic classifier, not by
  more regex.
- `pnpm --filter @fhara/worker eval:model` is a separate OPT-IN paid real-model
  eval (not in `test:evals`/CI). Latest run 2026-11-25: model `farayag`
  (9router compatible endpoint), schema v1, temperature 0, 3 runs, shared
  harness grader. Token prices are unavailable in the registry, so reported
  cost is 0 (unknown, not free). Tuning 73: kind **86,3–86,3%**, full
  **78,1–78,1%**. Held-out 31: kind **80,6–83,9%**, full **74,2–77,4%**.
  Source distribution per run: fast-path 90, llm 0–1, fallback 13–14. After
  splitting the catch-all, those failures are `LLM_SCHEMA_INVALID`, not
  `LLM_ERROR`/`LLM_EMPTY`/`LLM_NOT_JSON`: with `response_format: json` the model
  returned valid JSON, but `capability` was free text instead of a
  `CAPABILITY` enum, `concerns` was sometimes a string instead of an array,
  and `investigation` was a string instead of a boolean. So the blocker is
  schema adherence, not JSON transport. Paired comparison: 0 fixed, 0–1 broken
  (held-out English). Upper bound: 14 defaulted cases, of which 6 are wrong in
  the deterministic classifier (4 tuning, 2 held-out) — the maximum gain from
  an LLM is 6 cases, which meets the owner's stop rule. Investigation stopped
  here: a second model was NOT tried, the flag stays OFF, and no prompt was
  tuned on these numbers.
- Owner-approved labels (2026-11-25): typo → backend-development **only for
  `.md`/`.txt`/plain data files**; verify → research + browser-testing, with a
  test proving the forced plan has no write node; design → research **only for
  the "show options" phase** — if a design task applies artifacts to the repo,
  this label is invalid and the case must be relabelled.
