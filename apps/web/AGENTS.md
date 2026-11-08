<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# `apps/web` — UI

Next.js 16 app router, React 19, Tailwind 4, Convex React client. Read the root
[`AGENTS.md`](../../AGENTS.md) first.

> The block above is written by `next dev`. Keep it. Add your own rules below it,
> never inside it.

## Layout

```
app/              routes: /, /chat, /chats, /workspace/[projectId], /inbox, /search
app/api/          server-side routes (llm-providers, terminal, project-files)
components/       feature components (ChatPanel, TaskBoard, TaskThreadPanel, Settings, …)
components/ui/    shared primitives
lib/convex.tsx    Convex provider/client bootstrap
```

## Data access

- Read with `useQuery(api.<module>.<fn>, args)` and write with
  `useMutation(api.<module>.<fn>)` from `convex/react`. Import `api` from the
  generated client — do not build function names from strings.
- Never call a `internal*` function from the browser; it does not exist there.
- Provider administration (`llmProviders` create/update/remove) is token-gated
  and must go through `app/api/llm-providers/route.ts`, which holds
  `CONVEX_SERVICE_TOKEN` server-side. Do not call those mutations from a client
  component, and never put the token in a `NEXT_PUBLIC_*` variable.
- The browser must never send a provider key to a provider base URL. Model
  discovery runs on the backend.
- Queries can be `undefined` while loading. Render a real loading state, not an
  empty state. `skip` the query when its required id is missing.

## UI rules

- Reuse `components/ui/` primitives before writing new ones. Keep the existing
  visual language; do not restyle a screen as part of a functional change.
- All UI copy in English. Fix Indonesian strings you touch (see `ROADMAP.MD`).
- Every interactive control needs a working handler or must not ship. Do not add
  an icon button with no `onClick`.
- Modals render through a portal to `document.body` (containing-block fix for
  `backdrop-blur`). Keep that pattern.
- Use `loading="lazy"` and `referrerPolicy="no-referrer"` on remote `<img>`.
- Do not introduce a second theme/font state hook; `use-theme` and `use-font`
  are being merged into `useAppearance` (`ROADMAP.MD`).

## Client/worker boundaries

The UI never executes a task, never runs an agent, and never touches a
workspace file. It reads Convex state and writes intent (create task, approve,
cancel, edit agent). Anything that needs a file, a shell, or a provider call
belongs to `packages/worker`.

`app/api/terminal` and `app/api/project-files` are local-development
conveniences. They are not an authorization boundary — the app is single-user
local by design. Do not present them as secure in UI copy.

## Checks

```
npm run --workspace=@moagent/web typecheck
npm run --workspace=@moagent/web build     # routing / bundling / server components
```

Run `build` only when the change affects routing, data fetching, or bundling.
A copy, style, or component-props change does not need a build locally.

## Known debt

`ROADMAP.MD` lists the current UI debt (dead Aceternity components, unwired header
buttons, `@theme inline` warning, theme/font split). Fix an item when you are
already in that file; do not open a separate refactor for it.

