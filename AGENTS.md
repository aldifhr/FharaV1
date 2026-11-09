# MOAgent — repository guidance

MOAgent is a multi-agent orchestrator: a planner builds a DAG of subtasks, agents
execute them (code change, review, QA, audit/research), file changes pass a human
approval gate, and results are verified before a task is marked done.

Read this file before changing code. Each surface has its own rules:

| File | Scope |
| --- | --- |
| [`apps/api/convex/AGENTS.md`](apps/api/convex/AGENTS.md) | Schema, queries/mutations/actions, authz, migrations |
| [`packages/worker/AGENTS.md`](packages/worker/AGENTS.md) | Orchestrator, planner, DAG scheduler, LLM gates, tools |
| [`apps/web/AGENTS.md`](apps/web/AGENTS.md) | Next.js UI (partly generated — do not delete its blocks) |

## Communication

- Write code, comments, identifiers, commit messages, and UI copy in English.
  The UI copy is not fully swept yet; fix Indonesian strings you touch instead of
  adding more.
- Keep answers short. State what you changed, what you ran, and what you did not
  check. Mark unverified claims and say where you looked.
- Keep going when a step needs no decision from the developer. Stop and ask only
  before something destructive (data loss, force-push, rewriting a migration,
  changing anything outside this repository) or when the requirement is
  genuinely ambiguous.

For work with more than a few steps, keep a checklist in `TASKS.md` at the repo
root (git-ignored) so the plan survives context compaction.

## Non-negotiable

These protect credentials, user work, and the approval model. Change them only on
an explicit decision recorded in `plans/`.

1. **Provider keys never leave the backend as plaintext.** Keys are stored as
   AES-256-GCM ciphertext (`apiKeyCiphertext`, `llmCrypto.ts`). Public queries
   return only `apiKeyConfigured`. Only ciphertext crosses to the worker, which
   decrypts locally. Never log, echo, return, or embed a provider key.
2. **Worker ↔ backend is token-gated.** Every worker-facing action takes
   `workerToken: v.string()` and calls `assertServiceToken` (`authz.ts`). The
   comparison is constant-time and fails closed when `CONVEX_SERVICE_TOKEN` is
   unset. Do not add a worker-facing action, mutation, or query that skips it.
3. **Terminal tasks are immutable.** Once a task reaches a terminal status, a
   late worker completion must be refused with a value, not applied
   (`orchestration.completeTask`). Do not weaken this guard.
4. **Tool sandboxing stays.** Every file tool resolves through
   `resolveSandboxPath` (`packages/worker/src/tools/sandbox.ts`), and
   `runCommand` uses an exact-argv allowlist — never a prefix or substring check.
   Widening either is a security decision, not a refactor.
5. **The human approval gate stays.** `apply_changes`, `git_push`,
   `run_command`, and `merge_pr` require an approval row before they run. Do not
   auto-approve or bypass it for convenience. The only automatic approvals are
   the task's permission mode (plan 020): recorded as an approved row with
   `decidedBy: "auto"`, re-checked by the backend, and never for push / PR.
6. **The budget gate runs before every LLM call.** `BudgetTracker` + the
   pre-call gate must be evaluated before the request, not after. Do not
   "check the budget" only in the UI.
7. **Schema changes are additive and reversible in practice.** Add fields as
   `v.optional`, keep legacy columns until the migration reports clean, and
   never drop a field in the same change that stops writing it.

If a change needs one of these rules changed, stop and write a plan first.

## Layout

```
apps/web          Next.js 16 UI (React 19, Tailwind 4) — @moagent/web
apps/api/convex   Convex backend — @moagent/api
packages/worker   Task worker: orchestrator, scheduler, LLM, tools — @moagent/worker
electron/         Optional desktop shell (electron/main.cjs)
convex/           Root marker only; real backend code lives in apps/api/convex
```

The worker loads `../../.env` relative to its own directory, so the single root
`.env` serves both the worker and local scripts. Convex deployment env is separate
(`npx convex env set ...`) — the two `PROVIDER_ENCRYPTION_KEY` values must match.

## Commands

