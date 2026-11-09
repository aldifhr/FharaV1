# `apps/api/convex` — backend

Convex backend: schema, public queries/mutations for the UI, internal functions
for the worker, credential encryption, provider selection, and migrations.

Read the root [`AGENTS.md`](../../AGENTS.md) first. Its "Non-negotiable" rules
apply here with full force — this is the surface that holds credentials.

## Two callers, two shapes

| Caller | Entry point | Auth |
| --- | --- | --- |
| Web UI | public `query` / `mutation` in the feature modules (`tasks.ts`, `projects.ts`, `agents.ts`, …) | none today (see "Authorization") |
| Worker | `action` in `worker.ts`, which wraps an `internal*` function | `CONVEX_SERVICE_TOKEN` via `assertServiceToken` |

- Every worker-facing action takes `...tokenArg` (`{ workerToken: v.string() }`)
  and unwraps with `withoutToken(args)`. Copy that pattern; do not read the token
  from `process.env` inside the action.
- Keep the logic in `orchestration.ts` as an internal function and let
  `worker.ts` stay a thin authenticated wrapper. `WorkerApi`
  (`packages/worker/src/workerApi.ts`) is the only worker caller.
- Never expose an internal function as a public one. If the UI needs data, add a
  public query that returns a projection, not the raw document.

## Layout

Every `.ts` file under `convex/` is a Convex module, and its path is the
function path (`chat.ts` → `api.chat.*`). Public and internal functions stay
in the top-level feature modules; pure helpers that define no functions live
under `lib/`, so moving logic there never changes a function path.

| Path | Holds |
| --- | --- |
| `lib/roles.ts` | Single source for the nine team roles (labels, registry fields, capabilities, tools, chip colours, prompt keys, retired/legacy keys). Pure TS: imported by the web app (`@/api/convex/lib/roles`) and meant for the worker too. |
| `lib/prompts/` | All backend LLM prompt text: `chat.ts` (chat loop, CTO assignment, classifier, responder chooser), `agents.ts` (seed personas), `enhance.ts` (prompt enhancer). Change wording only here. |
| `lib/chat/` | `chat.ts` internals: intent shapes/parser, team selection, LLM client, tool-call stripping, repo snapshot (`"use node"`), and `repoTools.ts` (read-only repo tool contract, bounded tool loop and shared per-turn budget for grounded chat replies). |
| `lib/authz.ts` | Conditional ownership checks (`assertProjectAccess`, `canViewProject`, …). |
| `lib/llmResolver.ts`, `lib/llmCrypto.ts`, `lib/llmConfig.ts` | Provider pool assembly, key encryption, env-var fallback config. |
| `lib/avatar.ts` | Default avatar params (shared with the web app). |
| `lib/reviewer/`, `lib/incidents.ts`, `lib/improve/` | Plan 023: read-only Reviewer (second opinion + shadow notes: prompts, parsers, budgeted read-only loop, shadow scheduling), incident opening (called inside the failing mutation), and Self-Improvement Lab prompt / edit / diff helpers. Modules: `reviewer.ts`, `incidents.ts`, `improve.ts`. |

A `lib/` file imported only by a `"use node"` module may itself need
`"use node"` when it touches Node APIs (see `lib/chat/repoSnapshot.ts`).

## Returning data

- Public queries must not return `apiKeyCiphertext`, plaintext keys, or legacy
  agent key fields. Return `apiKeyConfigured: boolean` instead.
- `getRunContext` is the worker's read path and deliberately strips credential
  material: only ciphertext may cross. Do not add a field to its return value
  without checking `securityInvariants.test.ts`.
- Never `console.log` an argument object that may contain a key or token.

## Authorization

`lib/authz.ts` implements *conditional* ownership: a project is enforced only when it
carries `ownerId` **and** a viewer identity exists. Local single-user mode has no
auth provider by design (recorded decision in `README.md` and `ROADMAP.md`).

- Do not claim the app is authenticated or rate-limited. It is not.
- Do not "fix" this by adding a fake owner or a hardcoded viewer.
- Any real auth work is a plan, not a drive-by change.

## Schema

- `schema.ts` is the single source for status unions (`taskStatus`,
  `agentStatus`, `subtaskKind`, `subtaskStatus`, `executionStatus`,
  `approvalKind`, `approvalStatus`). Import them; never re-declare the literal
  lists in a handler.
- Add a new query shape together with its `.index(...)`. Do not scan a table with
  `.collect()` and filter in JS when an index can serve it.
- New fields are `v.optional(...)`. Keep legacy fields readable until the
  migration reports clean.
- Terminal statuses are `done`, `rejected`, `failed`. `completeTask` refuses to
  overwrite them and returns `{ applied: false, reason: "task_already_terminal" }`.
  Keep that return shape — the worker branches on it.

## Migrations

`migrations.ts` owns data movement for the encrypted-credential rollout:

