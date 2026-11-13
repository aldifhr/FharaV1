# Plan 050: One modal primitive for every overlay

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When
> done, set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: M
- Risk: MEDIUM (overlay focus/escape behaviour is user-visible)
- Dependencies: none
- Planned at: `improve` web-UI audit, 2026-11-13

## Why this is needed

The app has an accessible dialog primitive and does not use it. `ui/dialog.tsx`
wraps `@base-ui/react/dialog`, which supplies role, `aria-modal`, focus trap,
Escape, scroll lock and focus restore. It has exactly one consumer
(`components/ui/command.tsx`). Every other overlay is hand-rolled, and the
hand-rolled copies disagree:

| Implementation | Lines | Dialog semantics | Focus management |
| --- | --- | --- | --- |
| `components/ui/dialog.tsx` (base-ui) | 147 | from the primitive | from the primitive |
| `components/Modal.tsx` | 131 | `role="dialog"`, `aria-modal` | manual trap, focus-in, restore (`:29-70`) |
| `components/ConfirmDialog.tsx` | 142 | `role="alertdialog"`, `aria-modal` | a second copy of the same trap (`:42-72`) |
| `components/ui/inspector.tsx` | 348 | `role="dialog"`, `aria-modal` | manual (`:focus` 11 hits) |
| `components/context/ContextDrawer.tsx` | 52 | `role="dialog"`, `aria-modal` | **none** — Escape only (`:16-22`), focus stays behind the overlay |
| `components/Settings.tsx`, `components/sidebar/SidebarNav.tsx`, `components/integrations/IntegrationsPanel.tsx` | — | inline `createPortal` | per-component, unverified |

The failure is concrete: open the context drawer from a chat bubble, press Tab,
and focus walks the chat behind the overlay while the dialog claims
`aria-modal="true"`. Screen-reader and keyboard users lose the panel entirely.

Correcting two claims from the audit that produced this plan:

- `ConfirmDialog` **is** correct without `role="dialog"`: `role="alertdialog"`
  is the right role for a destructive confirmation, and it already has
  `aria-modal`.
- `ui/dialog.tsx` has no `role`/`focus` string in its source because the base-ui
  primitive renders them at runtime. It is the accessible one.

## Target behaviour

- One exported overlay component, built on `@base-ui/react/dialog`, used by
  Modal, ConfirmDialog, ContextDrawer, inspector and the inline portals.
- Every overlay: focus moves in on open, Tab cycles inside, Escape closes,
  focus returns to the trigger, background scroll is locked, `aria-labelledby`
  points at the title.
- No visual change: same card, drawer and backdrop styling per variant.

## Steps

### Step 1: Wrap the primitive once

Add `components/ui/overlay.tsx` (or extend `ui/dialog.tsx`) exporting the three
shapes the app needs, all on `DialogPrimitive.Root` + `Popup` + `Backdrop`:

- `OverlayDialog` — centred card (replaces `Modal`, `ConfirmDialog`);
- `OverlayDrawer` — right-side panel (replaces `ContextDrawer`, `inspector`);
- keep `showCloseButton`, `maxWidth`, `fullScreen` props so call sites change
  only their import.

**Check**: `npm run --workspace=@fhara/web typecheck` → clean.

### Step 2: Migrate the two shared components

`Modal.tsx` and `ConfirmDialog.tsx` become thin wrappers over the new primitive
(keep their public props; delete the hand-written trap at `Modal.tsx:29-70` and
`ConfirmDialog.tsx:42-72`). `ConfirmDialog` keeps `role="alertdialog"` and its
autofocus-on-cancel.

**Check**: grep — no `createPortal` left in `Modal.tsx` / `ConfirmDialog.tsx`;
`npm run --workspace=@fhara/web typecheck`.

### Step 3: Migrate the bespoke overlays

`ContextDrawer.tsx`, `ui/inspector.tsx`, and the inline portals in
`Settings.tsx`, `sidebar/SidebarNav.tsx`, `integrations/IntegrationsPanel.tsx`
use the drawer/overlay variant. Delete their per-component key handlers and
`mounted` state where the primitive replaces them.

**Check**: grep — `createPortal` appears only in `components/ui/overlay.tsx`.

### Step 4: Verify by hand

In the running app (`npm run dev`), for each migrated overlay: Tab from the
first field to the last wraps; Shift+Tab wraps backwards; Escape closes; focus
returns to the button that opened it; the page behind does not scroll.

## Test plan

- A unit test is not practical for focus behaviour without a DOM harness; the
  repo has no jsdom setup for components. Verify in the browser and record the
  result in this plan's state column (the repo's convention).
- Keep one manual checklist: confirm, attach-project, context drawer, inspector,
  settings, sidebar nav, integrations.

## Completion criteria

- [ ] One overlay module; `createPortal` exists only there.
- [ ] `Modal.tsx` and `ConfirmDialog.tsx` no longer implement a focus trap.
- [ ] Context drawer and inspector trap focus.
- [ ] `npm run --workspace=@fhara/web typecheck` and `npm run build` clean.
- [ ] Browser check of all seven overlays recorded in `plans/README.md`.

## STOP conditions

- A base-ui prop needed by a call site does not exist in
  `@base-ui/react/dialog` (check `node_modules/@base-ui/react/dialog`).
- A migrated overlay must stay non-modal (an inline popover, not a dialog) —
  leave that one alone and say so.
- A check fails twice after a reasonable fix.
