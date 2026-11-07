# Plan 001: Memory store and workspace UI

> Instructions for the implementer: run each step, run the check, confirm the
> expected result. On a STOP condition, stop and report. Do not guess. When done,
> set this plan's state in `plans/README.md`.

## Status

- Priority: P2
- Size: M
- Risk: LOW
- Dependencies: none
- Planned at: `main`, 2026-11-07

## Why this is needed

An agent currently has no durable, searchable memory. Everything it "remembers"
is either the per-task `taskContexts` row or the task event log. When a task ends,
the useful facts die with it. The user cannot write a fact down and have the next
task use it.

## Target behaviour

| Action | Result |
| --- | --- |
| Add a memory ("this repo uses pnpm", "deploy target is Vercel") | Row in `memories`, scoped to a project |
| List memories for a project | Panel in the workspace shell, newest first |
| Search memories | Text search returns matching rows |
| Delete a memory | Row removed, no orphan reference |
| Worker starts a task | Relevant memories are injected into the agent context as text, capped |

## Current state

- `apps/api/convex/schema.ts` has `taskContexts` (line 334) and
  `lifecycleHistory` (370). There is no `memories` table.
- `apps/api/convex/orchestration.ts` exposes `getTaskContext` (1562) and
  `upsertTaskContext` (1574) for per-task context only.
- `apps/web/app/WorkspaceClient.tsx` composes `Sidebar`, the section content, and
  `TaskThreadPanel` (line 102). There is no memory panel, and no
  `memories` reference anywhere under `apps/web`.
- `ROADMAP.MD` line 59 describes this item but points at
  `app/workspace/[projectId]/WorkspaceClient.tsx:279`, a file that has moved to
  `apps/web/app/WorkspaceClient.tsx`. Fix that line while you are here.
- `packages/worker/src/orchestrator/agentContext.ts` builds the per-agent context
  from previous executions. It is the natural injection point.

## Decisions that must not change during execution

- Memories are **per project**, not global. A global memory table would leak one
  project's facts into another.
- Memory is **advisory text**. It must never be parsed as an instruction, a
  command, or a plan. Injection is plain text under a labelled heading.
- Injection is **capped** (default 10 rows, 2000 characters total). An unbounded
  memory dump is a context-window attack.
- No embeddings, no external vector service. Substring/prefix search on the
  content field is enough for this size.
- Do not store provider keys, tokens, or file contents in a memory.

## Steps

### Step 1: Add the table

Add to `apps/api/convex/schema.ts`:

```
memories: defineTable({
  projectId: v.id("projects"),
  kind: v.union(v.literal("fact"), v.literal("preference"), v.literal("note")),
  content: v.string(),
  createdBy: v.optional(v.string()),
  updatedAt: v.number(),
}).index("by_project", ["projectId"]).index("by_project_and_kind", ["projectId", "kind"]),
```

**Check**: `npm run --workspace=@moagent/api codegen` → exit 0, `memories` in the
generated data model.

### Step 2: Add the functions

New module `apps/api/convex/memories.ts`:

- `listByProject` (query, `{ projectId }`) — newest first, `by_project`.
- `search` (query, `{ projectId, text }`) — case-insensitive substring over the
  project's rows; do not add a full-table scan across projects.
- `create` (mutation, `{ projectId, kind, content }`) — reject empty content and
  content over 4000 characters.
- `update` (mutation, `{ memoryId, content }`) — only the content and `updatedAt`.
- `remove` (mutation, `{ memoryId }`).
- `forTaskContext` (internalQuery, `{ projectId, limit }`) — the worker read path,
  capped and ordered by `updatedAt` desc.

**Check**: `npm run --workspace=@moagent/api typecheck` → exit 0.

### Step 3: Expose the worker read path

Add `getMemories` to `apps/api/convex/worker.ts` (action, `workerToken` +
`projectId` + `limit`) wrapped with `withoutToken`, and a matching
`WorkerApi.getMemories` in `packages/worker/src/workerApi.ts`.

**Check**: `npm run --workspace=@moagent/worker typecheck` → exit 0.

### Step 4: Inject into agent context

In `packages/worker/src/services/taskRunner.ts`, after the task context is built,
fetch memories once per task and pass them to
`buildAgentExecutionContext` / `formatAgentContextForPrompt` as a
`## Project memory` block. Apply the cap. A memory fetch failure must not fail the
task — log the event and continue with an empty block.

**Check**: `npx --workspace=@moagent/worker vitest run tests/taskContext.test.ts`
→ the new case passes: given two memories, both appear; given 20, only the cap
appears.

### Step 5: Add the UI

- A `MemoryPanel` component under `apps/web/components/`, rendered in the
  workspace shell next to `TaskThreadPanel` (or as a tab in it).
- Add / edit / delete controls, a search input, and a real empty state.
- Use `components/ui/` primitives. All copy in English.

**Check**: `npm run --workspace=@moagent/web typecheck` and
`npm run --workspace=@moagent/web build` → exit 0.

### Step 6: Update the backlog

Mark the memory item in `ROADMAP.MD` done and correct its stale file path.

## Test plan

- `memories.test.ts` (convex-test): create → list → search → update → remove;
  empty content rejected; content over 4000 rejected; a memory from project A
  never appears for project B.
- `taskContext.test.ts`: cap enforced; empty memory list yields no heading; a
  rejected fetch does not throw.
- No live provider call.

## Completion criteria

- [ ] `memories` exists with `by_project`; no full-table scan in any query.
- [ ] Worker injects at most the configured cap and never fails on a fetch error.
- [ ] UI can add, list, search, and delete.
- [ ] `npm run --workspace=@moagent/api test` and `npm test` pass.
- [ ] `ROADMAP.MD` no longer lists the memory item as open, and its stale path is
      fixed.

## STOP conditions

- A memory must be shared across projects (that is a different feature).
- The change needs embeddings or an external service.
- Injecting the block pushes a real task past the context limit in a way the cap
  cannot fix.
