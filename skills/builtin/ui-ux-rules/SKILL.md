---
name: ui-ux-rules
description: Prioritized UI/UX rules (accessibility, touch, layout, type, colour, motion, forms, navigation) plus the design_lookup tool for styles, palettes, font pairings, product patterns and the full UX guideline list.
license: MIT
---
<!-- Source: github.com/nextlevelbuilder/ui-ux-pro-max-skill (MIT, Copyright (c) 2024 Next Level Builder). Modified by Fhara: the rule table is condensed; the search runs as Fhara's design_lookup tool over a trimmed copy of the data. See THIRD_PARTY_NOTICES.md. -->

# UI/UX rules

Check in this order; stop at the first category that fails:

1. **Accessibility (critical)**: contrast 4.5:1 (3:1 large text and UI parts), alt text, keyboard reachable, labelled icon buttons, visible focus.
2. **Touch and interaction (critical)**: targets ≥ 44×44 px with 8 px spacing, loading feedback, nothing hover-only.
3. **Performance**: reserve space for media (no layout shift), lazy-load below the fold.
4. **Style fit**: the style matches the product type and stays consistent; SVG icons, never emoji as icons.
5. **Layout and responsive**: mobile-first breakpoints, no horizontal scroll, never disable zoom.
6. **Type and colour**: 16 px body, line height ≈ 1.5, semantic colour tokens, no raw hex in components, no grey on grey.
7. **Motion**: timing by context (150–300 ms), motion explains change, respect prefers-reduced-motion, animate transform/opacity only.
8. **Forms**: visible labels (not placeholder-only), errors next to the field, keep input on error.
9. **Navigation**: predictable back, deep links, ≤ 5 bottom-nav items.
10. **Charts**: legends and tooltips, never colour alone.

## design_lookup (when the tool is offered)

Read-only search over the database: `{"table": "style" | "color" | "typography" | "ux" | "product", "query": "2–5 words", "limit": 5}`. One intent per query, e.g. `{"table":"product","query":"fintech dashboard"}`, then `{"table":"ux","query":"error near field"}`. Check the top result fits this product before using it; retry once with narrower words, otherwise say no verified match was found. In an existing app the app's tokens win over any palette from the table.
