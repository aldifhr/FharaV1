---
name: improve
description: Audit one area of Fhara, prove each finding with path:line, fix the cheap ones, and write a plan for the expensive ones. Use when asked to improve, audit, review, harden, or "find what is wrong" in a file, a module, or a surface.
---

# Improve

Find real problems in one area, prove them, then split them: fix what is cheap
and safe now; write a plan for what is expensive or touches a non-negotiable
rule. Never produce a list of vague concerns.

## Before you start

- Read the root `AGENTS.md` and the `AGENTS.md` of the surface you audit.
- Fix the scope. One module, one file, or one user flow. If the user gives none,
  ask for one; "the whole repo" produces shallow findings.
- `git status` first. Do not mix your fixes with unrelated uncommitted work.

## Step 1 — Read before judging

- Read the target files end to end. Do not audit from grep hits alone.
- Read its callers and its tests.
- Read the rules that apply: the non-negotiable list, the surface `AGENTS.md`,
  and any plan in `plans/` that owns the area.

## Step 2 — Find findings, ranked by leverage

Look for, in this order:

1. **Rule violations** — a plaintext credential on a public path, a worker
   function without `assertServiceToken`, a tool path that skips
   `resolveSandboxPath`, a bypass of the approval gate or the budget gate, a
   terminal task that can be overwritten.
2. **Correctness** — a race, a lost write, an unbounded query, a missing
   `skip`, a retry that ignores the deadline or the budget.
3. **Data loss** — a destructive migration, a delete with no soft state, a
   workspace escape.
4. **Dead or duplicated code** — an unwired control, an unused module, two
   implementations of one decision.
5. **Cost** — an LLM call that should be deterministic, a full-table scan, a
   second provider call for data already fetched.

For each finding record:

```
<severity> <one-line title> — <path:line>
Failure mode: what goes wrong, and when.
Evidence: the line, the test, or the reproduction.
Fix: the smallest change.
```

A finding without a concrete failure mode is not a finding. Drop it.

## Step 3 — Split fix vs plan

Fix now when the change is small, local, and touches no non-negotiable rule:
dead code, an unwired button, a missing `skip`, a copy error, a wrong index on a
query, a stale doc reference.

Write a plan when the change:

- touches a non-negotiable rule (see the root `AGENTS.md`);
- changes the schema, a migration, or the orchestrator/planner contract;
- spans more than one surface;
- needs a product decision.

Use the template in `plans/README.md`, then add the row to its table. Do not
implement a plan in the same pass unless the user asks.

## Step 4 — Fix, then prove

- Apply the smallest change at the root cause. Prefer delete and reuse over new
  code.
- Add a test only for a protected invariant or a regression that would come back.
- Run the narrowest checks:
  - backend → `npm run --workspace=@fhara/api typecheck` + the relevant test file
  - worker → `npm run --workspace=@fhara/worker typecheck` + the relevant test file
  - web → `npm run --workspace=@fhara/web typecheck`
- Never weaken a test, never widen a type to `any` to pass a check.

## Step 5 — Report

| Finding | Severity | Action | Evidence |
| --- | --- | --- | --- |
| Short title — `path:line` | P1/P2/P3 | fixed (sha) / planned (plan file) / rejected (why) | line or test |

Then list the checks you ran, and the findings you deliberately left open with
the reason.

If you fixed nothing and planned nothing, say so plainly and give the evidence.
An empty audit is a valid result.
