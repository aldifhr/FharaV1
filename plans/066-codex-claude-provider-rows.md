# 066 — Codex & Claude Code as sibling task-model sources (UI + registry)

## Goal

The Settings → LLM & Models "Add model" dialog offers only "OpenCode (tasks
only)". Add **Codex** and **Claude Code** as sibling pseudo-providers so the
user can add task-execution models from those CLIs (presets + free-typed ids).
Scope decision (developer): **UI/registry only** — entries do not route tasks
yet; per-model runtime routing (codex driver / ACP) is a follow-up plan. The
entries are excluded from chat exactly like OpenCode's.

## Changes

1. `apps/api/convex/lib/opencodeProvider.ts` — generalize the discriminator:
   `CLI_PROVIDERS = ["opencode", "codex", "claude-code"]` (+ `NativeCli` type,
   `CLI_PROVIDER_NAME` map), `isNativeCliConnection()` (family),
   `findNativeCliRow(cli)`; `isOpencodeConnection` stays strict (routing still
   keys off it). `isNativeCliModelId(cli, id)`: opencode keeps the
   `provider/model` regex; codex/claude-code accept any non-empty trimmed id.
2. `apps/api/convex/opencodeProvider.ts` — `setEnabled`/`status` gain a `cli`
   arg (default "opencode"): lazy row creation uses `provider: cli`,
   `presetId: cli`, per-CLI display name; `status` for codex/claude-code
   returns existence/enabled only (no CLI detection/catalog yet).
3. `apps/api/convex/llmModels.ts:106,167` — validation switches to the family
   check + per-CLI id rule so codex/claude-code rows accept bare model ids.
4. `apps/api/convex/lib/llmResolver.ts` — `loadProviderPool` skips the whole
   CLI family (chat never sees any of them), widening the existing
   `isOpencodeConnection` skip; audit any other chat-side `withoutOpencode`
   filter.
5. `apps/web/components/LlmSettings.tsx` — sibling blocks for Codex / Claude
   Code (Enabled checkbox + hint; no Test/Check buttons yet), their options in
   the Add-model select, per-CLI model suggestions from a new
   `apps/web/lib/cliProviders.ts` (`CODEX_MODEL_PRESETS`, `CLAUDE_MODEL_PRESETS`
   — e.g. gpt-5.1-codex / claude-sonnet-4-5), and per-CLI row labels
   ("Codex · tasks only"). The OpenCode Test/Check/catalog machinery stays
   untouched.
6. Routing intentionally NOT changed: `routeFromResolution` keeps
   `isOpencodeConnection`, so a Codex/Claude entry sits in the list without
   affecting task execution until the follow-up routing plan lands.

## Definition of done

- Typechecks (api + web) green; extended backend tests pass (family helpers,
  per-CLI validation, pool exclusion).
- Dev-server smoke: Settings shows the three CLI rows; Add model with Codex
  offers presets + accepts a typed id; the entry is saved, listed as
  "Codex · tasks only", and absent from chat calls.
