---
name: review-checklist
description: Bug classes to check in a diff before calling it done or approving it - lifecycle, callbacks, timing, values, untrusted output, failures - plus test rules. For writing, reviewing and testing code.
license: MIT
source: github.com/deepseek-ai/deepseek-harness @ e8f7b93 (MIT, Copyright (c) 2026 DeepSeek) - docs/defensive-patterns/general.md, docs/testing.md, .agents/skills/{dsh-code-review,dsh-error-handling,dsh-ci-test-reliability}/SKILL.md. Modified by Fhara - distilled into a short checklist, examples and product terms removed.
---
<!-- Adapted from MIT-licensed upstream text; attribution in the front matter and THIRD_PARTY_NOTICES.md. Modified by Fhara. -->

# Review checklist

Read the requirement before the diff. One substantiated blocker beats a list of nits; a check a green gate already enforces is not a finding.

## Code
- **Dispose reaches quiescence.** After kill or abort, await the child's exit and pending work; what is needed for the final save lives until consumers settle.
- **Contain callback exceptions.** A dispatcher catches and reports each listener's error; one throw neither rejects the dispatch nor skips later listeners.
- **Timing does not carry correctness.** No `setTimeout(0)`, microtask or effect ordering that decides a result; name the call point or state.
- **One value states one fact.** Not queried, queried and empty, and cannot tell are three representations, never one `null`.
- **Report outcomes independently.** Timed out, signal and exit code each readable on their own.
- **Untrusted output gets no ambient env or predictable paths.** Spawned commands get a scrubbed env (no `*KEY*/*SECRET*/*TOKEN*/*PASSWORD*`); temp files go in a private dir, random name, exclusive 0600 open.
- **Unlink link-shaped paths.** `lstat` then `unlink` a possible symlink; recursive delete only for known real directories.
- **Typed failures.** Expected failures carry a stable code; never route by message text; keep the cause.
- **An empty catch names the error** and why continuing is safe; logging alone is not recovery.
- **Bounds cover the final output**, wrappers included; probe the exact limit and multibyte text.

## Tests
- **Verify the world, not the self-report**: files, rows, events, exit codes; untouched files stay untouched.
- A test that fails on the intended regression; a negative case for each new rule.
- **A spec that passes only alone is a test defect**: own your ports (`listen(0)`), temp dirs and env, and restore them.

Report each finding as defect, `path:line`, impact, evidence; separate blockers from suggestions.
