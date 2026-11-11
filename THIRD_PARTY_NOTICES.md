# Third-party notices

Fhara includes portions adapted from the following projects.

## t3code

- Source: https://github.com/pingdotgg/t3code
- Used in: `apps/api/convex/lib/eventResume.ts` (`decideResume` / `replayEncodedBytes`, adapted from
  `apps/server/src/orchestration-v2/ThreadStream.ts` `decideThreadResume` / `threadReplayEncodedBytes`).
  Other t3code-inspired changes (sequenced events, idempotent sends, durable chat replies) take the ideas only.

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## GOAT

- Source: https://github.com/goat-si/goat (commit 718f5b11)
- Used in: `packages/worker/src/prompts/completionContract.ts` (adapted from
  `packages/provider-core/src/server/developmentInstructions.ts`) and
  `skills/builtin/fhara-discipline/SKILL.md` (adapted from
  `packages/provider-core/src/server/builtinSkills/goatDiscipline.ts`); `scripts/guards/rules.mjs` and
  `scripts/code-budget.mjs` (line budget, suppression-reason and baseline-ratchet logic adapted from
  `oxlint-plugin-goat/codeBudget.ts`, `rules/code-budget.ts`, `rules/require-suppression-reason.ts`,
  `update-code-budgets.ts`); `apps/api/convex/lib/automationHold.ts` (global automation hold, adapted
  from `apps/server/src/automationHold.ts`); `apps/api/convex/lib/restartContinuation.ts` (restart
  continuation: `CONTINUE_PROMPT` text and the 3-in-5-minutes loop window, adapted from
  `apps/server/src/orchestration-v2/RestartContinuation.ts`; the subtask and direct-thread wiring is a
  pattern only); `packages/worker/src/vendor/goat/diffs.ts` (copy of
  `apps/server/src/checkpointing/Diffs.ts`, numstat parser) with `packages/worker/src/tools/gitCheckpoint.ts`
  and `apps/api/convex/lib/checkpointRefs.ts` (hidden-ref checkpoint capture: temp index, write-tree,
  commit-tree, update-ref; a pattern from `apps/server/src/vcs/GitVcsDriver.ts`);
  `apps/api/convex/lib/checkpointRestore.ts` (checkpoint restore with multi-pass clean and the
  worktree snapshot before cleanup; a pattern from `GitVcsDriver.ts` `restoreCheckpoint` and
  `apps/server/src/worktreeSnapshots/captureSnapshot.ts`); `apps/api/convex/lib/schedule.ts` (port of
  `apps/server/src/scheduledTasks/Schedule.ts`: next-run, missed fixed-time run, schedule equality;
  epoch milliseconds and IANA time zones instead of Effect DateTime). Modified by Fhara.
  GOAT's Pen, office, PDF, native and asset sub-paths carry other licences; nothing is taken from them.

```
MIT License

Copyright (c) 2026 T3 Tools Inc.
Copyright (c) 2026 goat-si contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 9router

- Source: https://github.com/decolua/9router (commit `1339107`)
- Used in: `apps/api/convex/lib/llmRotation.ts`: `StickyRotationCursor` / `rotateFrom` (adapted from
  `open-sse/services/combo.js` `getRotatedModels` / `normalizeStickyLimit` / `rotateModelsFromIndex`),
  `isEmptyCompletion` (from `isZeroContentResponse`, same file), and `cooldownForFailure` /
  `rateLimitCooldownMs` (from `open-sse/services/accountFallback.js` `checkFallbackError` /
  `getQuotaCooldown` and the rules in `open-sse/config/errorConfig.js`). Rewritten in TypeScript and reduced.
  The Settings → LLM & Models provider presets and the validate-on-save / Test flow take the ideas only.

```
MIT License

Copyright (c) 2024-2026 decolua and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## threadbear

