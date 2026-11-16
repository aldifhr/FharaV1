# Plan 056: Port FharaV2 file/index and git tooling (A)

> Instructions for the implementer: run each step in order, run the check,
> confirm the expected result. On a STOP condition, stop and report. Do not
> guess. When done, set this plan's state in `plans/README.md`.

## Status

- Priority: P1
- Size: M
- Risk: MEDIUM
- Dependencies: none
- Planned at: after plan 055, `2026-11-16`

## Why this is needed

The worker's read tools are hand-rolled: `globToRegExp` parses globs into
RegExp (`packages/worker/src/tools/repoRead.ts:72`), `walkFiles` re-implements
a directory walk (`repoRead.ts:109`), and grep reads files one by one
(`repoRead.ts:195`). Git helpers parse porcelain/numstat text with regexes
(`gitDiff.ts:131`, `gitWorktree.ts:92`). FharaV2/T3Code does not do this: it
uses `@ff-labs/fff-node` (`FileFinder.glob` / `.grep`, native, gitignore-aware)
for workspace listing/search and a real diff library for patches
(`apps/server/src/workspace/WorkspaceSearchIndex.ts`). The developer asked to
take that tooling from FharaV2, file/git first, provider-native runtime after.

## Decisions that must not change

- Non-negotiable #4 stays: every requested path still goes through
  `guardRepoPath` → `validateFilePath` → `resolveSandboxPathAsync`. The index
  is an acceleration layer, never an authorization bypass.
- `.env*`, `node_modules`, `.git`, key material, and symlinks stay invisible
  to list/grep. The index is post-filtered through the existing rules even
  though fff already ignores gitignored paths, `.env`, `.git`, `node_modules`
  and symlinks (verified on this machine).
- Read-only: no write tool is added here.
- If the native library is unavailable, `list_files`/`grep` fail with a clear
  message; `read_file` keeps working. Never fall back to an ungoverned scan.

## Steps

### Step 1: Add the index dependency

Add `@ff-labs/fff-node@0.11.0` to `packages/worker` and a
`tools/workspaceIndex.ts` wrapper: one `FileFinder` per workspace root,
created lazily, `waitForIndexReady`, `disposeWorkspaceIndex*` for tests and
shutdown, bounded number of live indexes.

**Check**: `npm run --workspace=@fhara/worker typecheck` → exit 0; a smoke
script `fileSearch`/`glob` returns files for a temp repo.

### Step 2: Rewrite list_files and grep on the index

`list_files` uses `finder.glob` (with the requested subpath folded into the
pattern) instead of `walkFiles`; `grep` uses `finder.grep` in regex/plain mode
with the existing caps (`REPO_TOOL_CAPS`) and the same `path:line:` output.
Delete `globToRegExp` and the manual walk. Keep `guardRepoPath`,
`validateFilePath`, `SECRET_NAME`, `SKIP_DIRS`, binary/size caps, secret
masking, and the explicit "0 matches" message.

**Check**: `npx --workspace=@fhara/worker vitest run tests/repoRead.test.ts`
→ all sandbox/secret/cap assertions pass (messages updated only where the
count source changed).

### Step 3: Replace hand-rolled git parsing

Use `diff` (same package T3Code pins) for `makeUnifiedDiff`, and
`git status --porcelain=v1 -z` NUL-delimited parsing for `snapshotDirtyFiles`
and the numstat walk. No regex over command output.

**Check**: `tests/gitDiffBaseline.test.ts` and `tests/gitWorktree.test.ts`
pass; a diff of a new file, an edit, and a deletion keeps real hunks.

### Step 4: Dispose and document

Dispose indexes on worker shutdown and in test teardown; document the new
dependency and the fallback behaviour in `packages/worker/AGENTS.md`.

**Check**: `npm run --workspace=@fhara/worker typecheck`, the worker suite,
`npm run knip`.

## Test plan

- Existing `repoRead.test.ts` invariants: no escape (lexical/symlink), no
  secret/ignored file listed or searched, caps, aliases, 0-match wording.
- New: index returns a file written after the first scan (watch or rescan).
- New: index-unavailable path returns `ok:false`, never a scan.
- Git: NUL parsing handles spaces in paths and a rename line.

## Completion criteria

- [x] No hand-written glob parser or regex directory walk remains.
- [x] `.env*` / `node_modules` / `.git` / keys / symlinks stay unlisted and
      unsearched (verified against a temp repo).
- [x] Worker typecheck, `repoRead`, git tests and `knip` pass.
- [x] `packages/worker/AGENTS.md` documents the index and its fallback.

## STOP conditions

- The native library cannot be installed on the CI platform or on Windows.
- Excluding secrets would require weakening `guardRepoPath`.
- A check fails twice after a reasonable fix.

## Follow-up (B)

Provider-native runtime parity with FharaV2 is a separate plan: port the
provider drivers so agents use their provider's native tools instead of the
API tool loop. It changes approval/budget rules and needs its own decision
record.