| Function | Kind | Purpose |
| --- | --- | --- |
| `migrateProvidersAndAgents` | internalMutation | Encrypt plaintext provider keys, build the model registry, clear legacy agent key fields. Idempotent. |
| `verifyMigration` | internalQuery | Reports remaining plaintext rows. Must report zero. |
| `rotateEncryptionKeys` | internalMutation | Re-encrypts every stored key under a new `PROVIDER_ENCRYPTION_KEY`. |

- Migrations must be idempotent and safe to run twice.
- `PROVIDER_ENCRYPTION_KEY` lives in the Convex deployment env **and** the worker
  env with the same value. A mismatch fails every provider call with an explicit
  decryption error; that is intentional, not a bug to paper over.
- Do not delete or rewrite a migration that may have run on a deployment. Add the
  next one and update `verifyMigration`.

## Tests

`convex-test` runs the real functions in memory — no deployment, no codegen.

```
npm run --workspace=@moagent/api test
npx --workspace=@moagent/api vitest run convex/securityInvariants.test.ts
```

`securityInvariants.test.ts` protects three things the worker suite cannot reach:
the terminal-status guard, the provider mutation token gate, and credential
cleanliness of `getRunContext`. Extend it when you touch any of the three. Never
delete a case to get a green run.

- Plan 006 Phase 3 context compaction: `contextSummaries` table with
  `by_conversation` (cursor on `lastCompactAt`, latest-first) and `by_project`
  indexes; internal query `getContextSummaries` + `getLatestContextSummary`;
  internal mutation `insertContextSummary`. `chatContext.getContext` returns
  `contextSummary` so the router prompt builder uses summary + last 12.

## Style

- Functions are object-form with explicit `args` validators and a `handler`.
  Do not use `any` for an argument or a return value that crosses to the worker.
- Prefer one internal mutation per state transition over a general "update
  anything" mutation.
- Emit `logEvent` / `recordLifecycle` for state the UI must explain. Do not add a
  new logging table.

## Grounded chat (repo tools)

Every agent answering in chat — the CTO, the teammates it hands off to by
@mention, and agents the user @mentions — may read the repo with read-only
tools (`list_files`, `grep`, `read_file`; max 6 calls per reply, max 12
across all agents in one chat turn — `MAX_REPO_TOOL_CALLS_PER_CHAT`; agents
left after the budget runs out answer without tools). Availability is
checked once per turn. A Convex action cannot read the
user's repository, so each call is queued in `repoToolCalls`
(`repoTools.ts`), claimed by an online worker through the token-gated
`worker.claimRepoToolCall` / `completeRepoToolCall`, run in the project
workspace (`packages/worker/src/tools/repoRead.ts`, sandboxed, capped,
secret-masked) and read back by the action, which deletes the row.

- Availability needs a workspace AND a fresh online worker whose heartbeat
  advertises the `repoTools` capability (`workers.capabilities`); an older
  worker build counts as unavailable. A call no worker claims within 3 s
  fails fast ("worker tidak merespons") and turns tools off for the rest of
  that reply. Without tools the reply says it has not checked ("belum saya
  cek"), and the Thinking trace gets a quiet "Repo tools off: …" reason.
- With tools on, the CTO is told to verify facts itself and hand off only
  for a teammate's specialty opinion. With tools off for the turn, it is told
  teammates have no access either (no "@QA please verify …"), and a handoff
  whose request is about checking (cek/verifikasi/periksa/grep/check/verify,
  `isVerificationRequest`) is dropped, noted in the CTO's trace.
- Tool-call text never reaches a bubble (`lib/chat/toolCallText.ts`): bare or
  fenced JSON calls, `<tool_call>` / `<longcat_tool_call>` markup, several
  calls plus prose in one reply. Grounded: only the first call runs. No tools
  (every other reply path): held back while streaming,
  retried once with `NO_TOOLS_RETRY_LINE`, then a short fallback.
- Argument aliases (`maxLines`/`limit` → `lines`, `file` → `path`,
  `query`/`regex` → `pattern`, `startLine` → `start`) are normalized on both
  sides. Partial reads say "truncated: lines X-Y of N; read again with
  start=…"; grep counts every match and says "0 matches for … in …".
- Files read are stored on the reply as `messages.checkedFiles`; paths and
  file:line references the answer cites that no tool result (or the
  snapshot) showed are stored as `messages.unverifiedRefs` and shown as a
  quiet "Unverified: …" line (`lib/chat/refCheck.ts`).

## Traceability and observations (plan 025)

- `lib/requirements.ts` (pure): requirement extraction fallback, mapping,
  and `computeRequirementCoverage` — the same check the worker runs before
  "done" and `traceability.requirements` computes for the UI.
- `tasks.requirements` is written by `writePlanVersion` from the plan
  payload; a version that carries none keeps the stored list.
- "Completed with gaps" is status `failed` + `tasks.requirementCoverage.outcome
  = "completed_with_gaps"` (no new task status).
- `executionObservations` rows are derived deterministically from events
  (`lib/observations.ts#observationsFromEvent`) inside `logEvent` and
  `updateExecution`. Add a row to the mapping table there, not a new sink.
