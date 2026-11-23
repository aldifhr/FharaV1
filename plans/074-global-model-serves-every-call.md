# Plan 073: Global model serves every LLM call, including setup and planner

## Status

- State: DONE (2026-11-23)
- Priority: P1
- Size: L
- Risk: MEDIUM
- Dependencies: 038, 060, 071, 072
- Planned at: 2026-11-23

## Why this is needed

A user can select `opencode/hy4-flash-free` as the app-wide model and still get:

```
No LLM provider can serve: no enabled connection offers a matching model (need: {}). Candidates: "9router".
```

`resolveForAgent` deliberately drops native-CLI connections from the API path
(`packages/worker/src/llm/resolver.ts:240`). `taskRunner` calls
`llmResolver.defaultConfig()` at setup (`services/taskRunner.ts:134`), and the
planner / decision / memory / commit call sites use `handlesFor()` on that same
API-only pool. Those calls never see the global OpenCode model. When the only
HTTP connection has no model registered, setup fails before any subtask runs —
even though a perfectly good global model is selected.

Plan 071 made subtask execution and review use the global native model, but
left the API-path call sites on the HTTP pool. This plan closes that gap.

## Target behaviour

- The app-wide model/runtime serves **every** LLM call: setup default config,
  planner, decision advisor, executor, review, memory, commit message, and
  any LLM-backed QA.
- No HTTP connection with a registered model is required when the global
  selection is a native CLI model.
- Deterministic browser QA remains deterministic.
- Budget and cancellation gates still run before every call; credentials do
  not cross the backend boundary (CLI uses its own operator login).

## Decisions

- **Adapter, not a second planner.** Keep the one authoritative resolver and
  the one ordered chain. Add a native-CLI implementation of `LLMProvider`
  (`complete` / `stream`) so existing call sites keep their interface — no
  parallel routing path (root AGENTS: one planning authority).
- **One worker resolver, no runtime flag.** The backend neutralises
  `opencodeRuntime` to `"api"` once an OpenCode row exists, so a flag cannot
  tell which model is selected. The worker resolver therefore always admits
  native CLI entries; the app-wide ordered model list alone decides whether
  one actually answers. Chat uses a separate backend resolver and never opts in.
- **Reuse the existing CLI plumbing.** `runChatLlm`
  (`tools/chatLlm.ts:108`) already composes a prompt and runs
  `opencode run -m <model>` with a bounded spawn. Generalize it into a
  completion adapter rather than introducing a new process launcher. The
  full `nativeProvider` policy machinery stays for subtasks with file edits.
- **Structured output stays the caller's contract.** Planner/review prompts
  already ask for strict JSON; the adapter returns the CLI's text verbatim so
  the existing parsers keep working. No silent model substitution.
- **No env fallback reintroduced** (plan 072). The adapter uses the resolved
  global model id and OpenCode's own credentials only.
- **Explicit failure.** If the CLI is unavailable or returns no text, the call
  fails naming the selected global model; it does not fall back to a HTTP
  provider the user did not select.

## Steps

1. **Native completion adapter** — add `NativeCompletionProvider` implementing
   `LLMProvider` in `packages/worker/src/llm/` (layering: `llm` is below
   `tools`; move the small spawn helper down or inject a spawn function from
   the caller so the layering test still passes). Accept model, command,
   timeout, abort signal; redact output; map failures.
2. **Resolver** — when the resolved connection is a native CLI connection,
   let it into the API-path chain (controlled by the app-wide native runtime,
   not per call site) and make `lazyProvider` / `createProviderForAgent`
   construct the native adapter for it. Keep the HTTP-only filter for chat and
   other callers that cannot run a CLI.
3. **Setup / default config** — `defaultConfig()` must resolve to the global
   native selection without requiring an HTTP model. `taskRunner` and
   `resume` keep passing one config into the run context.
4. **Call-site sweep** — verify planner, decision, commit, memory, and
   on-demand skills now receive a usable handle; remove any per-agent or
   per-call-type special case that still forces the HTTP pool.
5. **Tests** — unit tests with an injected spawn function: adapter returns
   text, honours abort/timeout, fails with the model named; resolver includes
   the native entry only for the global-native path; `defaultConfig()` works
   with an OpenCode-only pool. Keep no live-CLI test in the default suite.
6. **Checks** — worker typecheck, focused worker tests, `knip`; update plan 071
   verification notes if its claims change.

## Test plan

- `packages/worker/tests/llmResolver.test.ts`: native entry served for
  `defaultConfig()` when the global runtime is native; excluded for chat.
- New `tests/nativeCompletionProvider.test.ts`: injected spawn, JSON text,
  abort, empty output, missing CLI.
- `tests/config/*` untouched except where a removed env default is asserted.

## Definition of done

- With only an OpenCode connection + model selected globally, a task can set
  up, plan, decide, execute, review and finish without a HTTP model.
- No call type silently picks a different provider or an env credential.
- Focused checks pass; this plan and plan 071 are consistent.

## Verification log

- New `execution/nativeCompletion.ts` implements `LLMProvider.complete` by
  running `opencode run -m <global model> --pure` through a generalized
  `runChatLlm` (now accepts an exact prompt and an abort signal).
- `createGlobalLLMProvider` / `createProviderForAgent` accept an injected
  `ProviderFactory`; `TaskLlmResolver` carries it plus `includeNativeCli`.
  `buildTaskLlmResolver` always wires the native adapter, so setup, planner,
  decision, memory and commit can all reach the global model with no HTTP
  model present. `defaultConfig()` no longer requires an HTTP model.
- Tests: `nativeCompletionProvider.test.ts` (4), `llmResolver.test.ts`
  (native inclusion + `defaultConfig`, 3), `opencodeProvider.test.ts`
  (obsolete env-fallback assertion replaced). 62 focused tests pass.
- Four workspace typechecks pass; `test:scripts` 15/15; `knip` shows no new
  findings. Full worker suite: 47 failed / 2466 passed (baseline 46/2461;
  remaining failures pre-existing local-runtime, CRLF and golden-snapshot gaps).
- Not run: live CLI completion, browser smoke.

## STOP conditions

- A non-negotiable rule must change.
- The layering test cannot be satisfied without moving a module to the wrong
  layer — stop and redesign with the adapter injected from `execution`.
- A focused check fails twice after a reasonable fix.
