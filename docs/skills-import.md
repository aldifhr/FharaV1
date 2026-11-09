# Importing skills from GitHub

`/library` → **Import from GitHub** reads any public repository (private ones
too when a project has a GitHub integration connected) and turns each
`SKILL.md` into a library skill.

- **URLs accepted:** `https://github.com/<owner>/<repo>`,
  `…/tree/<ref>/<folder>`, `…/blob/<ref>/<path>/SKILL.md`.
- **Preview** (`skills:previewGithubImport`) walks the git tree at the
  resolved commit, finds up to 100 `**/SKILL.md`, and shows name and
  description (front matter, else folder name and first paragraph), body
  size, license (SPDX id) and the short commit sha.
- **Import** (`skills:importFromGithub`) stores the body without its front
  matter and records `source: { kind: "github", repo, path, sha, license,
  licenseUrl, url }`. Each import writes one `skill.import` audit row.
- **Cap:** a skill reaches the agent as `## Skill: <name>` inside a
  12,000-char per-agent budget, so the import cap is 11,929 chars. Longer
  bodies are trimmed by dropping trailing sections at markdown headings (then
  paragraphs, then lines, never mid-sentence) and end with
  `(trimmed from N chars; full: <url>)`; the skill is flagged `trimmed`.
- **Duplicates:** the same repo + path is never imported twice. Re-importing
  overwrites the body when the commit moved and keeps the skill's name and
  agent attachments; "Update from source" in the row's ⋯ menu does the same
  for one skill.
- **Roles:** in a skill's edit view, **Assign to roles** adds or removes the
  skill on every *enabled* agent with that role (`skills:assignRoles`).
  Disabled agents are left alone.

> The per-agent budget is shared. An agent with three skills that are each
> ~11.7k chars only receives the first one whole; the rest are dropped at run
> time. Keep the heaviest skill first, or attach fewer.

## Recommended mapping: emilkowalski/skills (MIT)

Source: <https://github.com/emilkowalski/skills> · license MIT. Import the
repo, then assign each skill to its roles:

| Role | Skills |
|---|---|
| Designer | emil-design-eng, apple-design, animation-vocabulary |
| Frontend | pick-ui-library, mobile-native, animation-performance |
| QA | break-ui, review-animations |
| Reviewer | improve-animations, remove-animations |

The same mapping lives in code as `EMIL_SKILLS_ROLE_MAPPING`
(`apps/api/convex/lib/githubSkills.ts`) and is exercised by
`skillsImport.test.ts` against a test database only. Nothing seeds it into a
real deployment.

Sizes at commit `715c180` (body chars after front matter; cap 11,929):

| Skill | Chars | Over cap |
|---|---:|---|
| emil-design-eng | 27,214 | yes |
| apple-design | 22,412 | yes |
| animation-vocabulary | 12,706 | yes |
| pick-ui-library | 4,424 | |
| mobile-native | 16,005 | yes |
| animation-performance | 13,411 | yes |
| break-ui | 13,762 | yes |
| review-animations | 8,185 | |
| improve-animations | 7,651 | |
| remove-animations | 10,557 | |

Because of the shared 12k budget, at run time with this mapping: Designer gets
emil-design-eng only; Frontend gets pick-ui-library plus a cut mobile-native;
QA gets break-ui plus a stub of review-animations; Reviewer gets
improve-animations plus a cut remove-animations.

## Skill v2 (versions, dependencies, permissions, on-demand loading)

- **Versions.** Every create, edit, import update and rollback saves a row in
  `skillVersions` (content, source sha, author, kind, note). /library → ⋯ →
  History lists them, diffs any two (or one against current) and restores one.
  A restore is a NEW version (`kind: "rollback"`, audited as `skill.rollback`);
  history is never rewritten. Agents follow the latest version unless pinned
  (Edit agent → Skills → version menu; `skills.setPin`, audited).
- **Migration.** Skills written before v2 have no history. Their current text
  becomes version 1 (`kind: "baseline"`) on their first edit or import, or all at
  once with `npx convex run skills:backfillVersions` (idempotent). Imports are now
  stored untrimmed (up to `SKILL_STORED_MAX`, 200k chars); skills that were
  trimmed by an earlier import get their full text on the next "Update from
  source" / "Update all from source".
- **Dependencies.** `requires` (skill ids; front matter `requires:` /
  `dependencies:` by name on import). Assigning a skill adds what it requires,
  with a warning; removing a required skill while a dependent stays is allowed
  and warns; cycles are rejected.
- **Permissions.** `permissions` (read_file, write_file, run_command, browser,
  network, github; front matter `allowed-tools:` is mapped). Advisory only:
  assigning to a role that lacks one (e.g. run_command on the read-only Reviewer)
  warns. Nothing grants a tool because of a skill.
- **On-demand loading.** Per agent `skillLoading: "inline" | "on_demand"`
  (default inline = the 12k budget as before). On demand, the prompt carries only
  each skill's name, description and size; the agent reads the full text with the
  read-only `load_skill(name)` tool — at most 30k chars per call and 4 loads per
  run. Task runs: a short load_skill loop before each subtask
  (`packages/worker/src/execution/skillLoading.ts`), the loaded text appended to
  the system prompt. Chat: a local tool in the chat repo-tool loop (no worker
  needed), with its own budget outside the 12-call repo budget.
- **Sources.** /library → Sources groups skills by imported repo with version,
  size, dependencies, permissions and users, and "Update all from source".
