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

## Returning data

- Public queries must not return `apiKeyCiphertext`, plaintext keys, or legacy
  agent key fields. Return `apiKeyConfigured: boolean` instead.
- `getRunContext` is the worker's read path and deliberately strips credential
  material: only ciphertext may cross. Do not add a field to its return value
  without checking `securityInvariants.test.ts`.
- Never `console.log` an argument object that may contain a key or token.

## Authorization

`authz.ts` implements *conditional* ownership: a project is enforced only when it
carries `ownerId` **and** a viewer identity exists. Local single-user mode has no
auth provider by design (recorded decision in `README.md` and `ROADMAP.MD`).

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

## Style

- Functions are object-form with explicit `args` validators and a `handler`.
  Do not use `any` for an argument or a return value that crosses to the worker.
- Prefer one internal mutation per state transition over a general "update
  anything" mutation.
- Emit `logEvent` / `recordLifecycle` for state the UI must explain. Do not add a
  new logging table.
