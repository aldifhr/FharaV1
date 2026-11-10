---
name: accessibility-audit
description: Read-only WCAG 2.2 audit of UI, markup or a mockup with a concrete fix per finding. Use before shipping a page, form, dialog or design option.
license: MIT
---
<!-- Source: github.com/khasky/awesome-agent-skills skills/awesome-accessibility-audit (MIT, Copyright (c) 2026 Khasky). Modified by Fhara: condensed to fit Fhara's skill prompt budget. See THIRD_PARTY_NOTICES.md. -->

# Accessibility audit

Report findings with the fix; do not apply them unless your subtask is the change itself. Never claim full compliance from one review.

Walk each area:
1. **Structure**: one `h1`, ordered headings, landmarks (`main`, `nav`), `lang` and a page `title`, zoom not disabled, reflow at 320 px, text spacing does not clip.
2. **Keyboard**: everything focusable in visual order, visible `:focus-visible`, no traps, Escape closes overlays, custom widgets use arrow keys, hover/focus popovers are dismissible and hoverable.
3. **Names**: visible labels tied to inputs, `autocomplete`, errors linked with `aria-describedby` and announced, paste never blocked, accessible name contains the visible text, meaningful `alt` or `alt=""`, decorative icons `aria-hidden`.
4. **Colour**: 4.5:1 text, 3:1 large text and UI parts (give the computed ratio and a passing colour), never colour alone for state.
5. **Dynamic content**: `aria-live` polite for updates (assertive only for urgent), dialogs move and return focus, state via `aria-expanded`/`aria-selected`/`aria-current`.
6. **Motion and media**: `prefers-reduced-motion`, nothing flashes > 3 times a second, auto-moving content can be paused, captions.
7. **WCAG 2.2**: focus not obscured by sticky bars, targets ≥ 24×24 px, a click alternative to dragging, no redundant entry, no cognitive test to sign in.

Each finding: location, issue, WCAG criterion, impact, fix (code or attribute), severity Critical / High / Medium. End with a count per severity and what only a screen reader or a second viewport could settle, named as untested.
