# Plan 037: Settings → LLM & Models, simple flow and one model order

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: M
- Risk: MEDIUM
- Dependencies: 032 (global selection mode), 035 (global OpenCode runtime)
- Planned at: commit `5e47af2`, 2026-11-10

## Why this is needed

Getting one working model took 3 env preconditions and 10 UI steps: a wire
format instead of a vendor, a hand-typed base URL, a Fetch that sent Bearer
to Anthropic (which wants `x-api-key`), no test, and priorities spread over
connections. Backend chat also picked a different model than tasks: it used
the first connection only, ignored the selection mode and had no failover.

The developer chose the simple version over aliases: "Setting → LLM &
Models, pilih mode (Fallback or Round Robin) → Tambah Provider, Tambah
Model, ngatur urutan yang mau Fallback atau Round Robinnya".

## Target behaviour

1. **Mode**: Fallback / Round robin (`llmSelectionSettings`, plan 032).
2. **Providers** from presets (`lib/llmPresets.ts`: Anthropic, OpenAI,
   OpenRouter, Gemini, DeepSeek, Groq, Mistral, Together, Ollama, LM Studio,
   Custom). Save validates the key by listing models (Anthropic:
   `x-api-key` + `anthropic-version`). Base URL, wire format and key env go
   under Advanced. A missing `PROVIDER_ENCRYPTION_KEY` shows a setup hint.
   Rows have Test / Edit / Remove (ConfirmDialog).
3. **Models**: one ordered list across providers (`llmModels.position`).
   Up/down reorder (`llmModels.reorder`, atomic; connection priority follows
   the first model), enable/disable, remove, Test. The order is the
   fallback order; in round robin it is the rotation set.
4. OpenCode runtime section unchanged.

## One resolver for chat and tasks

`lib/llmOrder.ts` (pure) orders the pool; `lib/chat/llm.ts`
(`orderedChatPairs` / `resolveConfigFromProviders`) and the worker
(`llm/resolver.ts`) both use it: agent primary → agent fallback → the list
(rotated in round robin, sticky cursor). Chat now carries the rest of the
list as `fallbacks` and fails over on errors and empty answers.
`packages/worker/tests/llmModelOrder.test.ts` pins parity. Rows without a
position keep the legacy priority/weight order.

Adapted from 9router (MIT, `lib/llmRotation.ts`, THIRD_PARTY_NOTICES.md):
sticky round robin, empty-completion check, cooldown rules (429 →
exponential backoff opens the circuit at once; 401/402/403 → 2 min in chat;
request 4xx → none; other → 30 s in chat / threshold in the worker).

## Schema (additive)

- `llmModels.position: v.optional(v.number())`
- `llmProviders.presetId: v.optional(v.string())`

No migration: unpositioned rows sort after positioned ones in the legacy
order, and the first insert or reorder materializes positions.

## Completion criteria

- api / web / worker typecheck clean; `convex/llmModelFlow.test.ts`,
  `tests/llmModelOrder.test.ts`, `tests/unit/llmModelList.test.mjs` pass.
- Browser check of the Settings page against a real deployment (pending).
