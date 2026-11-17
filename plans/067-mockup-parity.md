# 067 — Match the workspace mockup (accent + rail + sidebar + chat restyle)

## Goal

Restyle the workspace to match the developer's mockup (screenshot, 2026-11-17):
a persistent left app rail, purple accent primary, filled status chips, and the
small composer/card details. The audit (Explore, 2026-11-17) found the app is
already structurally ~90% there — this is a token + rail + restyle pass, not a
rebuild. Developer decisions: **purple accent is approved** (the "no brand
colour" guard policy changes with it) and the sidebar usage/quota footer is
**dropped**.

## Progress

### Stage 1 — DONE `2026-11-17`

Landed as written, with three deviations recorded here:

- The tokens are named `--shell-brand*` / `bg-brand*` (not `--accent*`) and live
  in `apps/web/app/globals.css` (`:root` + `.dark`): `--shell-brand`,
  `--shell-brand-hover`, `--shell-brand-soft`, `--shell-brand-ink`. The name
  matches the `bg-ink`/`bg-panel` family the rest of the UI already uses.
- `scripts/guards/rules.mjs`: the `brand` rule, its `RULE_HELP` entry and its
  export are gone; brand classes now count as theme tokens. `tint` (palette
  classes) and `hex` (raw colours) still catch what the plan asked for.
- `apps/web/tests/unit/uiRules.test.mjs` was still importing `brandUses`, so the
  whole guard suite failed to load. Its brand test is now "the accent tokens are
  allowed, other palette tints are not".
- `components/DiffCard.tsx` carried the 29 remaining hexes in the
  `react-diff-viewer` theme objects. They are now the `--shell-diff-*` tokens
  (16 per palette, values unchanged), so the viewer follows light/dark through
  CSS instead of two hardcoded objects. "Approve all" was `bg-emerald-600` →
  `bg-brand`.
- `components/sidebar/ProjectList.tsx` had a new `pill` violation (the count
  badge from stage 3) and 4 baselined red tints; both are fixed (rounded-md,
  `bg-danger/10`), which unblocked the budget guard.

**Check**: `pnpm run check:guards` → ok, none over; `apps/web` `uiRules` test →
14/14; `pnpm --workspace=@fhara/web typecheck` → clean. Not done: the visual
smoke in light + dark (no browser check in this session).

### Stage 2 — landed before this session

`components/Sidebar.tsx:157-193` already renders the persistent rail (logo,
new project, inbox, personal messages, activity, then PanelLeft toggle,
settings, account at the bottom) beside the folding sidebar; the collapse
pref only folds the content pane. One mockup detail is missing: the rail has
no theme control (theme lives in Settings).

### Stage 3 — DONE `2026-11-17`

- `sidebar/NeedsYou.tsx`: rows are standalone cards now
  (`rounded-xl border border-line bg-panel-2`, hover border), and the loading
  placeholder no longer uses `animate-pulse`.
- `sidebar/TeamList.tsx:18-27,51` already had the per-status dot + tone map.
- `sidebar/ProjectList.tsx`: count badge `rounded-full` → `rounded-md` (the
  pill guard), delete hover moved from `red-50/red-600` to `bg-danger/10`
  `text-danger`.
- No quota footer (dropped by decision).

### Stage 4 — DONE `2026-11-17`

- `chat/cards/primitives.tsx:22` already had `BTN_PRIMARY` on the accent, and
  `ui/status-tag.tsx` + the `status-tag` utility already carry the soft tinted
  fill, so items 8's two halves were in place; the chips ("Needs you",
  "In progress", "Approved") all render through `StatusTag` already.
- `chat/OptionCards.tsx`: "You picked X" is an accent chip
  (`border-brand/30 bg-brand-soft text-brand`) with a check icon.
- `chat/StatusLine.tsx`: the status line carries the quiet `···` prefix
  (aria-hidden, so screen readers keep the sentence alone).
