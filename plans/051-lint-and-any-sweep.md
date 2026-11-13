# Plan 051: Lint the web app and pay down its `any` debt

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: L
- Risk: LOW for the lint setup, MEDIUM for the type sweep (touches chat UI)
- Dependencies: none
- Planned at: `improve` web-UI audit, 2026-11-13

## Why this is needed

- `apps/web` has no ESLint. There is no `eslint.config.*`, no `lint` script and
  no `eslint`/`typescript-eslint` in `node_modules`. Rules that catch the exact
  bugs this app ships — `react-hooks/exhaustive-deps`, `no-explicit-any`,
  `jsx-a11y/*` — are never checked. `npm run check:guards` only enforces import
  layering, module budget and import cycles.
- 269 `any` usages (measured: `as any`, `: any`, `<any>`, `any[]`) across
  `app/`, `components/`, `lib/`, concentrated in the chat/task core:

  | File | Occurrences |
  | --- | --- |
  | `components/ChatPanel.tsx` | 67 |
  | `components/TaskThreadPanel.tsx` | 53 |
  | `components/chat/MessageList.tsx` | 30 |
  | `components/AgentDetailPanel.tsx` | 12 |
  | `components/chat/PersonalChatPanel.tsx` | 12 |

- 68 of them are Convex id casts, e.g.
  `useQuery(api.changes.forTask, { taskId: taskId as any })`
  (`components/changes/ChangesPane.tsx:62`, `components/chat/cards/PushCard.tsx:102`,
  `components/changes/useLineComments.tsx:28`). The cast hides a real contract:
  the prop is typed `string`, the query wants `Id<"tasks">`. Rename a field in
  the schema and the cast keeps compiling while the query silently receives the
  wrong id — a wrong-data bug in the most expensive surface.
- 12 `@ts-ignore` / `@ts-expect-error` / `eslint-disable` comments pre-date
  this plan; two carry no reason.

## Target behaviour

- `npm run lint` (workspace `@fhara/web`) runs ESLint in flat-config mode over
  `app/ components/ lib/`.
- Errors: `react-hooks/rules-of-hooks`, `react-hooks/exhaustive-deps`,
  `@typescript-eslint/no-explicit-any` **at warn** first, `jsx-a11y/alt-text`,
  `jsx-a11y/anchor-is-valid`, `jsx-a11y/click-events-have-key-events`.
- The `any` count is ratcheted, not fixed in one commit: a baseline file (or
  `--max-warnings`) fails the build when it grows.
- Convex ids in component props are `Id<"...">`, so the 68 casts disappear.

## Steps

### Step 1: Add ESLint without touching source

- Add dev dependencies at the repo root: `eslint`, `typescript-eslint`,
  `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`,
  `@next/eslint-plugin-next`.
- `apps/web/eslint.config.mjs`: flat config, `next/core-web-vitals`-equivalent
  rules via `@next/eslint-plugin-next`, the four plugins above, ignores for
  `.next`, `node_modules`, `api/convex/_generated`.
- Root script: `"lint": "npm run --workspace=@fhara/web lint"`, workspace script
  `"lint": "eslint ."`.
- Run it once and write down the counts. Expect hundreds of
  `no-explicit-any` warnings; set that rule to `warn` and let the other rules
  start at `error` only after the baseline is clean.

**Check**: `npm run lint` runs to completion (exit 0 with warnings, or a
documented list of errors to fix in Step 2).

### Step 2: Fix what ESLint finds for real

- `react-hooks/exhaustive-deps` hits: fix the dependency array or hoist the
  value. Do not disable the rule to pass.
- `jsx-a11y` hits: real fixes (label, alt, keyboard handler). A disable needs a
  reason on the same line.
- Delete the 12 `@ts-ignore` / `eslint-disable` comments or add the reason.

**Check**: `npm run lint` exit 0; `npm run --workspace=@fhara/web typecheck`.

### Step 3: Type the Convex ids (the 68 casts)

Start with the three files that already take a `taskId` prop and cast it:
`components/changes/ChangesPane.tsx`, `components/changes/useLineComments.tsx`,
`components/chat/cards/ChangesCard.tsx`. Change the prop type from `string` to
`Id<"tasks">` and follow the compiler up through the callers (this is ROADMAP
lint item L3). Repeat per id type (`pushId`, `messageId`, `projectId`).

Do **not** reach for `as Id<"tasks">` at the boundary; if a value really is an
untyped string coming from a card payload (`data.taskId`), narrow it in the
card's payload type instead.

**Check**: `npm run --workspace=@fhara/web typecheck`; grep for `Id as any` →
each remaining hit should be gone or justified.

### Step 4: Ratchet

- Record the remaining `any` count in the config as `--max-warnings`.
- Add `npm run lint` to the checks block in `apps/web/AGENTS.md` and to the root
  `AGENTS.md` table.

## Test plan

- No behavioural test: this change is types and tooling.
- Prove it works by (a) `npm run lint` green, (b) typecheck green, (c) one
  deliberate `any` added locally fails the ratchet, then removed.

## Completion criteria

- [ ] `eslint.config.mjs` exists; `npm run lint` is green.
- [ ] The rules listed above are active and no fix is a blanket disable.
- [ ] `Id as any` casts in `changes/` and `chat/cards/` are gone.
- [ ] The `any` baseline is recorded and enforced.
- [ ] `npm run knip` reports no new findings (the new dev deps are used).

## STOP conditions

- `eslint-config-next` / a plugin does not support Next 16 + flat config — check
  `node_modules/next/dist/docs` and the plugin's docs; if incompatible, stop and
  report rather than pinning an old ESLint major.
- The `any` sweep would need a schema or backend change (it should not).
- A check fails twice after a reasonable fix.
