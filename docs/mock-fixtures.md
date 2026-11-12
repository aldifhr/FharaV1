# Mock fixtures and the mock LLM

Build and test the UI and its flows without a real model (a nous replan takes
5–8 minutes) and without GitHub. The idea comes from threadbear's mock runner
and synthetic fixtures (MIT, see `THIRD_PARTY_NOTICES.md`).

| Command | What it does |
| --- | --- |
| `npm run fixtures:make` | Regenerates `fixtures/scenarios/` from `scripts/fixtures/make-synthetic.mjs` (deterministic, commit-safe). |
| `npm run fixtures:seed` | Loads every scenario into the dev deployment (`-- --only planned-push,held-resume`, `-- --list`). |
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
decision advisor, research assistant and synthesis (plain, or as `{"answer": …}` when the web_reach tool loop is offered), reviewer, commit message,
code change, memory and role learnings, and the Convex chat reply). A rule may be limited to a scenario
(`mock/<scenario>` model, `x-mock-scenario` header or `--scenario`), answer with
an HTTP status (`429` twice for `held-resume`, `500` for RA-2 in
`research-fanout`), play several replies in order, or stop after `times` uses.
`GET /__mock/calls` lists the requests it saw, `POST /__mock/reset` clears them.

The worker test `packages/worker/tests/mockLlm.test.ts` drives it through the
real `OpenAICompatibleProvider` and checks the default replies against the
worker's own parsers (plan validator, intent, file blocks, review), so a prompt
change that would break the scripted run fails there first.

### Wire faults

A rule can break the wire instead of answering cleanly (`"fault": …`; the call
log and `GET /__mock/calls` name the fault each request got). The idea and the
names follow DeepSeek Harness's LLM mock server (MIT, see `THIRD_PARTY_NOTICES.md`).

| `fault` | On the wire |
| --- | --- |
| `partial_disconnect` | Some deltas, half an SSE frame, then the socket is destroyed (non-stream: half the JSON body). |
| `connection_reset` | The socket is destroyed before any byte. |
| `stall` | Headers and some deltas, then silence until the client gives up. |
| `malformed_chunk` | One SSE frame is broken JSON carrying the next piece of the reply; the stream then finishes normally (non-stream: a cut body). |
| `stream_eof` | Some deltas, then a clean end with no `finish_reason` and no `[DONE]`. |
| `context_overflow` | HTTP 400 (or `status`) with a provider's context-length text: `overflowWording` `openai` (default), `deepseek` or `anthropic`. |
| `server_error` | HTTP `status` (default 503); `times: 3` makes a burst. |

`faultAfterChunks` sets how many content deltas go out before a stream fault
strikes (default: half the reply). `scripts/mock-llm/scripts/faults.json`
extends the default script with one scenario per fault: model
`mock/partial-disconnect` (`connection-reset`, `stall`, `malformed-chunk`,
`stream-eof`, `context-overflow`, `server-error`) fails the first request that
way (`server-error`: the first three), then the default rules answer.

`packages/worker/tests/mockLlmFaults.test.ts` checks each fault on the raw
wire. `packages/worker/tests/llmWireFaults.test.ts` records how the worker
handles each one (provider, `runLlmCall` retry). D2 classified each fault (typed errors in
`apps/api/convex/lib/llmWireErrors.ts`, re-exported by `packages/worker/src/llm/errors.ts`;
the backend chat client raises the same ones):

- a dropped stream (undici's bare `terminated`) is an `LlmConnectionError`
  ("LLM connection closed mid-reply …"), classed `connection`, retryable;
- a malformed SSE frame or a cut non-stream body is an
  `LlmMalformedResponseError`, retryable, never a reply with a hole or an
  empty success;
- a stream with no `finish_reason`/`[DONE]` (Anthropic: no `message_stop`)
  is an `LlmIncompleteResponseError` carrying `partial` (and
  `partialReasoning` in chat) for interrupted-reply persistence; it is never
  a completed answer;
- a context overflow (OpenAI / DeepSeek / Anthropic wording) is an
  `LlmContextOverflowError`: no cooldown and no rotation (`cooldownForFailure`
  kind `context_overflow`). `context/overflowRecovery.ts` head/middle/tail-prunes
  the old messages, re-checks against the named limit, compacts the middle only
  if still over (summary when a summarizer is given, else a drop note), and
  retries at most twice, inside `compaction.start`/`compaction.end` events; then
  a clear failure. The tool loop uses it;
- a timeout names its limit ("timed out after 250ms", "after 1.5s").

Also handled: a stall is cut by the LLM timeout (a timeout, not a cancel); a
reset is a `connection` failure; a 5xx burst is retried by `runLlmCall`.

### Verify the world

Check the files, not the agent's report. `packages/worker/tests/helpers/assertUntouched.ts`
(`snapshotTree`, `changesOutside`, `assertUntouched`) fails when anything
outside the allowed paths changed, was added or was removed since the
snapshot (`.git`, `node_modules` and `.moagent-worktrees` are ignored).
`e2e/fixtures-ui/world.mjs` is the same check for the live flows: with
`--reset-repo`, `worker-flows.mjs` snapshots the repo before each flow and
checks afterwards that nothing outside the `allowedPaths` of the flow script's
plans changed (a flow with no plan must leave the repo byte-identical).

## UI checks and screenshots (`npm run test:fixtures-ui`)

`e2e/fixtures-ui/run.mjs` drives the seeded screens the way threadbear's
`Tools/tour-e2e.mjs` does: one plain Node script (playwright-core, no test
runner), a `check()` per visible state, a numbered PNG per screen, and exit 1
on any failed check. Per scenario it opens the run page, the project chat or
board, the Inbox, Home or the personal chat and asserts what should be there
(Allow/Deny on the command card, Resume now on the held task, Failed with the
TS2322 tail, RA-2 failed with the synthesis done, a working Delete on the personal chat). It writes `results.json`
next to the shots.

```bash
npm run fixtures:seed                       # CONVEX_SELF_HOSTED_URL + _ADMIN_KEY set
NEXT_PUBLIC_CONVEX_URL=$CONVEX_SELF_HOSTED_URL npm run dev:web -- -p 3010
FHARA_CHROMIUM=/path/to/chromium npm run test:fixtures-ui -- --base http://127.0.0.1:3010 --shots ./shots
npm run test:fixtures-ui -- --only held-resume,planned-push
```

The personal-chat check deletes the seeded chat; seed again before rerunning it.

`e2e/fixtures-ui/worker-flow.mjs --project <id>` runs one live flow: it sends
an instruction in that project's chat (pressing **Create task** when the chat
reply only offers it), polls the task's status until done/failed/paused, and
shoots the chat and run page. Point the worker at the mock LLM (an
`openai-compatible` provider row with the mock's base URL and token) and the
project at a throwaway local git repo with no remote. The default mock script
answers the Convex chat reply (`chat-reply`, matched on the project chat
persona line; `chat-reply-personal` for personal chats): the CTO says it is a
small change and to press Create task. A chat message never starts a task by
itself (only the Create task button, an explicit command or a go-reply to an
offer does), so the flow then presses the button the server offered.
