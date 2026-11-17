# Fhara

Fhara is an open-source control plane for coding agents. A planner turns a task
into a DAG of subtasks, agents execute them (code change, review, QA, audit and
research), file changes pass a human approval gate, and a task is only marked
done after verification.

This repository is the application itself, run from source. It does not ship a
desktop installer, a mobile app, or a package-manager formula, and nothing in it
is published to an app store.

## What runs here

| Piece | Path | Responsibility |
| --- | --- | --- |
| Web UI | `apps/web` | Next.js 16 (React 19, Tailwind 4): tasks, chats, diffs, approvals, settings |
| Backend | `apps/api/convex` | Convex schema, queries/mutations/actions, authz, approvals, orchestration records |
| Worker | `packages/worker` | claims tasks, plans, runs the DAG, calls agents and LLMs, gates risky actions |
| Desktop shell | `electron/` | optional Electron window around the dev server (`electron/main.cjs`) |

## Requirements

- Node 24 (`.nvmrc`) and pnpm 12.21.0 (`packageManager` in `package.json`).
- A Convex deployment: cloud (`npx convex dev`) or self-hosted.
- An LLM provider: a connection in **Settings → LLM & Models**, or the `LLM_*`
  fallback in `.env`.
- The agent CLIs you want Fhara to drive, installed and signed in on the same
  machine.

## Setup

1. `pnpm install`
2. `cp .env.example .env` and fill the required values: `NEXT_PUBLIC_CONVEX_URL`,
   `CONVEX_SERVICE_TOKEN` (`openssl rand -hex 32`) and `PROVIDER_ENCRYPTION_KEY`
   (`openssl rand -base64 32`). The worker and the Convex deployment must use the
   same `PROVIDER_ENCRYPTION_KEY`.
3. `cp apps/api/.env.example apps/api/.env.local` and point the Convex CLI at a
   deployment: `CONVEX_DEPLOYMENT`, or `CONVEX_SELF_HOSTED_URL` +
   `CONVEX_SELF_HOSTED_ADMIN_KEY`.
4. `pnpm run codegen:offline` (or `npx convex dev`) once.
   `apps/api/convex/_generated/` is gitignored, so a fresh clone cannot typecheck
   until the client has been generated.
5. `pnpm run doctor` — checks the local setup and prints a fix hint per problem;
   it never prints a secret value.
6. `pnpm dev` — syncs env to the deployment, then runs Convex dev, the web app on
   port 3000 and the supervised worker.

## Commands

| Goal | Command |
| --- | --- |
| Web UI + API + worker | `pnpm dev` |
| Web UI only | `pnpm dev:web` |
| Convex dev + worker | `pnpm convex` |
| Worker only | `pnpm worker` |
| Electron shell | `pnpm electron:dev` |
| Setup check | `pnpm doctor` |
| All workspace typechecks | `pnpm typecheck` |
| Worker tests | `pnpm test` |
| Backend tests (in-memory) | `pnpm --filter @fhara/api test` |
| Script tests | `pnpm test:scripts` |
| Code budget + import cycles | `pnpm check:guards` |
| Unused files / deps | `pnpm knip` |
| Mock LLM + fixtures | `pnpm mock:llm`, `pnpm fixtures:seed` |

## Agents and providers

Driver kinds live in `packages/contracts/src/model.ts`: Codex, Claude, Cursor,
Grok, fx, Kiro, Muse Code, Pi, Antigravity, OpenCode, and any agent in the ACP
registry. Model choice comes from the model registry (`llmModels`), not from a
hardcoded model in an agent path.

## Platform support

| Platform | State |
| --- | --- |
| Windows | The environment this tree is developed in; run from source. The full worker suite has pre-existing Windows-only failures (see `plans/README.md`, plan 046). |
| Linux | CI (`.github/workflows/ci.yml`, `ubuntu-latest`) runs guards, typecheck and the api/worker suites. |
| macOS | CI runs the same guards, typecheck and suites on `macos-latest` (arm64). There is no packaged `.app`/`.dmg` and no Intel runner, so a macOS build still means running from source. |

The OS command sandbox is `bwrap`, Linux only. On macOS and Windows an unset
`SANDBOX_MODE` resolves to `off` (`packages/config/src/schema/exec.ts`), so agent
commands run without an OS sandbox there.

## Tests

Backend tests use `convex-test` in memory (no deployment, no codegen); worker
tests are plain Vitest. Live-provider and Playwright suites are opt-in and not
part of the default run. Never weaken a test to make a check pass.

## Docs

- `docs/mcp-filesystem.md` — MCP servers as external tool providers.
- `docs/mock-fixtures.md` — synthetic fixtures and the mock LLM.
- `docs/skills-import.md` — importing skills from GitHub.
- `docs/worktree-isolation.md` — worktree isolation and parallel steps.
- `plans/` — design plans and their state (`plans/README.md` is the index).
- `AGENTS.md`, `apps/api/convex/AGENTS.md`, `packages/worker/AGENTS.md`,
  `apps/web/AGENTS.md` — per-surface rules, checks and non-negotiables.

## Contributing

Read `AGENTS.md` before changing code: it lists the architecture rules, the
non-negotiable safety rules (provider keys, worker token, terminal tasks, tool
sandboxing, approval gate, budget gate, schema migrations) and the narrowest
check to run per change.

## Licensing

This tree has no `LICENSE` file yet, so no license is declared for it. Code
adapted from other projects is attributed, with its upstream license text, in
`THIRD_PARTY_NOTICES.md`.