| Goal | Command |
| --- | --- |
| Web UI | `npm run dev` (port 3000) |
| Convex dev + worker | `npm run convex` |
| Worker only | `npm run worker` |
| Electron shell | `npm run electron:dev` |
| All workspace typechecks | `npm run typecheck` |
| Worker tests | `npm test` (or `npm run --workspace=@moagent/worker test`) |
| Backend tests (in-memory) | `npm run --workspace=@moagent/api test` |
| Codegen only | `npm run --workspace=@moagent/api codegen` |
| One backend file of tests | `npx --workspace=@moagent/api vitest run convex/<file>.test.ts` |
| One worker file of tests | `npx --workspace=@moagent/worker vitest run tests/<file>.test.ts` |
| Narrow typecheck | `npm run --workspace=@moagent/api typecheck` / `npm run --workspace=@moagent/web typecheck` / `npm run --workspace=@moagent/worker typecheck` |
| Unused files / deps | `npm run knip` (`npm run knip:all` also reports unused exports) |

`apps/api/convex/_generated/` is gitignored. A fresh clone has no generated
client, so backend and worker typecheck fail until `npx convex dev` (or
`npm run --workspace=@moagent/api codegen`) has run once. That is expected, not a
code error.

## Checks

Run the narrowest check that can catch your mistake, then say what you left out.
Broad runs are expensive and slow the machine:

1. Change in the backend → `npm run --workspace=@moagent/api typecheck` and the
   relevant `convex/*.test.ts` file.
2. Change in the worker → `npm run --workspace=@moagent/worker typecheck` and the
   relevant `packages/worker/tests/*.test.ts` file (or `npm test` for the whole
   worker suite, which is fast).
3. Change in the web app → `npm run --workspace=@moagent/web typecheck` and
   `npm run build` when the change affects routing, bundling, or server
   components. Do not run `next build` for a pure copy or style change.
4. Run the root `npm run typecheck` only before handing work off, or when you
   changed a shared type/contract, and state that you ran it.
5. Never weaken or delete a test to make a check pass. Never silence a type
   error with `any`, `@ts-ignore`, or `@ts-expect-error` without a recorded
   reason in the change description.
6. Added, deleted, or renamed a module, an export, or a dependency → `npm run
   knip`. It fails on unused files, unused/unlisted dependencies, unresolved
   imports, and duplicate exports. `npm run knip:all` also reports unused
   exports (noisy for the shadcn primitives in `apps/web/components/ui/`).

Backend tests use `convex-test` in memory — they need no deployment and no
codegen. Worker tests are pure Vitest. Do not add Playwright or live-provider
tests to the default suite; they cost quota and are opt-in.

## Architecture rules to remember

- **One planning authority.** The orchestrator owns execution decisions; the
  planner is its subroutine and produces the `ExecutionPlan` the scheduler runs
  (`ORCHESTRATOR_AUTHORITATIVE`, default on). Do not add a second planner or a
  parallel routing path.
- **Provider connections ≠ model registry.** `llmProviders` holds one connection
  offering many models; `llmModels` is the registry. Selection consumes
  priority, then weighted choice, filtered by `modelPatterns` and provider
  health. Do not hardcode a model in an agent path.
- **Cancellation is one `AbortController` per task.** User cancel and the task
  deadline share it and it must be threaded into LLM calls, QA, commands, and
  verification.
- **Retries classify permanent vs transient** and respect the deadline and
  budget veto. Do not add a blanket retry.
- **Observability is `taskEvents` / `lifecycleHistory`.** There is no separate
  tracing system; add events there instead of a new log sink.
- **Dynamic subtasks are persisted** so recovery does not lose them. Keep new
  scheduler state in the database, not only in worker memory.

## Plans

Write `plans/NNN-short-title.md` for any change that touches a non-negotiable
rule, a schema migration, the orchestrator/planner contract, or more than one
surface. The format is in [`plans/README.md`](plans/README.md). Update the state
column in that index when you finish, block, or reject a plan.

Do not create a plan for a typo, a copy sweep, or a single-file bug fix — just
fix it and report the evidence.

## Skills

Project skills live in `.agents/skills/<name>/SKILL.md` (mirrored in
`.claude/skills/`). They are workflows, not documentation:

- `smoke` — start the stack, drive the real app, prove a change works.
- `improve` — audit one area, fix findings, report evidence.

The installed `convex-*` skills come from `convex/agent-skills`; do not edit
them by hand. Update `skills-lock.json` through the installer instead.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

If that file is missing, run `npx convex ai-files install` (or `npx convex dev`
once) to generate it. Convex agent skills for common tasks can be installed by
running `npx convex ai-files install`.

<!-- convex-ai-end -->
