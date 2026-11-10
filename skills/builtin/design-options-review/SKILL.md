---
name: design-options-review
description: When a UI change has more than one plausible direction, mock 2–4 variants as static HTML and ask the user with show_options before anyone builds; afterwards check the build against the picked mockup.
license: MIT
---
<!-- Fhara built-in skill. The mock-first and build-beside-mockup rules follow threadbear's AGENTS.md and show_options (MIT, Copyright (c) 2026 Mike Cann); wording and flow written for Fhara. See THIRD_PARTY_NOTICES.md. -->

# Design options review

**When.** Use show_options when the task leaves more than one reasonable layout or interaction. A small fix with one obvious answer gets no review: describe the change and finish.

**Mockups are static HTML + CSS only.** One self-contained page per option: inline `<style>`, real copy, the app's tokens (design-system-detection). No `<script>`, no event handlers, no forms, iframes or external URLs (fonts, images, CDNs); images only as `data:` URIs or files you name from the review's design folder (Fhara inlines them). Fhara validates and sanitizes every page, renders it to a PNG with scripts off, and returns findings if something is not allowed; fix them and call again.

**Call** `show_options` once with:
- `title`: what the user is choosing; `note`: one short lead.
- `options`: 2–4 variants, ids `A`, `B`, `C`… each `{id, title, kind: "html", html, note}` where the note says the trade-off in one or two sentences. Show other states of one variant inside the same page, not as extra options.
- `route`: the app route the design is for (`/settings`), so QA can screenshot the build later.
- optional reference: today's screen as `{id: "now", reference: true, kind: "image", path}` or, when the app runs, `{id: "now", reference: true, kind: "route"}` (cannot be picked).
- `recommended`: the id you would pick, with the reason in its note.

**Then** wait for the answer the tool returns: picks (one, several, or none), a note per option and a reply. Write the final design spec for the picked option(s), folding in the notes. If the user picked none, propose a revised direction from the reply instead of building anything.

**After the build** (QA or Reviewer): screenshot the same route and compare its layout with the picked mockup: regions, order, alignment, density. Report mismatches as warnings, not failures.
