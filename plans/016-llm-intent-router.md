# Plan 016: LLM intent router (structured classifier + answer engine)

> Instructions for the implementer: run each step in order, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When done, set
> this plan's state in `plans/README.md`.

## Status

- Priority: P1
- Size: M
- Risk: MEDIUM
- Dependencies: 013 (decision engine), 006 (router)
- Planned at: commit `a6c7709`, `2026-11-08`
- Completed: 2026-11-08 — Tandis (IntentResult 8 intent lengkap, intent router LLM
  terstruktur, answer engine, steering, canonical event bus, sequence ordering,
  idempotency schema). Sisa: live smoke + project-level skill library (P2).

## Why this is needed

Chat routing today is regex-first: `classifyChatIntent` (`apps/api/convex/chat.ts:113`)
and `classifyCommand` (`packages/worker/src/orchestrator/classifier.ts:30`). Regex misses
informal/Indonesian phrasing, so a capability question ("kamu beneran kan bisa jadi CTO
buat para anggota disini") is upgraded to a task by the Stage-B LLM, creating a pointless
task row (`cto-scope-briefing`). The user wants the router to be an LLM Intent Classifier
with structured output, and the ASK branch to have explicit answer modes.

## Target behaviour

- One router produces a structured `IntentResult` (intent `ask`|`task`, subtype,
  requiresWorkspace, requiresExecution, target, confidence, reasoning).
- Deterministic rules are a fast path (greeting, explicit negation) and a fail-closed
  fallback — never the only judgement.
- ASK → Answer Engine picks the agent and prompt by subtype
  (explanation/recommendation/research/audit).
- TASK → CTO/Orchestrator via the existing worker path; subtype is passed to the planner.
- The router input includes conversation history AND the project's active task.

## Current state

- `apps/api/convex/chat.ts:113` `classifyChatIntent` (regex).
- `apps/api/convex/chat.ts:174` `classifySemantically` (LLM, unstructured-ish JSON).
- `packages/worker/src/router/route.ts:22` `IntentResult` (execute_task/chat/clarify).
- `packages/worker/src/router/semantic.ts:8` `buildSemanticPrompt` + `parseIntentResult`.
- `apps/api/convex/chatContext.ts:115` `getContext` (history only, no active task).
- `apps/api/convex/chat.ts:661` auto-dispatch TASK → `tasks.createFromCommand`.

## Decisions that must not change during execution

- The router must fail closed to **ask** (never silently create a task) when the LLM
  output is invalid or unavailable.
- Questions, advice, and capability confirmations never become tasks.
- No second planner / parallel routing path; the worker orchestrator stays authoritative.
- Schema is additive; `IntentResult` is duplicated in the backend (Convex cannot import
  worker code) with the same field names.
- The deterministic fast path stays for greetings and explicit negation only.

## Steps

### Step 1: Shared schema shape

Define the structured result once per surface (worker + backend), same field names:

```ts
type IntentSubtype =
  | "explanation" | "recommendation" | "research" | "audit"
  | "implementation" | "debugging" | "testing" | "other";
interface IntentResult {
  intent: "ask" | "task";
  subtype: IntentSubtype;
  requiresWorkspace: boolean;
  requiresExecution: boolean;
  target?: string;
  confidence: number;
  reasoning: string;
}
```

**Check**: `npm run --workspace=@moagent/worker typecheck` and
`npm run --workspace=@moagent/api typecheck` both exit 0.

### Step 2: Worker router upgrade

`packages/worker/src/router/route.ts` + `semantic.ts`:
- Replace the old `IntentResult` with the new shape (keep `actionability`/
  `projectScope` only if still used; otherwise drop).
- `buildSemanticPrompt` asks for the new schema.
- `parseIntentResult` validates subtype/confidence, defaults `requiresExecution`
  from intent, fails closed to `ask`.
- `routeMessage`: deterministic fast path first; LLM classifier for the rest;
  invalid/failed LLM → deterministic fallback.

**Check**: `npx --workspace=@moagent/worker vitest run tests/semantic.test.ts
tests/router.test.ts tests/validation-unit.test.ts` all pass.

### Step 3: Backend LLM classifier

`apps/api/convex/chat.ts`:
- Replace `classifyChatIntent` + `classifySemantically` with one
  `classifyIntent(text, ctx)` returning the structured schema.
- Keep `EXPLICIT_NEGATION` / `GREETING` / `CONFIRMATION_SHAPE` as the fast path.
- Feed conversation history + active task into the prompt.

**Check**: `npx --workspace=@moagent/api vitest run convex/chatIntent.test.ts` passes
with new structured cases.

### Step 4: Answer Engine subtypes

ASK branch maps subtype → agent + prompt:
- explanation → researcher / product-analyst
- recommendation → CTO / lead
- research → researcher
- audit → reviewer
`requiresWorkspace` toggles the repo snapshot block.

**Check**: `npm run --workspace=@moagent/api test` passes.

### Step 5: TASK branch passes subtype

Auto-dispatch keeps creating the task; the subtype is recorded on the task
(`classification` payload / task field) so the planner can weight
implementation vs debugging vs testing.

**Check**: worker typecheck + planner test pass.

### Step 6: Router context includes active task

`apps/api/convex/chatContext.ts:115` `getContext` returns the project's running/queued
task (title + status) so the router prompt can see it.

**Check**: `npm run --workspace=@moagent/api test` passes.

## Test plan

- Structured classifier: capability question → `ask` (never task).
- Invalid LLM JSON → fail closed to `ask`.
- Greeting / explicit negation fast path still `ask`.
- TASK subtype reaches the planner payload.
- Router context includes active task title.
- No regression: existing chat + router tests pass.

## Completion criteria

- [ ] `npm run typecheck` (root) exit 0.
- [ ] `npm run --workspace=@moagent/api test` all pass.
- [ ] `npm run --workspace=@moagent/worker test` — no new failures vs baseline.
- [ ] Live smoke: "kamu beneran kan bisa jadi CTO..." stays chat; "buatkan tabel" dispatches a task.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- The router would bypass the worker's single planning authority.
- A check fails twice after a reasonable fix.
