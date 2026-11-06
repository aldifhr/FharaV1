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
