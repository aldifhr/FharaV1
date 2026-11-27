# Plan 087: remove misleading UI/UX states

> Read-only audit (plan 085 follow-up) found contradictory labels, dead
> controls, and false empty/loading states. This plan fixes the user-visible
> lies without changing safety gates or schema.

## Status

- Priority: P2
- Size: M
- Risk: LOW
- Planned at: working tree after `4395b2d9`, 2026-11-26

## Target

- No button/dialog promises an action the UI will not offer.
- Settings that claim to control behavior actually do.
- Counts, status tags, and empty states describe the same reality.
- Verification/check labels say what ran and where the data came from.

## Steps

1. Cancel-copy and retry affordance consistency (`TaskThreadPanel.tsx`, `taskStatus.ts`).
2. Thread checks: explicit `not run`/`pending` instead of fake `running` spinner.
3. Inbox: project option-review items or fix the count.
4. Composer: honour `enterToSend` and real keybinding chords.
5. Status tags: show true task status plus a secondary needs-you badge.
6. Approval/push provenance, option-pick state, handoff heading vs mention.
7. ChangesPane/context label/overview loading/settings dead rows/runs labels/copy.

## Check

Worker/web tests, web typecheck, `pnpm run check:guards`, and a browser smoke
of the changed surfaces. Record what was not verified.
