# MOAgent

Multi-agent orchestrator: a planner builds a DAG of subtasks, agents execute
them (code change, review, QA, audit/research), file changes go through a
human approval gate, and results are verified before a task is marked done.

Workspaces:

- `apps/web` — Next.js UI (`@moagent/web`)
- `apps/api` — Convex backend (`@moagent/api`, code in `apps/api/convex`)
- `packages/worker` — the worker that claims and executes tasks (`@moagent/worker`)
- `electron/` — optional desktop shell

## Setup

```bash
git clone <this repo>
cd MOAgent
npm install
```

### 1. Convex backend (one-time login + codegen)

The Convex generated client (`apps/api/convex/_generated/`) is **gitignored**
and does not exist in a fresh clone. Without it, typecheck and the backend
cannot run. Generate it once:

```bash
npx convex dev
```

This opens a browser login (Convex account), links or creates a deployment,
writes `NEXT_PUBLIC_CONVEX_URL` to `.env.local`, and generates
`convex/_generated/`. Leave it running while you develop — it also pushes
schema/function changes live. For a fully local backend, `npx convex dev`
offers an anonymous local deployment instead of a cloud one.

### 2. Environment

Create a root `.env` (the worker loads `../../.env` relative to
`packages/worker`). Variable names only — never commit real values:

```bash
NEXT_PUBLIC_CONVEX_URL=   # written by `npx convex dev`
CONVEX_SERVICE_TOKEN=     # shared secret between worker and backend actions
LLM_PROVIDER=             # e.g. anthropic | openai-compatible
LLM_MODEL=                # fallback model when no provider is set in Settings
LLM_BASE_URL=             # fallback base URL (OpenAI-compatible endpoint)
LLM_API_KEY=              # fallback API key; per-provider keys live in Settings
WORKSPACE_ROOT=./workspaces
```

The LLM provider used per task is normally configured in the web UI
(Settings -> LLM providers, stored in the `llmProviders` table); the `LLM_*`
env values are only the fallback when no provider row exists.

## Authentication & security limitations

MOAgent is currently a **single-user, local-development prototype**. There
is no login or auth provider wired up, and it must not be exposed to an
untrusted network as-is. The concrete model today:

- **Ownership is conditional.** Project ownership (`projects.ownerId`) is
  enforced only when a project carries an `ownerId` *and* a viewer identity
  exists (`apps/api/convex/authz.ts`). Projects without an owner — every
  project in local mode — are accessible to anyone who can reach the
  deployment.
- **Worker ↔ backend** calls use one static shared secret,
  `CONVEX_SERVICE_TOKEN`. The comparison is timing-safe and fails closed
  when unset, but the token is not bound to a worker id and there is no
  rotation mechanism.
- **Provider administration is token-gated.** The `llmProviders`
  create/update/remove mutations require the service token. The Settings UI
  calls them through a server-side Next route
  (`apps/web/app/api/llm-providers`) that holds the token in the web
  server's environment — so the web server needs `CONVEX_SERVICE_TOKEN`
  set (server-side only, never a `NEXT_PUBLIC_*` variable) for Settings
  writes and model discovery to work. Provider read queries are public but
  never return the key (only `apiKeyConfigured`).
- **Credentials are stored in plaintext for now.** Provider API keys (and
  the legacy `agents.llmApiKey` field) sit unencrypted in the database
  until the Phase 2 encryption migration lands. Treat database access as
  credential access. Internal run contexts no longer ship the legacy agent
  key fields to the worker, and the browser never sends a provider key to a
  provider base URL directly (model discovery runs on the backend).

### 3. Run

```bash
npm run convex     # terminal 1: Convex dev + worker
npm run dev        # terminal 2: web UI on http://localhost:3000
```

Or run the pieces separately: `npm run worker`, plus `npx convex dev` inside
`apps/api`.

### 4. Verify

```bash
npm test           # worker unit/integration tests (vitest)
npm run typecheck  # web + api + worker (requires step 1: _generated)
```

`npm test` does not need Convex codegen. `npm run typecheck` fails in
`apps/api` and `packages/worker` until `convex/_generated/` has been
generated at least once — that is expected on a fresh clone, not a code
error.
