---
name: web-interface-guidelines
description: Review UI code or a mockup against the Vercel Web Interface Guidelines and report findings as terse file:line items.
license: MIT
---
<!-- Source: github.com/vercel-labs/agent-skills skills/web-design-guidelines (MIT per the repository README, author Vercel). Modified by Fhara: renamed, rules are still fetched at run time (not vendored), and a fallback list is added for agents without web access. See THIRD_PARTY_NOTICES.md. -->

# Web interface guidelines review

1. If you can read the web, fetch the current rules first:
   `https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md`
   and apply every rule and the output format it describes. The rules are not copied into Fhara.
2. Otherwise say the live rules were not fetched and review against this fallback:
   - Interactions: every action is a `button` or a link with `href`; hit targets ≥ 24 px; Enter submits forms; no dead clicks; destructive actions confirm or undo.
   - Focus: visible `:focus-visible` ring; focus moves into dialogs and returns; no keyboard traps.
   - Forms: labelled inputs with `type`, `autocomplete`, `inputmode`; paste allowed; errors inline and announced; submit stays enabled until the request starts.
   - Content: no truncation that hides meaning; numbers in tabular figures; dates and numbers formatted for the locale; empty, loading and error states exist.
   - Layout: safe areas respected, no layout shift from late content, works at 320 px and 200 % zoom.
   - Motion: honour `prefers-reduced-motion`; animate only transform/opacity; no animation on first paint for its own sake.
   - Performance: images sized and lazy; large lists virtualized; no blocking web fonts without fallback.
3. Report each finding as `path:line — rule — fix`, most severe first. Say which files you did not read.