- `chat/ChatComposer.tsx`: placeholder is `Message {project}, or type / for a
  command` (narrow: `Message {project}`); new `@` and `/` toolbar buttons call
  the existing `insertAtCursor`, which opens the mention and slash menus the
  composer already had; an "Enter to send" / "Ctrl+Enter to send" hint sits
  beside Send and follows the `enterToSend` uiPref. Send was already accent.
- `chat/TaskCard.tsx`: the meta row now starts with the task ref (`taskRef`)
  and appends `due …` from `dueAt`, danger-toned once overdue (same helpers as
  `TaskDock`).

### Stage 5 — DONE `2026-11-17`

- `TaskThreadPanel.tsx` QA rows print a word — `clean` / `failed` / `blocked` /
  `running` — instead of the raw status token. No spacing change: the mockup
  screenshot is not in the repo, so there is nothing to diff against.

**Check**: `pnpm --filter @fhara/web typecheck` clean, `pnpm run check:guards`
ok, web unit tests 197/198 (the one failure is the pre-existing
`createAgentPrefill` prompt-wording drift). `next build` run separately.

## Stage 1 — Accent token + guard

1. `apps/web/app/globals.css` — add accent tokens to `@theme inline` and both
   palettes: `--accent` (violet ≈ #6c5ce7), `--accent-hover`, `--accent-soft`
   (tinted chip fill), `--accent-ink` (text on accent); light + dark values.
2. `scripts/guards/rules.mjs` — replace the "no brand colour" rule with one
   that allows the accent token/classes (`bg-accent*`, `text-accent*`,
   `ring-accent*`) and still rejects raw brand hexes/Tailwind palette classes
   (`indigo-*`, `violet-*`, `purple-*`, raw hexes) outside tokens.
3. De-hardcode the existing raw hexes into tokens: `DiffCard.tsx:143-148,209-217`
   (green/red → ok/danger), `ApprovalCard.tsx:228`, `OptionCards.tsx:33,75,179`
   (indigo → accent tokens).

## Stage 2 — App rail

4. `components/Sidebar.tsx` — split into a persistent icon rail (logo tile,
   "+" new-project tile, Inbox, Activity, bottom: theme + Settings gear +
   account avatar) that always renders, with the expandable sidebar beside it
   (reuses `RailItem`, `SidebarChrome` Logo/AccountRow). The collapsed-sidebar
   mode folds the content pane only.

## Stage 3 — Sidebar restyle

5. `components/sidebar/NeedsYou.tsx` — notification rows → standalone rounded
   cards (mockup look).
6. `components/sidebar/TeamList.tsx` — per-status colored dots (status → tone
   map: needs-you warn, running/active ok, queued/neutral, rest muted) beside
   the status word; `ProjectList.tsx` badge shape rounder.
7. No quota footer (dropped by decision).

## Stage 4 — Chat surface restyle

8. `components/chat/cards/primitives.tsx` + `PushCard.tsx` — primary action
   button ink → accent; `StatusTag` gains a filled/tinted variant (ui/
   status-tag.tsx) used by "Needs you"/"In progress"/"Approved" chips.
9. `components/chat/TaskCard.tsx` — meta row gains task ref + due date (data
   already on the task row; pattern from TaskDock.tsx:99-106).
10. `components/chat/OptionCards.tsx` — "You picked X" plain text → accent chip.
11. `components/chat/StatusLine.tsx` — "··· " prefix.
12. `components/chat/ChatComposer.tsx` — placeholder "Message {name}, or type /
    for a command"; add @ and / toolbar buttons that open the existing mention
    and slash menus; "Enter to send" hint beside the send button (respects the
    enterToSend uiPref); send button ink → accent.

## Stage 5 — Task thread panel

13. `components/TaskThreadPanel.tsx` — QA check wording (raw status word →
    "clean"/"running" style labels); minor spacing to match the mockup.

## Non-goals

- The sidebar usage/quota footer (dropped).
- Routing/behaviour changes — this plan is presentation only.

## Definition of done

- `pnpm run` guard script passes with the new accent policy; typecheck web
  green; visual smoke on the dev server in light + dark: rail + sidebar match
  the mockup layout, chat cards/composer/thread restyled, no raw brand hexes
  left (guard-enforced).
