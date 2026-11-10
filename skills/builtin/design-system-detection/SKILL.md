---
name: design-system-detection
description: Before designing or building UI in an existing app, read its Tailwind config, CSS tokens and component library and design within them. Never invent a new palette for an existing app.
license: MIT
---
<!-- Fhara built-in skill (written for Fhara, MIT like the rest of the repository). -->

# Design system detection

Do this before any mockup or UI change in an existing repository.

1. **Find the tokens.** Read, when present: `tailwind.config.*` (theme.extend), the global stylesheet (`app/globals.css`, `src/index.css`, `styles/*.css`) for `@theme`, `:root` and `.dark` custom properties, `components.json` (shadcn), and theme files (`theme.ts`, `tokens.json`).
2. **Find the parts.** List the shared primitives (`components/ui/*`, the library in `package.json`: shadcn/Radix, MUI, Chakra, Mantine, Headless UI) and the icon set in use.
3. **Write a short inventory** before designing: colour tokens by role (surface, text, muted, border, brand, danger), radius, spacing scale, type families and sizes, dark-mode strategy, the primitives you will reuse.
4. **Design within it.** Use only those tokens and primitives. A new token is allowed only when no existing one fits; name it in the same scheme and say why. Never add a new palette, font or icon set to an existing app, and never hard-code hex values in components.
5. **Mockups too.** HTML mockups copy the real token values into one inline `<style>` (`:root { --surface: …; }`) so the picture matches what Frontend can build.
6. **Greenfield only.** When the repo has no UI yet, say so and propose a token plan (frontend-design) instead.

Report the inventory with your result so Frontend and the Reviewer can check against it.
