# Plan 086: Structured owner routing

## Status

- Priority: P2
- Size: M
- Risk: MEDIUM
- Dependencies: 040, 084
- Planned at: 2026-11-27

## Why this is needed

Chat task owners are still picked by word lists (`ROLE_KEYWORDS`) and domain
regex tables (`DOMAIN_RULES`). They guess from wording, lose mixed-language
requests, and can silently choose Backend. The intent classifier already makes
one small JSON LLM call; its result should carry the owner decision instead.

## Target behaviour

- One small, schema-validated LLM call returns
  `{ role: RoleKey | null, kind, files: string[], confidence }`.
- A low-confidence or null role asks the user with the role-choice card; there
  is no keyword fallback and no Backend default.
- Only deterministic safety checks remain as rules (no-code negation,
  allowlisted commands, risk flags, path/circular/deadline/delegation gates).

## Steps

1. Extend the intent classifier JSON with `owner` (role enum from `ROLE_KEYS`,
   kind enum, bounded files, confidence); strict parse, one retry, then null.
   Use the cheapest configured model for that call.
2. Replace `routedOwners` with a pure classifier-result resolver; delete
   `ROLE_KEYWORDS` and duplicate CTO/role checks.
3. Replace `dispatch.ts` domain regex routing with the classifier result;
   keep only deterministic helpers and safety rules. Update `owner.ts`,
   `startTask.ts`, `taskPool.ts`, `plannerAgent.ts` callers.
4. Fix the worker logic defects: unowned severe finding never COMPLETE,
   `allowFallback === true`, distinct capability set names, `pickFixOwner`
   returns no owner when no path matches, stale nine-role/Support docs.
5. Update tests; run codegen, narrow typechecks and focused suites.

## Test plan

- Multi-language/ambiguous request: valid role or explicit role-choice card.
- Invalid role (e.g. retired "support"): rejected by validation, never routed.
- Low confidence: no owner, no Backend fallback.
- Severe finding without `ownerForFix`: no COMPLETE.
- No matching fix path: `pickFixOwner` returns undefined.

## Completion criteria

- [x] No `ROLE_KEYWORDS` or domain handoff/owner regex remains in the chat path.
- [x] `pnpm --filter @fhara/api run typecheck`, worker and web typechecks pass.
- [x] Focused API (75/75) and worker (122/122) tests pass; regex-only routing tests were replaced by structured-contract tests.
- [x] Web tests 201/201, `pnpm run check:guards` green; knip reports no new unused file.

## STOP conditions

- A non-negotiable rule in `AGENTS.md` must change.
- A check fails twice after a reasonable fix.
- Concurrent edits overwrite the work; report instead of clobbering them.
