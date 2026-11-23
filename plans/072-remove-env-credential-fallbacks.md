# Plan 072: Remove environment-based LLM credential and model fallbacks

## Status

- State: DONE (2026-11-23)
- Priority: P1
- Size: L
- Risk: HIGH (credential handling, schema, four surfaces)
- Dependencies: 068, 071
- Planned at: 2026-11-23

## Why this is needed

The user decided that no LLM setting may be picked from the environment. A
connection's key must be the stored ciphertext; the model/runtime must come
from the app-wide selection in Settings. Today there are two env escape
hatches: the per-connection `apiKeyEnv` name (backend and worker read
`process.env[name]` when no key is stored) and the global `LLM_*` fallback
(`llmFallbackConfig`, used when Settings has no provider, which silently
resolved to Anthropic's default model in the reported logs). Both must go so
a missing configuration fails explicitly instead of choosing a provider.

## Decisions

- **Global is the only source.** A connection without stored key material
  cannot be used; a run with no provider in Settings has no LLM config. Both
  cases fail with a message naming what to configure. No implicit Anthropic,
  no env-sourced key, no per-call provider invention (plan 071 target).
- **Legacy schema column stays readable.** Per root AGENTS non-negotiable #7,
  `llmProviders.apiKeyEnv` remains in the schema as optional and is never
  written by new code; resolvers ignore it. A later migration may drop it
  after the migration reports clean. Do not rewrite already-run migrations.
- **Keep denylists.** `LLM_API_KEY`/`OPENAI_API_KEY` stay in the secret and
  child-env denylists as defense in depth even after the schema entries go.
- **CLI credentials are not a fallback.** OpenCode/Codex/ACP use their own
  operator login (plan 071); `MOAGENT_OPENCODE_API_KEY` is the already-resolved
  key injected into a temporary CLI config, not an env lookup. Keep it.
- **Generated files are regenerated, not hand-edited**: `env-manifest.json`,
  `.env.example`, `generatedDataModel.ts`.

## Steps

1. **Config**: delete `llmFallback.ts` and its exports; remove the seven
   `LLM_*` / `OPENAI_API_KEY` variable definitions from `schema/llm.ts`,
   `runtimeSync.ts`, and the generated manifest/example.
2. **Backend**: remove `apiKeyEnv` from public writes/validation/presets and
   stop reading env in `resolveConnectionKey` / `fetchModels`; keep
   `LlmEndpointConfig`, delete `getGlobalLLMConfig`. Chat and the three node
   helpers must fail explicitly when no provider is configured instead of
   receiving an env fallback; update their tests' mocks.
3. **Worker**: delete `envResolution` and the env parameter of
   `materializePool`; make `createGlobalLLMProvider`, `createProviderForAgent`,
   `agentExecutor.handlesFor` and `planner` fail explicitly on missing config.
   Remove the `apiKeyEnv` import and the `noRawEnv` allowlist entry.
4. **Web**: remove the "Key env var" input and all `apiKeyEnv` state/payload
   plumbing; the key status line distinguishes "key stored" / "no key stored".
5. **Cleanup**: delete `lib/apiKeyEnv.ts`, update `scripts/doctor.mjs`, fix
   stale doc comments, regenerate generated files, update/delete affected
   tests, run `knip`.

## Test plan

- Focused: worker `llmResolver`, `llmCall`, `noRawEnv`, `planner`; backend
  `securityInvariants`, `providerSecrets` replacements, chat resolution;
  web `llmModelList`.
- Typechecks: `@fhara/config`, `@fhara/api`, `@fhara/worker`, `@fhara/web`.
- `knip` for dead exports/files. No live-provider calls.

## Completion criteria

- No code path reads `LLM_API_KEY`, `OPENAI_API_KEY`, `LLM_PROVIDER`,
  `LLM_MODEL`, `LLM_BASE_URL`, `LLM_*_BASE_URL`, or `connection.apiKeyEnv` to
  obtain a credential or model.
- A connection with no stored key and a run with no configured global model
  each fail with an explicit, actionable error.
- Focused checks pass; the plan index is marked DONE.

## Verification log

- Four workspace typechecks pass (`@fhara/config`, `@fhara/api`, `@fhara/worker`,
  `@fhara/web`).
- `pnpm run test:scripts`: 15/15 pass (doctor/env checks no longer read LLM_*).
- Focused worker tests pass: `llmResolver`, `noRawEnv`, `defaultsParity`,
  `runtimeParity`, `secretsParity`, `llmCall`. Full worker suite: 48 failed /
  2459 passed — the remaining failures are pre-existing CRLF, path and
  local-runtime gaps (baseline was 47 failed / 2461 passed).
- Focused backend tests pass: `providerSecrets`, `llmModelFlow`, `llmEndpoint`,
  `incidentsImprove`; `reviewerObserver` LLM cases now pass, its 3 remaining
  failures are the pre-existing `ctx.db.system.query` local-runtime gap.
- `knip` reports only pre-existing unused files/deps/unresolved imports.
- Generated files refreshed: `env-manifest.json`, `.env.example`,
  `generatedDataModel.ts` (`apiKeyEnv` now optional).
- Not run: live-provider smoke, browser smoke, full web build.

## STOP conditions

- A non-negotiable rule must be weakened.
- A schema column must be dropped in the same change that stops writing it.
- A focused check fails twice after a reasonable fix.
