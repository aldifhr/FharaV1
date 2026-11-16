# Plan 055: Per-message model picker in the chat composer

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: M
- Risk: MEDIUM
- Dependencies: plan 032 (global model list / selection mode), plan 037 (one list, one order)
- Planned at: commit `a91d768`, `2026-11-13`

## Why this is needed

The project chat composer picks who answers (@CTO / team) and the permission
mode, but the model is always the global list from Settings → LLM & Models
(fallback or round robin). The user wants one control to pick the model for a
reply directly from the composer toolbar.

## Target behaviour

| Before | After |
| --- | --- |
| Chat replies always resolve the global chain | The composer has a model picker: **Auto** (global list, default) or one registered model; the pick leads the chain for every LLM call of that turn |
| A wrong/stale model id silently degrades | `orderChain` already ignores a tier model the pool does not serve → falls back to the global list, same rule as role tiers |

## Current state

- `apps/api/convex/lib/llmChain.ts:44` — `orderChain` takes `tierModelRowId`;
  an explicit row goes first, the rest of the ordered list follows.
- `apps/api/convex/lib/chat/llm.ts:554` — `orderedChatPairs` computes that id
  from the role override only; `AgentLlmPrefs` is `{ role, callRole }`.
- `apps/api/convex/schema.ts:737` — user messages carry `replyOptions`
  (`preferredAgentIds`, `permissionMode`) for Retry.
- `apps/api/convex/chatReplies.ts:205` — Retry re-schedules with the stored
  `replyOptions`.
- `apps/api/convex/messages.ts:337` — `messages.send`; the web composer
  (`ChatComposer.tsx`, the `modeOpen`/`targetOpen` dropdown pattern) and
  `ChatPanel.tsx:108` (`permissionModeChoice`, reset on project change).

## Decisions that must not change during execution

- The pick is a **chain preference, not an exclusive model**: the chosen row
  leads, the global list follows as fallback (`orderChain` semantics, same as
  role tiers). A pick the pool cannot serve is ignored, never an error.
- **Auto** = no argument; behaviour byte-for-byte the global list, no cursor
  change. No new "model selection mode".
- OpenCode-connection models are NOT offered in chat (the backend cannot run
  the CLI; `orderedChatPairs` already filters them). Filtering is client-side
  for the dropdown only; the backend chain rule stays.
- The pick rides `replyOptions` on the user row, exactly like
  `preferredAgentIds`/`permissionMode`, so Retry re-runs with the same model.
- Scope: **the project chat composer only.** The personal-chat composer is a
  separate flow; it is not touched here.
- No schema migration: `replyOptions.preferredModelRowId` is additive and
  optional. No new non-negotiable rule is invoked.

## Steps

### Step 1: backend chain preference

`lib/chat/llm.ts`: `AgentLlmPrefs` gains `preferredModelRowId?: string`;
`orderedChatPairs` uses `agent?.preferredModelRowId ?? overrideModelFor(...)`.

**Check**: `npm run --workspace=@fhara/api typecheck` → clean.

### Step 2: persist on the user message

`schema.ts` `replyOptions`: `preferredModelRowId: v.optional(v.id("llmModels"))`.
`chatContext.insertUserMessage`/`insertChatUserMessage` accept and store it.
`messages.send` args gain it; pass into `insertChatUserMessage`, the user
row's `replyOptions` and the `replyToChat` scheduler args.
`chatReplies.retryReply` forwards `message.replyOptions?.preferredModelRowId`.
`chat.ts` `replyToChat`/`ReplyArgs` accept it; `answerChat` merges
`{ preferredModelRowId }` into every `resolveConfigFromProviders` call of the
turn.

**Check**: codegen + `npm run --workspace=@fhara/api typecheck` → clean;
`npx --workspace=@fhara/api vitest run convex/chatReplies.test.ts convex/chatReplies.test.ts convex/messages.test.ts`
(whichever exists) → pass.

### Step 3: composer picker

`ChatComposer.tsx`: optional `models?: { id: string; label: string; provider: string }[]`,
`modelId?: string | null`, `onModelChange?: (id: string | null) => void`.
New dropdown in the toolbar after the permission-mode control: `Cpu` icon,
label "Auto" or the model's label (truncated, hidden on small screens),
listbox = "Auto — follow the global model list" plus one row per model
(`label — provider`), check on the selected row. Same outside-click/Escape
pattern as the other pickers. Disabled while the queries load.

`ChatPanel.tsx`: `useQuery(api.llmModels.list, {})` +
`useQuery(api.llmProviders.list, {})`; options = available, non-opencode,
no-disabled-provider models in registry order; `modelChoice` state (reset on
project change like `permissionModeChoice`); every `sendMessage` call site
(queue, proposal pick, send) passes `preferredModelRowId` when set.

**Check**: `npm run --workspace=@fhara/web typecheck` → clean.

## Test plan

- Chain unit: add/extend an `orderedChatPairs` assertion (preferred row first,
  rest follows, unknown id → global chain) if a test module covers it;
  otherwise rely on `orderChain`'s existing tier tests.
- convex-test suites that exercise `messages.send` (chat) still pass.
- Browser: open a project chat; the picker shows "Auto"; pick a model → the
  label switches; pick Auto again → label back to "Auto". No message sent in
  the check (no live provider calls).

## Completion criteria

- [x] api + web typecheck clean; `check:guards` ok (oversized files were split, baseline not raised); `knip` no new findings
- [x] Backend suites green (42/42 in chatReplies, personalChat, taskCreationPaths, chatQuote)
- [x] Browser check of the picker in the project chat composer: "Auto" default; listbox opens with Auto + the registry model; pick switches the label; back to Auto clears it. No message was sent (no live provider calls). Verified after restarting the local api+web dev stack, which had stopped.

## STOP conditions

- A check fails twice after a reasonable fix.
- Threading the preference outgrows the `replyOptions`/`resolveConfigFromProviders`
  seam (e.g. a shared call escapes both) — stop and report rather than
  hardcode a model somewhere.
