# Mock fixtures and the mock LLM

Build and test the UI and its flows without a real model (a nous replan takes
5–8 minutes) and without GitHub. The idea comes from threadbear's mock runner
and synthetic fixtures (MIT, see `THIRD_PARTY_NOTICES.md`).

| Command | What it does |
| --- | --- |
| `npm run fixtures:make` | Regenerates `fixtures/scenarios/` from `scripts/fixtures/make-synthetic.mjs` (deterministic, commit-safe). |
| `npm run fixtures:seed` | Loads every scenario into the dev deployment (`-- --only planned-push,direct-idle`, `-- --list`). |
| `npm run fixtures:wipe` | Deletes every fixture row, plus rows later written under a fixture project or chat (`-- --only <id>`). |
| `npm run mock:llm` | Starts an OpenAI-compatible stub on `127.0.0.1:3399` with scripted replies. |

## Scenarios

| Id | What you see |
| --- | --- |
| `planned-push` | A done task: plan v1 (implement → review), a changes card, passed verification, approved apply + push, PR #42 open with CI passed, brief and a project memory. |
| `command-approval` | A running task whose Backend waits on a `run_command` card (`npm run test`, Always allow offered). |
| `held-resume` | A task paused by a provider 429 (`pausedBy: "held"`), the hold notice and the Resume button; `resumeAt` lands 3 minutes after seeding. |
| `verify-loop-failed` | Verification fails three times (two fix rounds), the task fails with the typecheck log tail. |
| `personal-chat` | A personal chat with the CTO (no project), a reply with reasoning and a quoted follow-up. |
| `research-fanout` | Three research angles in parallel; RA-2 times out; the synthesis answers from the other two. |
| `direct-idle` | A direct OpenCode thread (Frontend): one finished turn with reasoning, a read, an edit diff and a test run, now idle. |

Skipped: the designer `show_options` review (no `show_options` in the schema at
this head). Add it to the generator when the schema has it.

Every scenario is a project named `[fixture] …` (the personal chat has none).
Existing agents are reused by role, so the seeded tasks show your real team;
agents a fixture had to create are removed only by a full wipe. While seeded,
the fixture personal chat with the CTO is the newest one, so it shows instead of
your own until you wipe.

## Seeding

The seeder calls the internal mutations `devFixtures:seed` / `devFixtures:wipe`
through `npx convex run` (from `apps/api`), so it targets the deployment the
Convex CLI would: `CONVEX_SELF_HOSTED_URL` + `CONVEX_SELF_HOSTED_ADMIN_KEY`, or
`CONVEX_DEPLOYMENT`, from your shell or `apps/api/.env.local`.

It never writes to a real deployment by accident. Two guards:

1. The script refuses unless the target is self-hosted/local
   (`CONVEX_SELF_HOSTED_URL`, or `CONVEX_DEPLOYMENT=local:…|anonymous:…`), or
   `FHARA_FIXTURES=1` is set in your shell.
2. The mutations refuse a `*.convex.cloud` deployment unless `FHARA_FIXTURES=1`
   is set **on the deployment** (`npx convex env set FHARA_FIXTURES 1`). Set it
   only on a dev deployment.

Every inserted row is recorded in the `devFixtureRows` table, so the wipe
deletes exactly what a seed wrote and is safe to repeat. Seeding a scenario
again replaces it. Timestamps are shifted so each scenario ends "now".

With the sandbox's self-hosted backend:

```bash
export CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3299
export CONVEX_SELF_HOSTED_ADMIN_KEY="$(cat /path/to/convexdata/adminkey)"
(cd apps/api && npx convex deploy --yes)   # once, so devFixtures exists on the backend
npm run fixtures:seed
npm run fixtures:wipe
```

## The mock LLM

```bash
npm run mock:llm                      # 127.0.0.1:3399, 30 Hz stream
npm run mock:llm -- --speed 10        # ten times faster; --speed 0 = no delay
npm run mock:llm -- --scenario held-resume --port 0 --no-token
```