- Source: https://github.com/mikecann/threadbear (commit 43fa1976)
- Used in:
  - `packages/worker/src/vendor/threadbear/safeGit.ts`: copy of `runner/src/safe-git.ts` (child env default changed to
    `buildChildEnv()`; see the file header). Used by `packages/worker/src/tools/gitPush.ts`.
  - `apps/api/convex/lib/prChecks.ts`: the check rollup follows `ciVerdict` / `githubRuns` in `runner/src/upstream.ts`
    (idea and pass/fail rules only, no code copied).
  - Direct threads (plan T2; each file carries a header naming its source):
    - `runner/src/diff.ts` → `packages/worker/src/vendor/threadbear/diff.ts` (copied; `Hunk` inlined)
    - `runner/src/adapters/acp/connection.ts` → `packages/worker/src/vendor/threadbear/acp/connection.ts`
      (copied; Fhara logger, spawn and line reader)
    - `runner/src/adapters/acp/normalize.ts` + `runner/src/adapters/context.ts` →
      `packages/worker/src/vendor/threadbear/acp/normalize.ts` (copied; local event types, no images)
    - `runner/src/adapters/acp/agents.ts` (`opencodeEnv`, the OpenCode row) →
      `packages/worker/src/vendor/threadbear/acp/agents.ts` (OpenCode only; Fhara's provider config and rules)
    - `runner/src/adapters/acp/adapter.ts` → `packages/worker/src/direct/acpSession.ts` (copied and trimmed)
    - `runner/src/adapters/tool-gate.ts` + the request shaping of `adapter.ts` `permission()` →
      `packages/worker/src/direct/toolGate.ts`
    - `runner/src/handoff-history.ts` → `packages/worker/src/direct/handoff.ts`
    - `runner/src/code-writes.ts` → `packages/worker/src/direct/codeWrites.ts` (Fhara's file list)
    - `runner/src/runner.ts` turn, steer, interrupt and recovery logic → ported (not copied) in
      `packages/worker/src/direct/threadRunner.ts` and `apps/api/convex/lib/directThreads.ts`
      (`recoverDirectThread`)
  - Mock fixtures (docs/mock-fixtures.md; commit b697f32; each file carries a header naming its source):
    - `app/Tools/mock-runner/make-synthetic.mjs` → `scripts/fixtures/make-synthetic.mjs` (adapted: the
      commit-safe generator, one folder per scenario with `events.ndjson`, the sequenced `push` helper;
      Fhara's records, scenarios and fixed clock)
    - `app/Tools/mock-runner/server.mjs` → `scripts/mock-llm/server.ts` (adapted: fake turns, the 30 Hz
      replay with 2-12 character deltas, the random 0600 token file, refusing real data; Fhara speaks the
      OpenAI chat completions protocol with scripted rules instead of threadbear's runner protocol)

```
MIT License

Copyright (c) 2026 Mike Cann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## opencode

- Source: https://github.com/sst/opencode (tag `v1.0.0`, `packages/opencode/src/...`)
- Used in:
  - `packages/worker/src/utils/editReplacers.ts`: the `Replacer` generators, `trimDiff` and `replace` from
    `tool/edit.ts` lines 142-640, copied verbatim (extracted from the edit tool).
  - `packages/worker/src/tools/toolLoop.ts` (`pruneToolOutputs`, `estimateTokens`, `PRUNE_PROTECT_TOKENS`,
    `PRUNE_MINIMUM_TOKENS`): ported from `session/compaction.ts` `prune()` (lines 43-88) to the loop's tool-result
    messages.
  - `packages/worker/src/context/compaction.ts` (`isOverflow`): ported from `session/compaction.ts` `isOverflow`.
- opencode credits these replacer approaches to Cline and gemini-cli (both Apache-2.0); see the two entries below.

```
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Aider

- Source: https://github.com/Aider-AI/aider (commit `5dc9490`)
- Used in:
  - `packages/worker/src/utils/editBlocks.ts`: SEARCH/REPLACE block parser and helpers ported from
    `aider/coders/editblock_coder.py` (`find_original_update_blocks`, `find_filename`, `strip_filename`,
    `strip_quoted_wrapping`, `try_dotdotdots`, `replace_part_with_missing_leading_whitespace`, `find_similar_lines`,
    and the "failed to match / did you mean" report of `apply_edits`). Modified by Fhara: ported to TypeScript.
  - `packages/worker/src/prompts/codeChange.ts` (`EDIT_BLOCK_FORMAT_LINES`): Format C rules and example adapted
    from `aider/coders/editblock_prompts.py`. Modified by Fhara: shortened and reworded.
  - `packages/worker/src/prompts/commit.ts` (`COMMIT_SYSTEM_PROMPT`): copied from `aider/prompts.py`
    `commit_system`; the user message follows `aider/repo.py` `get_commit_message`. Modified by Fhara: the language
    placeholder removed, diff truncated. Aider notes that its Conventional Commits wording is adapted from
    https://www.conventionalcommits.org/en/v1.0.0/#summary (Creative Commons CC BY 3.0); that credit is kept.
  - `packages/worker/src/execution/editGuards.ts`: pre-approval syntax gate, ported from `aider/linter.py`
    (`basic_lint`, `tree_context`) and `aider/coders/base_coder.py` (`lint_edited` and the reflection of lint errors
    back to the model). Modified by Fhara: rewritten in TypeScript; the TypeScript compiler's parser replaces
    tree-sitter; only errors new against the pre-edit content count.
  - `packages/worker/src/execution/repoMap.ts`: ranked repository map, ported from `aider/repomap.py` lines 279-525
    (`get_tags_raw`, `get_ranked_tags`: definition/reference graph, personalisation by mentioned files and
    identifiers, identifier weights, rank distribution over definitions) and the budgeted rendering of
    `get_ranked_tags_map` / `to_tree`. Modified by Fhara: rewritten in TypeScript; tags come from the TypeScript
    compiler's parser instead of tree-sitter queries (TS/JS only); self-references and unreferenced definitions are
    kept out of the PageRank graph; package imports, locals and builtin names are not references; relative-import
    edges are added; files are ordered by PageRank with their best definitions; the budget is in characters.
  - `packages/worker/src/utils/pagerank.ts`: a dependency-free stand-in for the `networkx.pagerank` call in
    `get_ranked_tags` (same personalisation and dangling-node semantics); written from scratch, no networkx code.
- Aider ships no NOTICE file. Each changed file carries a "Modified by Fhara" line (Apache-2.0 §4b).

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

## Cline

- Source: https://github.com/cline/cline (`evals/diff-edits/diff-apply/diff-06-23-25.ts`, `diff-06-26-25.ts`)
- Used in: `packages/worker/src/utils/editReplacers.ts`, indirectly: opencode's replacers credit these files
  for their approach. Copyright 2025 Cline Bot Inc. Licensed under the Apache License, Version 2.0 (full text in
  the Aider entry above). Cline ships no NOTICE file.

## gemini-cli

- Source: https://github.com/google-gemini/gemini-cli (`packages/core/src/utils/editCorrector.ts`)
- Used in: `packages/worker/src/utils/editReplacers.ts`, indirectly: opencode's replacers credit this file for
  their escape-normalizing approach. Copyright Google LLC. Licensed under the Apache License, Version 2.0 (full
  text in the Aider entry above).

## OpenHands software-agent-sdk

- Source: https://github.com/OpenHands/software-agent-sdk (shallow clone of 2026-11-11)
- Used in: `packages/worker/src/utils/stuckDetector.ts`: the stuck detector from
  `clients/typescript/src/conversation/stuck-detector.ts` (action-observation loop, action-error loop, monologue,
  alternating pattern; thresholds 4/4/4/6), with the SDK event types replaced by a local event union.
- `packages/worker/src/context/compaction.ts` keeps the first messages verbatim like the SDK's
  `LLMSummarizingCondenser` `keep_first` (idea only, no code).

```
The MIT License (MIT)

Copyright © 2025 OpenHands

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## jockey

- Source: https://github.com/recailai/jockey (commit c744935)
- Used in: `packages/worker/src/execution/opencodeHome.ts` and `boundKeyProblem` in
  `packages/worker/src/execution/agentExecutor.ts`: the rule from `src-tauri/src/credentials/mod.rs` that a
  credential profile a run is bound to whose secret cannot be read is an error, never a silent fallback to
  another account. Ported from Rust to TypeScript; modified by Fhara to apply to OpenCode's auth store and
  Fhara's provider connections.
- Also: `apps/web/scripts/tailnet.mjs` (Tailscale address detection, following
  `src-tauri/src/web_gateway/mod.rs:169-227` `detect_network_ips`). Changed by Fhara: Node interfaces instead of
  ifconfig, exact 100.64.0.0/10 check, no URL token.

```
MIT License

Copyright (c) 2026 JockeyUI Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Awesome Agent Skills (skill catalog metadata)

- Source: https://github.com/khasky/awesome-agent-skills (commit `58ea4e8`)
- Used in: `apps/api/convex/lib/skillCatalog.json`, generated by `scripts/build-skill-catalog.ts` from the
  repository's README skill tables and each `SKILL.md` front matter (skill name, one-line description,
  category, path, license, author). Library → Browse → Refresh catalog stores a newer copy of the same
  metadata in the `skillCatalogs` table. Skill bodies are not bundled; installing one imports it from
  GitHub with its own license recorded on the skill.
- Also used in: `skills/builtin/accessibility-audit/SKILL.md` (Fhara built-in skill), condensed from
  `skills/awesome-accessibility-audit/SKILL.md` to fit the inline skill prompt budget; the file header names the
  source. Bundled through the generated `apps/api/convex/lib/builtinSkills.data.ts`.

```
MIT License

Copyright (c) 2026 Khasky

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Anthropic skills (frontend-design)

- Source: https://github.com/anthropics/skills (commit `2c5958e`), `skills/frontend-design`, Apache License 2.0
  (Copyright Anthropic, PBC).
- Used in: `skills/builtin/frontend-design/SKILL.md` (Fhara built-in skill). Modified by Fhara: condensed to fit
  the inline skill prompt budget, reordered, and extended with a rule to design within an existing app's design
  system. The folder keeps the upstream `LICENSE.txt` and a `NOTICE` describing the changes. Bundled through the
  generated `apps/api/convex/lib/builtinSkills.data.ts`.
- Not used: theme-factory, canvas-design, brand-guidelines, web-artifacts-builder and webapp-testing (each is
  Apache-2.0 too; their content did not fit the Designer's prompt budget or duplicated Fhara's own QA browser).

## UI/UX Pro Max

- Source: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill (commit `6ae86f6`)
- Used in:
  - `skills/builtin/ui-ux-rules/SKILL.md`: the priority rule table of `.claude/skills/ui-ux-pro-max/SKILL.md`,
    condensed (modified by Fhara).
  - `packages/worker/src/vendor/ui-ux-pro-max/data.json`: a trimmed copy of `src/ui-ux-pro-max/data/` (styles,
    colors, typography, ux-guidelines, products; selected columns only), generated by
    `scripts/build-uiux-data.mjs`. The licence is copied beside it.
  - `packages/worker/src/design/designLookup.ts`: the Designer's read-only `design_lookup` tool; BM25 ranking
    ported from `scripts/core.py` (`BM25`) to TypeScript.

```
MIT License

Copyright (c) 2024 Next Level Builder

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Vercel agent-skills (web-design-guidelines)

- Source: https://github.com/vercel-labs/agent-skills (commit `1a2c79d`), MIT per the repository README
  (author Vercel). The repository ships no separate licence file.
- Used in: `skills/builtin/web-interface-guidelines/SKILL.md` (Fhara built-in skill), adapted from
  `skills/web-design-guidelines/SKILL.md`. The guideline rules themselves
  (vercel-labs/web-interface-guidelines `command.md`) are not copied: the skill still fetches them at run time,
  and adds a short Fhara-written fallback list for agents without web access.

## oh-my-skills (skill catalog pointer)

- Source: https://github.com/huanngzh/oh-my-skills (commit `dfd87e9`)
- The repository has no license file, so the catalog keeps only facts about it (skill name, repository and
  path) and copies none of its text. The Browse tab shows "license unknown" and a warning before install.

## SWE-agent

- Source: https://github.com/SWE-agent/SWE-agent (commit `3ea751c`)
- Used in: `packages/worker/src/execution/verifyBaseline.ts` (pre-change baseline for verification: the
  pre/post lint comparison of `tools/edit_anthropic/bin/str_replace_editor` `pre_edit_lint` / `post_edit_lint`
  and `format_flake8_output(previous_errors_string=...)`, which keeps only errors that are new). Pattern port,
  rewritten in TypeScript for whole verification commands; no code copied verbatim.
- Also: the `weakened_test` check in `packages/worker/src/execution/scopeGuard.ts` follows the review-on-submit
  rule of `config/default.yaml` ("If you have modified any TEST files, revert them"); idea only.

```
MIT License

Copyright (c) 2024 John Yang, Carlos E. Jimenez, Alexander Wettig, Shunyu Yao, Karthik Narasimhan, Ofir Press

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## vigilante

- Source: https://github.com/aliengiraffe/vigilante (commit `a4f7826`)
- Used in: `apps/api/convex/lib/autoMerge.ts` (`mergeVerdict`: the wait-reason table, ported from
  `internal/app/app.go` `automergeWaitReason`, lines 5211-5249). Changed by Fhara: TypeScript port, typed
  wait/blocked verdicts, errored checks block, no-check PRs wait, head must equal the approved commit.
  Also `apps/api/convex/lib/issueIntake.ts`: the status-label lifecycle on the issue (`internal/app/app.go:78-90`).
  Also `packages/worker/src/utils/accessLog.ts` (O5): `sanitizeAccessLogArgs`, `sanitizeAccessLogText`, the
  sensitive flag/value tests and the failure-kind classification, ported from
  `internal/environment/accesslog.go`. Changed by Fhara: TypeScript; also redacts `x-access-token:` URLs,
  git `http.extraheader` values, sensitive `NAME=` assignments, caller-known secrets and token-shaped strings;
  rows go to the Convex audit table instead of a JSONL file.
  Licensed under the Apache License, Version 2.0 (full text in the Aider entry above). vigilante ships no
  NOTICE file and names no copyright holder in its LICENSE.

## coder (zvenoai)

- Source: https://github.com/zvenoai/coder (commit `1e1cc92`)
- Used in: `apps/api/convex/lib/autoMerge.ts` (`humanGate`: the diff-size and sensitive-path gate, ported from
  `orchestrator/pr_monitor.py` `_check_human_gate`, lines 860-902). Changed by Fhara: TypeScript port, fails
  closed when the file list cannot be read or may be truncated, renamed-from paths are matched too. Also
  `apps/api/convex/lib/issueIntake.ts` (`preflightEvidence`: the "already done?" evidence collection from
  `orchestrator/preflight_checker.py:87-130`; changed: GitHub timeline/comments as sources, evidence only asks the
  user to confirm). Licensed
  under the Apache License, Version 2.0 (full text in the Aider entry above). coder ships no NOTICE file and
  names no copyright holder in its LICENSE.

## Harness

- Source: https://github.com/VocanicZ/Harness (commit `edcf03d`)
- Used in: `apps/api/convex/lib/issueIntake.ts` (`intakeDecision`: only issues written by the authenticated
  user are taken, following `scripts/issuelib.py:492-517`).

```
MIT License

Copyright (c) 2026 VocanicZ

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## cursor-cli-heavy

- Source: https://github.com/karayaman/cursor-cli-heavy (commit `dbfc88f`)
- Used in: `packages/worker/src/prompts/research.ts` (the research focus angles from `ccheavy.py:73-86`
  `get_focus_for_index`, and the tagged report / synthesis contract from `ccheavy.py:324-421`). Changed by
  Fhara: the angles are DAG subtasks with one synthesis node, at most 4 by default.

```
MIT License

Copyright (c) 2025 Alper Karayaman

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## discoclaw

- Source: https://github.com/DiscoClaw/discoclaw (commit `24c8ae6`)
- Used in: `apps/api/convex/lib/approvalFingerprint.ts` (`stableStringify`, the action fingerprint and the
  10-minute confirmation TTL from `src/discord/destructive-confirmation.ts`). Changed by Fhara: Web Crypto, the
  fingerprint covers an approval's shown fields, the TTL runs from when the client showed it.

```
MIT License

Copyright (c) 2025 David Marsh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## opencode-agent-orchestration-kit (OAK)

- Source: https://github.com/jcarlosrodicio/opencode-agent-orchestration-kit (commit f431b3c)
- License: Apache License 2.0 (full text: https://www.apache.org/licenses/LICENSE-2.0). OAK's NOTICE.md
  lists no notices for this file beyond its upstream credits (OpenCode, MIT).
- Used in: `packages/worker/src/execution/opencodePermissions.ts`: the role × operation table shape
  (`POLICY_OPERATIONS`, frozen per-agent decision rows over a shared `common` row) and the default-deny
  `decideToolAccess` from `opencode/scripts/runtime-permission-policy.mjs`. Modified by Fhara: the agents are
  Fhara's nine fixed roles, the values mirror `ROLES[k].permissions`, there is no "ask" (OpenCode runs
  unattended), and `delegate` is a plain decision (no sub-agents). Also the idea (re-written, no code) of
  refusing `--auto` for unattended runs, from `opencode/scripts/run-routing-live-replay.mjs`.
- Also used in (L2): `packages/worker/src/utils/shellExportPolicy.ts`, from `opencode/scripts/shell-export-policy.mjs` (copied: `classifyShellExport`, `splitShellCommands`,
  `tokenizeShellWords`, the secret-name and secret-reader lists). Modified by Fhara: converted to TypeScript and
  helpers exported; `packages/worker/src/utils/shellGuard.ts` (`shellGuardDecision`, re-exported by `execution/commandGate.ts`) builds the environment-dump,
  credential-file and secret-echo rules on top of it.
- Copyright the opencode-agent-orchestration-kit authors. Its NOTICE (`NOTICE.md`) reads, in the part that applies:

```
opencode-agent-orchestration-kit provides configuration, prompts, wrappers, documentation, and optional Docker
helpers for OpenCode-oriented agent orchestration.

This repository does not claim affiliation with the upstream projects listed below.
```

## llm-wiki-cli

- Source: https://github.com/JanYork/llm-wiki-cli (commit `e1be6ab`, `src/secret_scan.rs`)
- Used in: `packages/worker/src/utils/secretScan.ts`: `detectPossibleSecretReasons` / `containsToken`, rewritten in
  TypeScript from `detect_possible_secret_reasons` / `contains_token` (same file-name, PEM-marker and token-prefix
  rules). Modified by Fhara: TypeScript rewrite; staged-change and outgoing-diff wrappers that scan only added text.
- Copyright the llm-wiki-cli authors. Licensed under the Apache License, Version 2.0 (full text in the Aider entry
  above). The upstream repository ships no NOTICE file for this code.

## openbot (patterns only)

- Source: openbot `src/backend/mcp-redaction.ts`, `src/backend/stderr-diagnostics.ts`
- Used in: `packages/worker/src/utils/redact.ts`, `utils/redactStream.ts`: the ideas only (mask configured secret
  values before pattern rules; walk objects instead of cutting JSON; hold a record until whole across chunks with a
  64 KiB cap; strip ANSI before redaction). No code copied: openbot is PolyForm Noncommercial.

## embassy

- Source: https://github.com/YuanpingSong/embassy (commit `331d004`, `docs/DELIVERY.md`)
- Used in: `apps/api/convex/sideEffects.ts`, `packages/worker/src/services/sideEffects.ts`,
  `packages/worker/src/services/runner/applyLedger.ts`: the delivery phase model only (queued → armed → accepted →
  terminal, `ambiguous` never replayed, only positive proof of no write returns work to the queue). No code copied.

```
MIT License

Copyright (c) 2026 YuanpingSong

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```


## openagents

- Source: https://github.com/openagents-org/openagents (commit `96d18e8`)
- Used in: `apps/api/convex/lib/brief.ts` and `apps/api/convex/briefs.ts` (task brief, plan L3): the brief fields
  (objective, owner, latest result, open questions, next step), the caps (4000 characters, 20 questions of 500
  characters) and the partial-upsert rule (an absent key is untouched, an explicit null clears it), adapted from
  `workspace/backend/app/routers/briefs.py`. Ported from Python to TypeScript; changes are marked in the file
  headers. Copyright OpenAgents contributors. Licensed under the Apache License, Version 2.0 (full text in the
  Aider entry above). openagents ships no NOTICE file.

## agent-os

- Source: https://github.com/earthwalker17/agent-os (commit `59833d3`)
- Used in:
  - `apps/api/convex/lib/memoryRecall.ts` (memory recall, plan L4): the query tokenizer, stopword list, keyword
    score and snippet window, adapted from `backend/execution/local_rag.py` (`_tokens`, `_STOPWORDS`, `_score`,
    `_snippet`).
  - `packages/worker/src/services/runner/memoryReconcile.ts` and `packages/worker/src/prompts/memoryReconcile.ts`
    (memory suggestions, plan L5): the skip rules, compact inputs, outcome tags, JSON decision parsing and the
    reviewer prompt, adapted from `backend/execution/memory_reconciliation.py` (`_is_read_only_run`,
    `_is_failed_noisy_run`, `_parse_decision`, `_RECONCILIATION_SYSTEM_PROMPT`, `_build_user_prompt`).
  Ported from Python to TypeScript; changes are marked in the file headers. Copyright
  agent-os contributors. Licensed under the Apache License, Version 2.0 (full text in the Aider entry above).
  agent-os ships no NOTICE file.

## Paradev (superset-sh/superset)

- Source: https://github.com/superset-sh/superset
- Used in: `apps/api/convex/lib/slashCommands.ts` and `slashCommands.test.ts` (the slash-command wire type,
  `findSlashCommandByNameOrAlias`, `getCommandMatchRank`, `shouldSuppressSlashMenuForCommittedCommand`,
  `sortSlashCommandMatches` and their tests, copied from `packages/shared/src/slash-commands.ts` and
  `slash-commands.test.ts`). Changed by Fhara: no `trigger` field, builtins sort first, plus the Fhara
  builtin list, scopes and `parseSlash`; changes are marked in the file headers.
- Also used in (Paradev A1, cloned from github.com/superset-sh/superset @ ce98da26, now github.com/paradevai/paradev):
  - `apps/api/convex/lib/changeset.ts` (`getChangesFlowState`, `selectActionButton`, `selectPrLink`,
    `selectStatusLabel`), adapted from
    `apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/utils/getPRFlowState/getPRFlowState.ts`
    (`getPRFlowState` and its selectors); `ChangesetFile` follows the pattern of `.../hooks/useChangeset/types.ts`.
    `apps/api/convex/lib/changeset.test.ts` ports the cases of `getPRFlowState.test.ts`. Changed by Fhara: states
    renamed for Fhara task facts (no-branch, worktree-gone, proposed, committed, pushed, pr-exists, fix-running,
    error), plus the git `-z` parsers.
  - `apps/api/convex/lib/diffPatch.ts` (`CONFIG_ARGS`, `BASE_ARGS`, `MAX_PATCH_BYTES`, `PatchBudget`,
    `keepCompleteSections`), copied from `packages/host-service/src/trpc/router/git/utils/diff-patch.ts` and used by
    `apps/api/convex/worktreeNode.ts` (`getDiff`). Changed by Fhara: no spawn, git runs through Fhara's `gitExec`
    with a maxBuffer, and a truncated patch ends with a marker line.
  - `apps/api/convex/lib/prFeedback.ts` (`formatLineComment`, Paradev A3), copied from
    `apps/desktop/src/renderer/hooks/host-service/useSendToTerminalAgent/useSendToTerminalAgent.ts`
    (`formatAgentPromptWithFileContext`). Changed by Fhara: takes one flat comment object and trims the body;
    used by `buildReviewRoundPrompt` for review rounds (`apps/api/convex/diffComments.ts`).
- Other Paradev-inspired changes take the ideas only.

```
MIT License

Copyright (c) 2025-2026 Superset Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Nuphos

- Source: https://github.com/nuphos/nuphos (commit `a210a05`)
- Used in:
  - `packages/worker/src/vendor/nuphos/processDeath.ts`: copy of `apps/runtime/image/process-death.mjs` (cause of an
    agent's death in words; a SIGKILL while the cgroup's `oom_kill` count rose names the memory limit). Modified by
    Fhara: TypeScript, identifiers renamed, cgroup root and reader as parameters, reason built from the exit
    code/signal, described in the worker instead of announced on stderr.
  - `packages/worker/src/vendor/nuphos/turnTimers.ts`: copy of `apps/backend/src/lib/claude-code-preview/openab-acp-timers.ts`
    (`TURN_PROGRESS_UPDATES`, `isTurnProgressUpdate`; `createCallTimer`'s two windows, inactivity and progress, as one
    timer). Modified by Fhara: a per-turn `TurnWatchdog` class with an approval-wait pause and cap and a callback naming
    the window that ran out, instead of a per-call timer and OpenAbTimeoutError; `refreshSessionTimers` dropped. Used
    by the direct-thread turn watchdog (`packages/worker/src/direct/threadRunner.ts`).
  - `packages/worker/src/direct/streamRedactor.ts`: the idea of holding back a possible secret across stream chunks
    from `apps/backend/src/lib/claude-code-preview/streamed-token-redaction.ts` (pattern only, no code copied; the
    redaction is Fhara's L2).
  - `scripts/check-import-cycles.mjs`: adapted from `scripts/check-import-cycles.mjs` (import-cycle ratchet with a
    baseline). Modified by Fhara: the graph is built with the TypeScript compiler API instead of madge, Fhara's
    targets; the canonical-rotation, baseline-compare and target-partition helpers are kept as in the original.
  - `scripts/guards/rules.mjs` (`unawaitedAsyncAssertions`): port of `eslint-rules/no-unawaited-async-assertion.js`
    to a TypeScript-AST scan. Modified by Fhara.
  - `packages/worker/src/direct/agentPids.ts`: adapted from `scripts/dev-shutdown.ts` (`stopTree`/`waitGroupGone`:
    SIGTERM a process group, wait for every member, SIGKILL the rest) and `scripts/dev-instance.ts`
    (`reapLeftovers`: reap a dead launcher's groups only once verified as its own). Modified by Fhara: a per-worker
    registry of ACP agent process groups, a boot sweep for dead workers' groups, start-time and command-line checks
    before any signal, and group membership read from /proc.
  - `packages/worker/src/direct/restore.ts`: the idea of per-attempt session restore diagnostics (op, pid, timed
    phases, outcome, no content) from the runtime README's "Session restoration diagnostics" (pattern only, no code
    copied; Fhara stores each attempt as a `session.restore` task event).
  - `apps/api/convex/lib/untrustedContent.ts`: copy of `apps/backend/src/lib/agent/untrusted-content.ts`
    (`fenceUntrusted`: every `<` escaped so nothing inside can close the block). Modified by Fhara: always an
    `<untrusted source="…">` block, Fhara's notes (evidence and request variants). Used for GitHub issue bodies
    (`lib/issueIntake.ts`), PR reviews, CI logs and review-round comments (`lib/prFeedback.ts`) and the direct-thread
    handoff history (`packages/worker/src/direct/handoff.ts`).
  - `packages/worker/src/direct/runaway.ts`: adapted from `apps/backend/src/lib/agent/stop-gate-runaway.ts`
    (`RUNAWAY_FAILURE_THRESHOLD`, `canonicalToolInputKey`). Modified by Fhara: a streaming detector fed by direct-thread
    tool events and api-loop model calls instead of a scan over step messages.
  - `packages/worker/src/direct/acpSession.ts` (effort): the effort-option matching rule (category `thought_level`,
    or id `effort`/`reasoning_effort`/`thinking`) and "persisted per thread, re-applied on resume" from
    `apps/backend/src/lib/claude-code-preview/session-config-options.ts` and `docs/effort-picker.md` (pattern only,
    no code copied).
- Copyright 2026 Zeabur Inc. Licensed under the Apache License, Version 2.0 (full text in the Aider entry above).
  "Nuphos" and its logo are trademarks of Zeabur Inc.; Fhara uses the name only to describe where this code came from.
  The upstream NOTICE file reads:

```
Nuphos
Copyright 2026 Zeabur Inc.

This product includes software developed at Zeabur Inc.

"Nuphos" and the Nuphos logo are trademarks of Zeabur Inc. The Apache License,
Version 2.0 does not grant permission to use them beyond describing the origin
of this work; TRADEMARK.md spells out what that does and does not cover.

apps/runtime/openab is vendored from openabdev/openab (via the zeabur/openab
fork) and remains under the MIT License, Copyright (c) 2026 openabdev. See
apps/runtime/openab/LICENSE.
```

## openab

- Source: https://github.com/openabdev/openab, as vendored in Nuphos at `apps/runtime/openab` (commit `a210a05`)
- Used in:
  - `packages/worker/src/vendor/nuphos/stderrTail.ts`: the `ERROR_LIKE`, `CREDENTIAL_LIKE` and `OPAQUE_RUN`
    patterns copied from `crates/openab-core/src/acp/connection.rs` (the errno branch split into its own regex), and
    `redact_stderr_line`, the bounded tail (20 lines / 2 KB / 500 chars a line), `with_recent_stderr` and
    `redact_session_ids` (`src/redact.rs`) ported from Rust to TypeScript.
  - `packages/worker/src/direct/restore.ts` and `packages/worker/src/direct/index.ts` (pattern only, no code copied):
    the transient/permanent split for session loads (`pool.rs` `TRANSIENT_LOAD_ERRORS`: keep the id and retry, versus
    a fresh session) and live-session admission (`reserve_admission`, `candidate_in_flight`: at the cap, release the
    oldest idle session, never one with a turn in flight or waiting on a permission).
  - `apps/api/convex/lib/mcpDeclaration.ts` and `packages/worker/src/direct/mcpDeclare.ts` (pattern only, no code
    copied): `pool.rs` `mcp_declaration_changed` (headers never count as a change of the MCP server set) and
    `suspend_for_mcp_change` (release an idle session whose set changed, never one with a turn in flight, and resume
    the same session with the new set).

```
MIT License

Copyright (c) 2026 openabdev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## DeepSeek Harness

- Source: https://github.com/deepseek-ai/deepseek-harness (commit e8f7b93)
- Used in (patterns, unless listed as copied below; each file carries a header naming its source):
  - `scripts/mock-llm/server.ts` wire faults (`fault` on a rule: `partial_disconnect`, `connection_reset`, `stall`,
    `malformed_chunk`, `stream_eof`, `context_overflow`, `server_error`): the behaviour table of
    `packages/test-support/llm-mock-server/README.md`, re-done for Fhara's OpenAI-compatible mock and scripted rules.
  - `packages/worker/tests/helpers/assertUntouched.ts` and `e2e/fixtures-ui/world.mjs`: "Verify the world, not the
    self-report" from `docs/testing.md` (untouched files stay byte-identical after a flow).
  - `apps/api/convex/lib/llmWireErrors.ts` (re-exported by `packages/worker/src/llm/errors.ts`) and
    `packages/worker/src/context/overflowRecovery.ts` (D2): typed wire faults and the context-overflow request-error
    path (prune, re-check, summarize only if still over, retry, `compaction.start`/`compaction.end`) after
    `packages/compaction/compaction-basic` and `docs/subsystems/compaction.md`; pattern only.
  - `packages/worker/src/context/toolOutputSpill.ts` (D3): tool-output spill (head + tail preview, a saved-output notice with a
    task-scoped locator, range reads, surrogate-safe cuts, temp-file + rename writes) after
    `packages/spill/spill-policy` (`retention.ts`, `notice.ts`) and `packages/util/atomic-write`; pattern only, no code
    copied.
- Copied (MIT, header in the file): `packages/worker/src/vendor/deepseek-harness/prunerConfig.ts` from
  `packages/compaction/compaction-tool-result-pruner/src/config.ts` (head 4096 + marker + tail 1024, at most 8192;
  `deepFreeze` and the types inlined).

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
