# MOAgent roadmap

Open work only — finished items live in the git history. Grouped by when it
should happen:

- **Now**: correctness or cost problems that show up on the normal path, and
  small, contained fixes.
- **Next**: real gaps users will hit, but each needs a schema change, a new
  UI surface or a careful refactor.
- **Later**: polish, scale and structure work that is worth doing once the
  above is settled.

Each item says where it lives and why it matters.

---

## Now

### Pipeline correctness

- **Planning-interrupted tasks never recover on lease expiry.** A task whose
  worker dies during planning stays stuck or fails when reclaimed; there is
  no re-plan on reclaim (`services/runner/setup.ts`, `orchestration.recoverStale`).
  *Why:* a worker restart (or sandbox reboot) mid-plan loses the task.
- **A failed review replan re-runs completed code nodes.** When review fails
  and the plan is redone, finished nodes run again instead of being carried
  forward (`orchestrator/replan`, `services/runner/decision.ts`). *Why:* each
  re-run is another 2–5 minute model call on slow providers; ULTRA tasks run
  close to the deadline because of it.
- **Truncated model output (longcat).** Answers cut off at ~2 KB or returned
  empty when reasoning tokens eat `ORCHESTRATOR_LLM_MAX_TOKENS` (8192).
  Record `finish_reason` / `stop_reason` on every call (`llm.ts`), surface
  "truncated" in the parse error and the event log, and raise the default
  max tokens for `code_change` calls. *Why:* the repair retry hides the
  cause today and costs a full extra call.
- **Finalize runs static verification a second time.** The verify loop
  (`services/runner/verifyLoop.ts`) already verified the applied changes;
  `services/runner/finalize.ts` runs `runVerification` again on the same
  files. Reuse the loop's result unless files changed since. *Why:* a full
  typecheck + build on every task, twice.
- **`answerQuestion` / `steerTask` can drop the user's text** (core audit
  M9). They report success even when the text never reaches the running
  task. *Why:* silent loss of user input.
- **`ensureFixedTeam(projectId)` re-adds agents the user removed** from a
  project team (core audit M11). Respect an explicit removal (e.g. a
  `removedRoles` list on the project). *Why:* user edits are undone.
- **Scheduler timeout does not wait for the timed-out attempt** before a
  retry starts (`scheduler/dagScheduler.ts`, core audit M13). Await the
  original promise with a grace cap. *Why:* two attempts can stage changes
  to the same files.

### Small UI leftovers

- **M23 — New Project saves in two mutations** (`components/NewProject.tsx`
  → `projects.create` + a second update). Fold into one backend mutation so a
  failure cannot leave a half-created project.
- **M32 — Modal / ConfirmDialog have no focus trap.** Focus moves in and is
  restored, but Tab can leave the dialog. Swap to the base-ui Dialog or add a
  trap. *Why:* keyboard and screen-reader users.

---

## Next

### Orchestration

- **Planner emits a structured QA checklist.** QA cards and the browser run
  should take `paths` / `expectText` / viewport checks from a typed planner
  field instead of free-text heuristics (`orchestrator/planner.ts`,
  `execution/qa.ts`). *Why:* QA today mostly proves "the root page renders".
- **Visual QA baseline from the previous run.** The baseline is the last QA
  screenshot (stored under `<workspace>/.qa/baselines`), so an intended UI
  change fails with zero tolerance. Capture the baseline from HEAD / before
  apply, keep artefacts outside the repo, and report diffs as information
  (QA audit P2-3/P2-4).
- **Theme duplication in generated code.** The ULTRA run produced
  `theme.js` (browser) and `theme.ts` (tests) with the same logic. Teach the
  planner/implementer prompt to keep one source module and import it in
  tests. *Why:* generated projects drift.
- **OpenCode runtime follow-ups** (`execution/nativeProvider.ts`):
  - create-agent flow: pick the runtime when creating an agent, not only when
    editing;
  - session reuse across subtasks of one task (today every node starts a fresh
    OpenCode session);
  - budget gate: an OpenCode run is not checked against the pre-call budget
    gate; its token usage is only recorded after it finishes.

### Cards and GitHub

- **QA screenshots upload.** The QA card only carries URLs the backend can
  serve, and local screenshot paths are never sent, so cards show no
  screenshots. Upload them to Convex storage and attach the URLs.
- **Due date field on task cards** (schema + card + board sort).
- **GitHub webhook signature verification**
  (`apps/api/convex/integrations.ts`, TODO at the webhook handler). Store a
  per-integration secret and check `X-Hub-Signature-256`. *Why:* the endpoint
  accepts any POST today.

### Layout

- **Server-side usage budget.** The weekly usage meter
  (`MOAGENT_WEEKLY_TOKEN_BUDGET`) is display-only; the worker does not stop
  at it. Enforce it where tasks are claimed.
- **Thread composer @ autocomplete.** The chat composer has role-ordered
  @mention autocomplete; the task-thread reply box does not.
- **Attach non-text files** (images, PDFs) in the composer; only text
  attachments (≤ 8000 chars) are supported.

### Data and scale

- **Worker polls Convex every 1.5 s** (`WORKER_POLL_INTERVAL_MS`). Move task
  claiming to a Convex subscription (`ConvexClient.onUpdate`) with the poll as
  a slow fallback. *Why:* latency and idle load.
- **Search index for `search.global`.** It still scans; add Convex search
  indexes on messages/tasks/files (convex-fixes "not done").

---

## Later

### UI polish

- **Restyle Home, Inbox, Ideas and MCP pages** to the new layout (they still
  use `h-screen` and the old card styles).
- **Lint items from the UI audit:**
  - L3 — type ids as `Id<"projects">` etc. across `apps/web` instead of
    `string`;
  - L4 — memoise the rest of ChatPanel; the 5 s typing tick still re-renders
    the whole list;
  - L5 — `pendingReplyForMessageId` on the backend so "thinking" follows the
    exact message;
  - L7 — finish the gray-400 → gray-500 contrast pass outside the touched
    components;
  - L9 — brand colour token (`--brand`) and consistent radius scale.
- **ESLint** for `apps/web` (skipped so far to avoid new dependencies).

### Code structure

- **Split `execution/agentExecutor.ts` further** (~1700 lines: prompt
  building, tool loop, parsing and native runtime in one file).
- **Split `services/runner/decision.ts`** (~650 lines) into decision
  dispatch and per-action handlers.
- **Remaining bespoke test fakes.** Several worker tests (`phase4*`,
  `phase5Runner`, `phase6*`, `qaTaskRunner`, `reviewLoop.integration`,
  `pushRequests`) still build their own API fakes instead of
  `tests/helpers/fakeApi.ts`; new WorkerApi methods break them one by one.

### Product

- **Auth provider and strict ownership.** Ownership is enforced only when a
  project has an owner (`apps/api/convex/lib/authz.ts`); the single-user,
  no-auth local mode is accepted by the owner for now. Revisit before any
  multi-user deployment.
