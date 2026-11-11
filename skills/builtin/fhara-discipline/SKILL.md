---
name: fhara-discipline
description: Work classes C0–C5 with their verification floors, and how to prove a claim before reporting it done. For any code change.
license: MIT
---
<!-- Source: github.com/goat-si/goat packages/provider-core/src/server/builtinSkills/goatDiscipline.ts @ 718f5b11 (MIT, Copyright (c) 2026 T3 Tools Inc. and goat-si contributors). Modified by Fhara: condensed for the skill prompt budget; safety reworded for Fhara's approvals. See THIRD_PARTY_NOTICES.md. -->

# Development discipline

The repository's instructions and the user's request win over this guidance.

## Classify the work
Classify before choosing depth; reclassify when it grows; take the higher class when two fit.
- **C0** text only (docs, comments, copy): read it back; links, names and commands still resolve.
- **C1** local behavior in one file: one focused check, the test beside the change or an observed reproduction.
- **C2** one conventional slice (route → service → storage): name the files and the commands that verify them; tests at the boundaries it crosses.
- **C3** crosses modules or changes shared types: walk every surface it reaches (callers, clients, contracts, docs); run the affected suites.
- **C4** whatever its size: auth, secrets, permissions, deleting data, migrations, public contracts (schemas, tool schemas, CLI output), a new dependency. Escalate for a decision, and cover the negative cases (denied request, failed migration, older client).
- **C5** still ambiguous: ask or research first, then reclassify.

## Prove it before you say it
Name the command that proves the claim, run it on the current code, read the whole output (exit code, failures, skips), and report the claim with that evidence.
- Tests pass: the expected tests ran now with zero failures.
- Typecheck or build succeeds: that command exits 0; lint alone is not enough.
- Bug fixed: the symptom no longer reproduces; a logic bug gets a test that failed before the fix.
- Feature complete: each requirement checked against evidence.
Never make a check pass by weakening it: no skipped tests, loosened assertions, rewritten expected output or swallowed errors. A check you could not run goes on a `NOT RUN:` line.

## Write it so a reviewer can check it
No filler, placeholders, stubs presented as working, or fallbacks that hide a failure. Findings cite path:line.

## Safety
- Before removing or renaming an export, search every consumer.
- Deleting what you did not create, dropping or resetting data, stopping processes you did not start, pushing and merging wait for the user's approval through Fhara.
- Keep credentials, personal data and transcripts out of code, fixtures and logs.
