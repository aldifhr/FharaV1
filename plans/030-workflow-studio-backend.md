# Plan 030: Workflow Studio persistence on the backend

## Status

- Priority: P2
- Size: M
- Risk: MEDIUM (new schema table + public mutations; no existing rows touched)
- Dependencies: 028 (chat activity surface the studio copy lives next to)
- Planned at: commit `96b459e`, 2026-11-10

## Why this is needed

`/workflows` (Workflow Studio) is explicitly **frontend only**: definitions
live in `localStorage` via `@/lib/workflow` and the backend has no workflow
store at all (`apps/web/lib/workflow.ts:2` "frontend only", the studio header
copy, `apps/web/components/workflow/WorkflowStudio.tsx:4-5`). Nothing an agent
or the orchestrator can see today, and workflows cannot survive a reload of
another device or a server restart that clears storage.

## Target behaviour

After the change, a user can:

- List, create, edit, duplicate, delete and reset workflows from the backend
  through the `/workflows` UI.
- Reload and get the same workflow list from Convex instead of localStorage.
- Keep editing locally for snappy canvas drags while a debounced patch hits
  `api.workflows.update`; server actions (create / duplicate / delete /
  reset / import) reconcile through the returned document.

## Current state

- `apps/web/lib/workflow.ts:2-5` — types + pure helpers, persistence via
  `localStorage` (`STORAGE_KEY`, `loadWorkflows`, `saveWorkflows`).
- `apps/web/components/workflow/WorkflowStudio.tsx:103-135` — local state
  seeded from `loadWorkflows()`, `persist` writes localStorage.
- `apps/api/convex/schema.ts` — no `workflows` table; no `convex/workflows.ts`.
- `apps/api/convex/agentTemplates.ts` / `memories.ts` — the CRUD patterns to
  mirror (object-form functions, `assertRegistryWriteAccess` for global writes,
  index-backed queries where filtered).

## Non-negotiable rules touched

- Rule 7 (schema): additive only — new `workflows` table with `v.array` of
  object validators, no legacy columns, no drops. No field removed in the same
  change that stops writing it (nothing to migrate; table starts empty).

## Decisions that must not change during execution

- Workflows are global (no `projectId`): same policy as the agent registry
  (`assertRegistryWriteAccess`, reads open in local single-user mode).
- The workflow node/edge shapes stay string-keyed (frontend ids such as
  `node_abc12345`), not Convex `Id`s — they are a frontend DAG contract and the
  backend `ExecutionPlan` mapping is future work.
- Editing stays local-first with a debounced backend patch; the server remains
  the source for list-level actions (create / duplicate / delete / reset /
  import) and for the initial load.

## Steps

### Step 1: Backend store

1. `apps/api/convex/schema.ts`: export
   `workflowNodeType` / `edgeCondition` unions + `workflowNodeValidator` /
   `workflowEdgeValidator` / `workflowPatchValidator` object validators and the
   `workflows` table (`name`, `createdAt`, `updatedAt`, `nodes`, `edges`).
2. New `apps/api/convex/workflows.ts`: public `list` / `create` / `update` /
   `remove` (object-form, args validators, handler). Writes through
   `assertRegistryWriteAccess`; returns a plain `WorkflowView` shape.

### Step 2: Codegen + backend checks

1. `npm run --workspace=@fhara/api codegen`.
2. `npm run --workspace=@fhara/api typecheck` and
   `npx --workspace=@fhara/api vitest run convex/workflows.test.ts`.

### Step 3: Web integration

1. `apps/web/lib/workflow.ts`: drop `STORAGE_KEY` / `loadWorkflows` /
   `saveWorkflows`; keep types + pure helpers.
2. `apps/web/components/workflow/WorkflowStudio.tsx`: `useQuery(api.workflows.list)`
   + `useMutation(api.workflows.{create,update,remove})`; debounced patch on
   local edits; server-driven create/duplicate/delete/reset/import.

### Step 4: Tests and checks

1. `apps/api/convex/workflows.test.ts`: create ? list ? update ? remove round
   trip, invalid-node refusal via validators.
2. `npm run --workspace=@fhara/web typecheck`, `npm run --workspace=@fhara/web test`.

## Test plan

- Backend: create persists and lists back; update patches nodes/edges/name and
  bumps `updatedAt`; remove deletes; writes refuse when registry write access is
  denied (authz helper) — mirror the existing `memories` validation test.
- Web: workflow helpers stay pure (no `localStorage` access left in the module).