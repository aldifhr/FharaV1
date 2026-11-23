# Plan 071: Use the global model for every call type

## Status

- Priority: P1
- Size: M
- Risk: MEDIUM
- Dependencies: 032, 035, 038, 060
- Planned at: 2026-11-23

## Why this is needed

The user expects the selected global model to serve task, ask/chat, review, and QA calls. Today task routing in `packages/worker/src/services/runner/nodes/executionResolver.ts` resolves executor calls, while `packages/worker/src/execution/agentExecutor.ts` explicitly keeps review on the API path and skill preload calls `handlesFor` directly. Chat has its own worker bridge in `packages/worker/src/tools/chatLlm.ts` and backend pool resolution in `apps/api/functions/lib/chat/llm.ts`. These independent paths can use a different provider or fail with credentials for a provider the user did not select.

## Target behaviour

- The app-wide selected model/runtime is used for task, ask/chat, review, and any LLM-backed QA.
- API/provider failover follows only the configured global selection policy; no implicit provider is introduced by a call type.
- Deterministic browser checks remain deterministic and do not call an LLM.
- Provider failure names the selected provider/model and does not silently claim another was used.

## Current state

- `packages/worker/src/services/runner/nodes/executionResolver.ts` resolves `callRole: "executor"` and determines the runtime/model for DAG nodes.
- `packages/worker/src/execution/agentExecutor.ts` excludes `review` and `qa` from the native runtime branch; `executeReview` uses `handlesFor(input)` around line 1942.
- `packages/worker/src/execution/agentExecutor.ts` `withOnDemandSkills` invokes the API fallback chain around lines 767-800, even when the selected execution runtime is native.
- `packages/worker/src/tools/chatLlm.ts` reads `settings.json` and invokes the selected model through OpenCode; `apps/api/functions/chat.ts` and `apps/api/functions/lib/chat/llm.ts` still resolve the backend provider pool for other chat cases.

## Decisions

- Treat the global runtime/model selection as authoritative across call types. Do not use per-agent model values when a global setting exists.
- Preserve deterministic QA and the review verdict/JSON contract; native review must produce a parsed verdict before it can be accepted.
- No credentials may cross the backend boundary as plaintext, and existing budget, cancellation, and approval gates remain in force.

## Steps

1. **Done:** Make the legacy app-wide runtime/model authoritative in the worker resolver, bypassing model-list routing when that global setting is configured.
2. **Done:** Run review through the selected native model and parse its strict verdict; do not fall back to another provider when native runtime is unavailable or returns invalid output.
3. **Done:** Skip API-backed on-demand skill selection on native runtime and record why. Deterministic browser QA remains unchanged.
4. **Existing chat path verified by inspection:** project ask/chat uses `orderedChatPairs` over the enabled global model list (`apps/api/functions/lib/chat/llm.ts`) and routes OpenCode through the worker bridge (`apps/api/functions/chat.ts`). Personal chat deliberately excludes native CLI because it has no project-scoped worker bridge.
5. **Done:** Add regression coverage for app-wide runtime precedence and native review verdict parsing.

## Test plan

- Worker unit tests prove review and skill calls use the chosen global route and parse valid verdicts.
- API chat tests prove global model selection is used and no unselected provider is tried.
- Focused worker/API typechecks and unit tests; no live-provider calls in the default suite.

## Completion criteria

- Project task, project ask/chat, and review calls use the global selection; deterministic QA remains local.
- No implicit Anthropic/API fallback occurs when a different global runtime/model was selected.
- Budget and cancellation gates run before every LLM request.
- Focused checks pass and this plan is marked DONE.

## Verification log

- Worker: `pnpm --filter @fhara/worker exec vitest run tests/opencodeRuntime.test.ts tests/runnerNodes.test.ts` — 41 passed, 1 skipped.
- Worker: `pnpm --filter @fhara/worker run typecheck` — passed.
- Chat selection and bridge were inspected, not changed: project chat uses the global ordered model list and OpenCode worker bridge. Personal conversations still exclude OpenCode because the existing queue requires project scope; extending that bridge is not part of this worker-only patch.
- API chat suite not run because the API path was not modified.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- A schema migration is required.
- A focused check fails twice after a reasonable fix.
