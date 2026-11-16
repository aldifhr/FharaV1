# Plan 060: FharaV2-style settings.json model for chat via the worker

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

IN PROGRESS

## Why

Plan 059 made project chat CTO-first, but the live app replied "No LLM API key
configured": chat actions skip OpenCode rows by design (`lib/chat/llm.ts`,
`orderedChatPairs`) and the deployment's only HTTP model (`9router/nous`) is
unavailable. The user wants the model selected FharaV2-style in `settings.json`
(`defaultModelSelection`) to drive chat too, using the local `opencode` CLI.

## Decisions

- Add a root `settings.json` with FharaV2's `defaultModelSelection.instanceId`
  and `model` (`opencode/hy4-flash-free`). The worker reads it; no credential is
  stored there — OpenCode uses its own CLI auth.
- Reuse the token-gated `repoToolCalls` queue (no schema change): chat enqueues
  one `opencode_chat` call with the composed prompt and model; the online worker
  claims it, runs `opencode run -m <model>` with the prompt on stdin, and writes
  the answer back. The chat action polls and deletes the row.
- Only calls whose resolved config is the OpenCode row take the bridge. HTTP
  providers keep the existing streaming path unchanged.
- Repo tools and the approval gate are untouched; the CLI runs with `--pure`
  and a wall-clock timeout, and its binary/model come from settings, never
  from a chat message.

## Steps

1. Root `settings.json` + worker reader (`packages/worker/src/tools/chatLlm.ts`):
   parse `defaultModelSelection.model`; `FHARA_SETTINGS_PATH` overrides the
   path. Check: worker unit test for the reader.
2. `apps/api/convex/repoTools.ts`: `enqueueChatLlm` internal mutation (larger
   arg cap, fixed tool name). Check: api typecheck.
3. `packages/worker/src/services/repoTools.ts`: dispatch `opencode_chat` before
   the workspace check. Check: worker typecheck + repo tool tests.
4. `apps/api/convex/chat.ts`: `callChatLlmViaWorker` + a `completeChat` wrapper
   used at every `completeWithSnapshot` call site; bridge only for OpenCode
   config. Check: api typecheck + chat tests.
5. Live smoke: send "create new file hello.html" in the running project chat;
   expect `Sent to Faray`, a CTO answer with a short plain-HTML plan, an
   `@Rey` handoff, and the Create task offer. Check: Convex message rows.
6. Set this plan DONE and report what was not checked.

## Out of scope

No change to the task/plan contract, approvals, credentials, or the web UI.