It prints its base URL and writes `{ baseUrl, token }` to
`$TMPDIR/fhara-mock-llm/mock-llm.json` (mode 0600; `--data-dir` to move it).
In Settings › LLM add a provider of kind `openai-compatible` with that base URL
and the token as its API key, and the model `mock/default` (or
`mock/<scenario>`). The Convex chat actions can use it too when the backend is
local. It binds to loopback only.

Replies come from `scripts/mock-llm/scripts/default.json` (`--script` or
`MOCK_LLM_SCRIPT` for another file): rules matched in order on the request text,
each recognising one worker role by its prompt wording (classifier, planner,
decision advisor, research assistant and synthesis, reviewer, commit message,
code change, memory and role learnings). A rule may be limited to a scenario
(`mock/<scenario>` model, `x-mock-scenario` header or `--scenario`), answer with
an HTTP status (`429` twice for `held-resume`, `500` for RA-2 in
`research-fanout`), play several replies in order, or stop after `times` uses.
`GET /__mock/calls` lists the requests it saw, `POST /__mock/reset` clears them.

The worker test `packages/worker/tests/mockLlm.test.ts` drives it through the
real `OpenAICompatibleProvider` and checks the default replies against the
worker's own parsers (plan validator, intent, file blocks, review), so a prompt
change that would break the scripted run fails there first.

## Playwright screenshots

Seed, start the web app against the same backend, and screenshot the seeded
pages. A spec outside the default suite (it needs the stack):

```ts
// apps/web/tests/e2e/fixtures.spec.ts (opt-in: FHARA_FIXTURES_E2E=1)
import { expect, test } from "@playwright/test";

test.skip(!process.env.FHARA_FIXTURES_E2E, "needs npm run fixtures:seed and the web app");

test("held task shows the hold notice", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /\[fixture\] Held task/ }).click();
  await page.getByText("Dark mode toggle").click();
  await expect(page.getByText(/On hold: .*Retrying automatically/)).toBeVisible();
  await page.screenshot({ path: "test-results/fixtures/held-resume.png", fullPage: true });
});
```

```bash
npm run fixtures:seed
npm run dev:web   # in another terminal, NEXT_PUBLIC_CONVEX_URL pointing at the seeded backend
FHARA_FIXTURES_E2E=1 npx --workspace=@fhara/web playwright test tests/e2e/fixtures.spec.ts
```

The spec above is an example; it is not committed and has not been run. Select
by role and accessible name (no `data-testid`), as the smoke skill asks.

## Golden replay tests

`packages/worker/tests/fixturesReplay.test.ts` replays every scenario's event
stream through the UI's pure selectors: the sequence merge behind
`useSequencedEvents` (fed out of order, with duplicates), the run replay
timeline, the decisions tray, the compact activity log and the hold notice. The
derived state is snapshotted in `packages/worker/tests/__golden__/<id>.json`.
Accept an intended change with
`npx --workspace=@fhara/worker vitest run tests/fixturesReplay.test.ts -u` and
review the diff.

Other checks: `apps/api/convex/devFixtures.test.ts` seeds every fixture through
the real schema (convex-test validates each insert), and covers re-seed, wipe
and the guard; `packages/worker/tests/fixturesDrift.test.ts` fails when the
committed fixtures differ from what the generator writes.

## Adding a scenario

1. Add a function to `scripts/fixtures/make-synthetic.mjs` and list it in
   `buildAll()`. Use the builder: `s.row(table, key, fields)` returns a
   `$ref:<table>/<key>` string for other rows; `s.taskEvent` / `s.agentEvent`
   number the streams; `s.anchorAt(ms)` sets the moment that becomes "now".
2. Write made-up content only: no real transcripts, repositories, tokens or
   home paths (the drift test rejects the obvious ones).
3. `npm run fixtures:make`, then run the three tests above with `-u` once for
   the new golden file.
4. A table the seeder does not know yet goes in `FIXTURE_TABLES`
   (`apps/api/convex/lib/devFixtures.ts`), in insert order.
