
# `apps/web` — UI

Vite + React 19 SPA, React Router, Tailwind 4, local runtime React client. Read the root
[`AGENTS.md`](../../AGENTS.md) first.

> The block above is written by `next dev`. Keep it. Add your own rules below it,
> never inside it.

## Layout

```
app/              routes: /, /project/[projectId],
                  /runs, /pull-requests, /library, /memory, /audit, /inbox, /search, /improve,
                  /integrations (plus the legacy redirects in plan 053)
app/api/          server-side routes (llm-providers, mcp-servers, project-files, …)
components/       feature components (ChatPanel, TaskBoard, TaskThreadPanel, Settings, …)
components/ui/    shared primitives
lib/runtime.tsx    Fhara runtime provider/client bootstrap
```

Every page segment ships a boundary: `app/error.tsx` (route errors),
`app/global-error.tsx` (root-layout errors), `app/not-found.tsx` (404).
`app/project/[projectId]/error.tsx` is the one page-specific override. Add a
nested boundary only when a page needs different copy, not by default.

## Data access

- Read with `useQuery(api.<module>.<fn>, args)` and write with
  `useMutation(api.<module>.<fn>)` from `runtime/react`. Import `api` from the
  generated client — do not build function names from strings.
- Never call a `internal*` function from the browser; it does not exist there.
- Provider administration (`llmProviders` create/update/remove) is token-gated
  and must go through `app/api/llm-providers/route.ts`, which holds
  `FHARA_SERVICE_TOKEN` server-side. Do not call those mutations from a client
  component, and never expose the token to browser code.
- The browser must never send a provider key to a provider base URL. Model
  discovery runs on the backend.
- Queries can be `undefined` while loading. Render a real loading state, not an
  empty state. `skip` the query when its required id is missing.

## UI rules

- Reuse `components/ui/` primitives before writing new ones. Keep the existing
  visual language; do not restyle a screen as part of a functional change.
- All UI copy in English. Fix Indonesian strings you touch.
- Every interactive control needs a working handler or must not ship. Do not add
  an icon button with no `onClick`.
- Modals render through a portal to `document.body` (containing-block fix for
  `backdrop-blur`). Keep that pattern.
- Use `loading="lazy"` and `referrerPolicy="no-referrer"` on remote `<img>`.
- Do not introduce a second theme/font state hook; `use-theme` and `use-font`
  are being merged into `useAppearance`.

## Client/worker boundaries

The UI never executes a task, never runs an agent, and never touches a
workspace file. It reads Fhara runtime state and writes intent (create task, approve,
cancel, edit agent). Anything that needs a file, a shell, or a provider call
belongs to `packages/worker`.

`app/api/*` routes have no session; the app is single-user local by design.
Their guard is `proxy.ts` + `lib/requestGuard.ts` (allowed Host, same-origin
writes) and the 127.0.0.1 bind in `scripts/next.mjs`. New mutating routes
should also call `rejectUnsafeRequest` (`lib/apiGuard.ts`) and, if they use
`FHARA_SERVICE_TOKEN`, forward a fixed list of fields (`lib/proxyArgs.ts`),
never the raw body. `app/api/project-files` takes a `projectId` and resolves
the workspace server-side (`lib/projectFilesPolicy.ts`). There is no
terminal route; shell work belongs to the worker. Do not present any of
this as an authorization boundary in UI copy.

## Checks

```
npm run --workspace=@fhara/web typecheck
npm run --workspace=@fhara/web test      # node:test unit tests for lib/ guards
npm run --workspace=@fhara/web build     # routing / bundling / server components
npm run check:guards                      # UI rules, code budget, import cycles (repo root)
```

Run `build` only when the change affects routing, data fetching, or bundling.
A copy, style, or component-props change does not need a build locally.

## Known debt

`ROADMAP.md` (repo root) lists the open UI work (focus trap, page restyles,
lint items L3/L4/L5/L7/L9). Fix an item when you are already in that file; do
not open a separate refactor for it.

