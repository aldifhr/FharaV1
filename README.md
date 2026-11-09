# MOAgent

MOAgent is a multi-agent software team you talk to in chat. You describe a
change to your project; the CTO agent plans it and assigns it to teammates
by `@mention`; agents write the code in your repository; the change is
reviewed, approved by you, verified (typecheck / lint / test / build) and
checked in a real browser before the task is done. With GitHub connected, the
result can be pushed as a branch with a draft PR.

It is a **single-user, local-first prototype** (no login, no rate limiting —
see [Safety model](#safety-model)). Open work is tracked in
[ROADMAP.md](ROADMAP.md).

## Architecture

```
 Browser ──► apps/web (Next.js)  ──queries/mutations──►  apps/api (Convex)
                │ server routes (token-gated writes)          ▲
                └────────────────────────────────────────────┤ service-token actions
                                                              │ (claim · run context · events · cards)
                                     packages/worker (Node) ──┘
                                       plan → DAG → agents → review → verify → QA
                                       works in the project's git repo on disk
```

| Workspace | Package | What it holds |
|---|---|---|
| `apps/web` | `@moagent/web` | Next.js UI: projects, chat + task threads, cards, team, Settings (LLM providers, MCP), Inbox, Analytics |
| `apps/api` | `@moagent/api` | Convex backend in `apps/api/convex`: schema, chat + CTO assignment, tasks, approvals, permission broker, GitHub push, provider pool |
| `packages/worker` | `@moagent/worker` | Claims tasks from Convex and runs them end to end |
| `electron/` | — | Optional desktop shell (`npm run electron:dev` starts api, web, worker and the app window; closing the window stops all) |

Module map (details in each `AGENTS.md`):

- **`apps/api/convex/lib/`** — function-less shared code: `roles.ts` (the
  single source of truth for the team roles, used by Convex, web and worker),
  `authz.ts` (project access, service-token check), `llmCrypto.ts`
  (AES-256-GCM provider keys), `llmResolver.ts` / `llmConfig.ts` (provider
  pool), `chat/` and `prompts/`.
- **`packages/worker/src/`** — layered, enforced by `tests/layering.test.ts`:
  `types/ prompts/ utils/` ← `llm/ effects/ governance/ context/ workerApi` ←
  `tools/ mcp/` ← `execution/` ← `orchestrator/ scheduler/ router/` ←
  `services/` (task lifecycle: `taskRunner` + `runner/` stages) ← `index`.
- **`apps/web`** — `app/` routes, `components/` (chat, cards, sidebar),
  `lib/` (shared UI types, formatting, task status).

## The team

Every project gets the same fixed team of nine roles
(`apps/api/convex/lib/roles.ts`):

| Role | Does | Writes code |
|---|---|---|
| **CTO** | Answers by default, plans, assigns work by `@mention`, decides architecture and risk | no |
| **Designer** | Implementable design specs (layout, tokens, states, accessibility) | no |
| **Frontend** | React / Next.js / UI implementation | yes |
| **Backend** | API, Convex functions, schema, server logic | yes |
| **QA** | Browser checks and test evidence | no |
| **Support** | Documentation and how-to answers | docs |
| **DevOps** | CI/CD, Docker, deployment (policy-gated) | via commands |
| **Reviewer** | Independent code review | no |
| **Researcher** | Technical research with sources | no |

**How the CTO assigns.** When you ask for a change in chat, the CTO replies
with a short plan and `@mentions` the teammates who own each part
(`@Frontend`, `@Backend`, …). Those mentions — plus anyone you `@mention`
yourself — become the task's assignees. If the CTO names nobody, owners are
picked from the request by keywords. A question without a change gets an
answer, not a task.

## Task lifecycle

1. **Plan** — the worker claims the task, classifies it (low / medium / high /
   ultra) and the orchestrator builds an execution plan: a DAG of subtask
   nodes, each with an owner role and its `allowedPaths`.
2. **Nodes** — the scheduler runs ready nodes (per-agent concurrency, LLM
   gates, per-subtask timeouts). Code changes are *staged*, not written yet.
3. **Review** — the Reviewer checks the staged diff when the change is risky
   or multi-domain (`ORCHESTRATOR_REVIEW_MODE=auto`); "changes requested"
   spawns a fix round.
4. **Approval** — in the default `ask` mode you approve the change set on the
   approval card; the permission broker decides allow / ask / deny.
5. **Apply + verify** — approved files are written, then typecheck / lint /
   test / build run; failures get a bounded fix round.
6. **QA** — for applied UI changes in a browser-runnable project, Chromium
   opens the app and checks it (live QA card). An environment problem
   (no Chromium) is reported as "QA skipped", not as a code defect.
7. **Commit** — with worktree isolation on (`ORCHESTRATOR_WORKTREE_ISOLATION=1`)
   the task runs on its own branch, which is committed and merged.
8. **Push card / draft PR** — the commit shows up as a push card. Clicking
   Push is the approval: the worker pushes the branch and opens a **draft PR**.

Progress shows in chat as cards: task, changed files, verification, QA,
push.

## Quickstart

Requires Node ≥ 20.9 (`.nvmrc`: 24) and git.

```bash
git clone <this repo> MOAgent && cd MOAgent
npm install

cp .env.example .env                          # the only env file you edit (worker, web and Convex)

cd apps/api && npx convex dev --once && cd ../..   # log in / pick a deployment, push functions, generate convex/_generated
npm run doctor                                     # checks the setup, prints ✓ / ! / ✗ with fixes
npm run dev                                        # Convex dev + web (http://localhost:3000) + worker
```

`npx convex dev` writes the deployment to `apps/api/.env.local`; copy its
URL into `NEXT_PUBLIC_CONVEX_URL` in `.env`.
For a self-hosted backend set `CONVEX_SELF_HOSTED_URL` /
`CONVEX_SELF_HOSTED_ADMIN_KEY` instead (see `apps/api/.env.example`).

Put `CONVEX_SERVICE_TOKEN` (`openssl rand -hex 32`) and
`PROVIDER_ENCRYPTION_KEY` (`openssl rand -base64 32`) in `.env`. Convex
functions cannot read files, so `npm run dev` copies the keys they use
(`LLM_*`, `GITHUB_*`, `PROVIDER_ENCRYPTION_KEY`, `CONVEX_SERVICE_TOKEN`, …)
from `.env` to the Convex deployment env, only when a value changed. Run
`npm run env:sync` to do that by hand.

Add an LLM provider in **Settings → LLM** (or set the `LLM_*` fallback in
`.env`), create a project pointing at a local git
repository, and send a request in its chat.

`npm run dev` runs three processes with prefixed logs (`[api]`, `[web]`,
`[worker]`). The worker runs under `scripts/supervise.mjs`, which restarts it
on a crash with backoff (1 s → 30 s) and stops it cleanly on Ctrl-C. Single
pieces: `npm run dev:web`, `npm run dev:api`, `npm run worker`,
`npm run worker:supervised`, `npm run convex` (Convex dev + worker).

## Configuration

Everything lives in the root `.env`: the worker reads it, the web app loads
it in `next.config.mjs` (`apps/web/.env.local` still works as an override),
and `npm run dev` / `npm run env:sync` copies the backend keys to the Convex
deployment env. All are listed in `.env.example`.

| Variable | Where | Default | What it does |
|---|---|---|---|
| `NEXT_PUBLIC_CONVEX_URL` | `.env`, web | — (required) | Convex deployment URL (`CONVEX_URL` also accepted by the worker) |
| `CONVEX_SERVICE_TOKEN` | `.env`, web (server-only), Convex | — (required) | Shared secret for worker actions and token-gated web routes |
| `PROVIDER_ENCRYPTION_KEY` | `.env`, Convex | — | Encrypts provider keys saved in Settings (base64, 32 bytes) |
| `LLM_PROVIDER` / `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` | `.env`, Convex | anthropic | Fallback LLM when no provider is configured in Settings |
| `WORKSPACE_ROOT` | `.env` | `./workspaces` | Base for relative project paths |
| `ORCHESTRATOR_LLM_MAX_TOKENS` | `.env` | `8192` | Max output tokens per LLM call |
| `ORCHESTRATOR_LLM_TIMEOUT_MS` | `.env` | `300000` | Ceiling for one LLM request |
| `ORCHESTRATOR_SUBTASK_TIMEOUT_MS` | `.env` | `300000` | Subtask budget, low/medium tasks |
| `ORCHESTRATOR_SUBTASK_TIMEOUT_HIGH_MS` | `.env` | `900000` | Subtask budget, high/ultra tasks |
| `ORCHESTRATOR_TASK_TIMEOUT_MS` | `.env` | `1200000` | Task deadline, low/medium |
| `ORCHESTRATOR_TASK_TIMEOUT_HIGH_MS` | `.env` | `2400000` | Task deadline, high/ultra |
| `ORCHESTRATOR_EXECUTION_RUNTIME` | `.env` | `api` | `api` or `opencode` (legacy `ORCHESTRATOR_RUNTIME`) |
| `ORCHESTRATOR_NATIVE_PROVIDER_COMMAND` | `.env` | `opencode` | OpenCode CLI binary |
| `ORCHESTRATOR_NATIVE_TIMEOUT_MS` | `.env` | `600000` | Wall-clock limit per OpenCode run |
| `ORCHESTRATOR_REVIEW_MODE` / `ORCHESTRATOR_QA_MODE` | `.env` | `auto` | `always` / `auto` / `never` |
| `ORCHESTRATOR_QA_REQUIRED` | `.env` | `0` | `1` = environment-blocked QA fails the task |
| `QA_CHROMIUM_PATH` | `.env` | Playwright's Chromium | System Chromium (fallback `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`) |
| `QA_CHROMIUM_NO_SANDBOX` | `.env` | auto | `1` = `--no-sandbox` (auto as root / in containers) |
| `ORCHESTRATOR_WORKTREE_ISOLATION` | `.env` | `0` | Run each task on its own branch (needed for push / PR) |
| `ORCHESTRATOR_MAX_TOKEN_BUDGET_PER_TASK` | `.env` | `2000000` | Per-task token budget |
| `ORCHESTRATOR_BUDGET_MODE` | `.env` | warn | `enforce` = hard stop at the budget |
| `WORKER_POLL_INTERVAL_MS` | `.env` | `1500` | Task poll interval |
| `MOAGENT_WEEKLY_TOKEN_BUDGET` | Convex | — | Weekly budget shown in the usage meter (display only) |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Convex | — | GitHub OAuth app (push / draft PR) |
| `GITHUB_OAUTH_CALLBACK_URL` | Convex | `http://localhost:3000/api/integrations/github/callback` | OAuth redirect |
| `CONVEX_SITE_URL` | web | derived | Convex HTTP actions URL for the OAuth callback forwarder |

Every limit is read in one place, `packages/worker/src/orchestrator/policy.ts`.

### Provider keys and migrations

Provider API keys saved in Settings are stored only as AES-256-GCM
ciphertext. `PROVIDER_ENCRYPTION_KEY` must be the same in the Convex env
(encrypts on write) and the worker `.env` (decrypts on use); if they differ,
provider calls fail with an error naming the provider. After upgrading an
older deployment:

```bash
cd apps/api
npx convex run migrations:migrateProvidersAndAgents   # idempotent
npx convex run migrations:verifyMigration             # reports zero plaintext keys
```

Key rotation: set the new key, then `npx convex run migrations:rotateEncryptionKeys`.

## OpenCode runtime

Agents can run on two runtimes:

- **`api`** (default) — the agent's LLM (provider pool or `LLM_*`) with
  MOAgent's own host tools, every action gated.
- **`opencode`** — the [OpenCode](https://opencode.ai) CLI
  (`npm i -g opencode-ai`) runs its own tools in the task worktree. Its
  changes still pass the staging and approval gate.

Set the global default with `ORCHESTRATOR_EXECUTION_RUNTIME`, or per agent in
the agent form (Runtime, optional OpenCode `provider/model`). Without an
OpenCode model the CLI is pointed at the agent's resolved MOAgent LLM through
a temporary config; the key travels only in the child process env
(`MOAGENT_OPENCODE_API_KEY`). Each run is killed after
`ORCHESTRATOR_NATIVE_TIMEOUT_MS`.

## Skills library

`/library` holds reusable agent skills: short markdown instructions you attach
to agents (from the library's "Used by" list or the Skills section of the
agent form). When an agent runs, in a chat reply or a task subtask, each
attached skill is appended after its system prompt as
`## Skill: <name>`. The total is capped at 12,000 characters. Skills that
don't fit get truncated, and later ones are dropped.

To add the three starter skills (Conventional commits, Accessible UI
checklist, Write tests first), use the empty-state button on `/library`, or run:

```bash
cd apps/api
npx convex run skills:seedDefaults   # only seeds an empty library; idempotent
```

## GitHub push and draft PRs

1. Create a GitHub OAuth app with the callback
   `http://localhost:3000/api/integrations/github/callback`.
2. `npx convex env set GITHUB_CLIENT_ID …` and `GITHUB_CLIENT_SECRET …` in
   `apps/api`. For a non-cloud backend set `CONVEX_SITE_URL` in
   `apps/web/.env.local` if the HTTP actions do not run on the API port + 1.
3. Turn on `ORCHESTRATOR_WORKTREE_ISOLATION=1` so every task gets a
   committed branch.
4. In the project's **Manage project → GitHub**, connect and pick the repo
   and base branch.

After a task commits, its push card offers **Push**. The click records an
approved `git_push` approval; the worker pushes `<sha>:refs/heads/<branch>`
with the token passed only through `GIT_CONFIG_*` env (never argv, git
config or logs) and opens a draft PR. A cron refreshes PR state. MOAgent
never pushes without that click.

## Safety model

- **Repository boundary.** A request that targets a path outside the
  project repository (`../…`, `~/…`, `/etc/…`) is refused in chat before
  any task is created.
- **`allowedPaths`.** Each subtask may only change files inside its
  `allowedPaths`; anything else is dropped from its output and reported.
  Forbidden files (`.env*`, secrets) are never written.
- **Permission broker** (`apps/api/convex/permissionBroker.ts`). One
  server-side decision for risky actions: *allow* (a live approval covers
  this task, plan version and every target file), *ask* (request approval),
  *deny* (target outside the workspace, terminal task, or a standing
  rejection). Applying a change set goes through it; a push needs an
  approved `git_push` row, re-checked when the worker claims it.
- **Approval gate.** Projects default to `ask`: no file is written until you
  approve. Pushes need an explicit click.
- **Commands** run through an argv allowlist in a sandbox; tool calls are
  audited and secret-shaped arguments are redacted.
- **Credentials.** Provider keys are encrypted at rest and only ciphertext
  reaches the worker; public queries return `apiKeyConfigured`, never a key.
  GitHub tokens reach the worker only through a token-gated claim.
- **Auth.** There is deliberately no login and no rate limiting in this
  prototype. Ownership is enforced only when a project has an owner
  (`apps/api/convex/lib/authz.ts`); worker ↔ backend calls use the static
  `CONVEX_SERVICE_TOKEN` (timing-safe, fails closed when unset). Do not
  expose a deployment to an untrusted network.

## Testing

```bash
npm run doctor                             # setup checks (exit 1 on a required failure)
npm run typecheck                          # web + api + worker (needs convex/_generated)
npm test                                   # worker unit/integration tests (vitest)
npm run --workspace=@moagent/api test      # backend tests (convex-test, in-memory)
npm run test:scripts                       # doctor / supervisor unit tests (node:test)
cd apps/web && npx next build              # production build (needs NEXT_PUBLIC_CONVEX_URL)
npm run knip                               # unused files / dependencies
```

`npm test` does not need Convex codegen; `npm run typecheck` fails in
`apps/api` and `packages/worker` until `apps/api/convex/_generated/` exists
(`npx convex dev --once`).

## More

- [ROADMAP.md](ROADMAP.md) — open work, grouped Now / Next / Later.
- `AGENTS.md` (root, `apps/web`, `apps/api/convex`, `packages/worker`) —
  contributor rules and module contracts.
- `plans/` — design notes for larger changes.
