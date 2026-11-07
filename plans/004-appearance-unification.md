# Plan 004: Unify appearance (theme + font + system)

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When done,
> set this plan's state in `plans/README.md`.

## Status

- Priority: P3
- Size: S
- Risk: LOW
- Dependencies: none
- Planned at: `main`, 2026-11-07

## Why this is needed

Theme and font are two independent hooks with two independent stores. Changing
one does not update the other until a remount, and the theme choice has no
`system` option even though the boot script already reads
`prefers-color-scheme`.

## Target behaviour

| Action | Result |
| --- | --- |
| Pick Light / Dark / System | Applied immediately and persisted |
| Pick a font | Applied immediately and persisted |
| Change OS theme while "System" is chosen | UI follows without a remount |
| Reload | Both choices survive |

## Current state

- `apps/web/components/ui/use-theme.ts` — `next-themes` wrapper exposing
  `theme`, `setTheme`, `toggleTheme`; type is `"light" | "dark"` only.
- `apps/web/components/ui/use-font.ts` — separate store (localStorage +
  `data-font`).
- `apps/web/components/Settings.tsx` — `FONT_OPTIONS` (12) and the theme control
  (~60).
- `apps/web/app/layout.tsx` — the boot script / provider setup; check it before
  changing the storage key.

## Decisions that must not change during execution

- One storage key for appearance. Do not keep two keys that can disagree.
- `next-themes` stays the theme engine. Do not hand-roll a second theme switcher.
- The no-flash boot script must keep working: the theme is applied before first
  paint, so the page never flashes the wrong palette.
- Existing users keep their saved choice. Read the old keys once, migrate, then
  write only the new key.
- Do not restyle anything. This is state plumbing only.

## Steps

### Step 1: One hook

Create `apps/web/components/ui/use-appearance.ts`:

```
type ThemeChoice = "light" | "dark" | "system";
type FontChoice = "geist" | "inter" | "system" | "jetbrains";
```

- Wrap `next-themes` (`useTheme`, `setTheme`, `resolvedTheme`).
- Own the font: read/write `localStorage`, set `data-font` on
  `document.documentElement`.
- Migrate the old font key on first read, then remove it.
- Export `{ theme, resolvedTheme, setTheme, font, setFont }`.

**Check**: typecheck exits 0; `use-theme.ts` and `use-font.ts` have no remaining
importers (`grep -rn "use-theme\|use-font" apps/web`).

### Step 2: Settings

Replace the two controls with the unified hook, and add the System option with a
short description of what it does.

**Check**: typecheck exits 0.

### Step 3: Boot script

Update `app/layout.tsx` so the inline script applies the saved theme before paint
and respects `system`. Keep `suppressHydrationWarning` on `<html>`.

**Check**: a hard reload in dark mode shows no light flash (manual, 3 reloads).

### Step 4: Delete the old hooks

Remove `use-theme.ts` and `use-font.ts` after the last importer is gone.

**Check**: `npm run --workspace=@moagent/web build` → exit 0.

## Test plan

- Manual: switch theme → switch font → reload; both persist.
- Manual: set System, change the OS appearance; the UI follows.
- Manual: a pre-existing font key is migrated and the old key is cleared.
- No automated test is required for a pure client preference; state that it was
  checked by hand.

## Completion criteria

- [ ] One hook, one storage path, System supported.
- [ ] No flash on reload.
- [ ] Old keys migrated, old hooks deleted.
- [ ] `npm run --workspace=@moagent/web typecheck` and `build` pass.

## STOP conditions

- `next-themes` cannot represent a three-way choice without a custom provider.
- The boot script must run on the server to avoid a flash (then revisit).
