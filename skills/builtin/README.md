# Fhara built-in skills

Skills Fhara seeds into the Library and attaches to the fixed team on the
first team sync (`apps/api/convex/lib/builtinSkills.ts`, generated from these
folders by `npm run skills:builtin`). They are also listed in the Library
Browse catalog (`npm run catalog:build`). Each SKILL.md is kept within the
inline skill prompt budget; large references live behind tools (the
Designer's `design_lookup`).

Licences: Fhara-written skills are MIT like the repository. Adapted skills
keep their upstream licence, named in the front matter and the header
comment; Apache-2.0 skills carry their LICENSE.txt and NOTICE in the folder.
Details: THIRD_PARTY_NOTICES.md.

## Skills

| Skill | Description | Roles |
| --- | --- | --- |
| [design-system-detection](https://github.com/aldifhr/Fhara/tree/main/skills/builtin/design-system-detection) | Read the app's Tailwind config, CSS tokens and component library first and design within them. | Designer, Frontend |
| [design-options-review](https://github.com/aldifhr/Fhara/tree/main/skills/builtin/design-options-review) | Mock 2–4 static HTML variants and ask the user with show_options before building; check the build against the pick. | Designer, QA |
| [frontend-design](https://github.com/aldifhr/Fhara/tree/main/skills/builtin/frontend-design) | Aesthetic direction without templated defaults (Apache-2.0, adapted from anthropics/skills). | Designer, Frontend |
| [ui-ux-rules](https://github.com/aldifhr/Fhara/tree/main/skills/builtin/ui-ux-rules) | Prioritized UI/UX rules plus the design_lookup database (MIT, adapted from ui-ux-pro-max). | Designer, Frontend |
| [accessibility-audit](https://github.com/aldifhr/Fhara/tree/main/skills/builtin/accessibility-audit) | Read-only WCAG 2.2 audit with a fix per finding (MIT, adapted from awesome-agent-skills). | Designer, QA, Reviewer |
| [web-interface-guidelines](https://github.com/aldifhr/Fhara/tree/main/skills/builtin/web-interface-guidelines) | Review against the Vercel Web Interface Guidelines, fetched at run time (MIT, vercel-labs/agent-skills). | Designer, Reviewer |
| [fhara-discipline](https://github.com/aldifhr/Fhara/tree/main/skills/builtin/fhara-discipline) | Work classes C0–C5 with verification floors; prove a claim before reporting it done (MIT, adapted from goat-si/goat). | Frontend, Backend, DevOps |
