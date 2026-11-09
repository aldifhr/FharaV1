# Plan 027: Model Capability Registry and performance routing

## Status

- Priority: P2
- Size: L
- Risk: MEDIUM (changes which model a call uses when its needs are not met;
  routing change is opt-in; additive schema only)
- Dependencies: 022 (model tiers), 024 (org intel, load-aware routing),
  025 (gate results, requirement coverage)
- Principle: deterministic first. No new LLM call in routing. The only new
  LLM calls are the two tiny probe calls, run only when the user clicks
  Probe.

## Why this is needed

The resolver picked models by assignment → tier → pool priority/weight
only. A planner whose model cannot produce JSON, an executor whose model
cannot call tools, or a prompt bigger than the model's context window all
failed at call time. Agent routing picked by declared capability and
priority (optionally load); it ignored how well each agent actually did.

## Target behaviour

### 1. Model Capability Registry

| Area | After the change |
| --- | --- |
| Shape | `ModelCapabilities {structuredOutput, toolCalling: native/markup/none, vision, maxContextTokens, supportsStreaming, supportsCancellation, strengths[reasoning/coding/summarization/cheap], costPer1kIn/Out}` (`apps/api/convex/lib/modelCapabilities.ts`, pure, shared by backend, worker and web). |
| Resolution | Per field, first layer that knows it: project override → global override (`modelCapabilityOverrides`, keyed by the model id string) → last probe → `llmModels` row (`contextWindow`, `supportsTools` only when true, prices) → built-in map (glob on the id and on the part after the last `/`) → conservative unknown defaults (no JSON, no tools, no vision, 8192 context, no streaming/cancellation). `supportsTools=false` on the registry row is ignored because the settings form always writes the checkbox. |
| Markup tools | `meituan/longcat*` and the `nous` connection model resolve `toolCalling: "markup"` (handled by `utils/toolCallMarkup.ts`). A tool-calling need is satisfied by native **or** markup. |
| Needs | `CALL_SITE_NEEDS`: planner and decision advisor need structured output plus context for their prompt (chars/4 + 4096 reserve); the executor needs tool calling for implementation/analysis on the API runtime (not review, QA or OpenCode), vision for QA when visual QA is requested, and context for task + subtask text. |
| Resolver | `resolveForAgent` filters every tier by the needs. When some healthy candidate satisfies them, the first satisfying model in tier order is the primary (the agent's assignment/tier still wins when it satisfies; policy `fixed` never leaves its assignment). Skipped models stay at the end of the fallback chain. When nothing satisfies, the pick is exactly the pre-registry pick and the routing record says `fallback: true`; the task logs one `model.capability_fallback` warning per (call role, model, missing) — never a hard failure. `MODEL_CAPABILITY_ROUTING=0` keeps the pool order and only records the needs. |
| Record | `subtask.routed.payload.model = {model, connection, needs, satisfied, fallback, missing, reason}`; the Routing Inspector shows the line as "Model: …". The node reuses the resolution made for the record, so the logged model is the one that runs. |
| Probe | `modelCapabilities.probe` (token-gated action, via `/api/llm-providers` op `probeModel`): one JSON-mode call (`response_format: json_object`; Anthropic: prompt only) and one tool-call test (`tools` with `get_time`). Verdicts: JSON parses to `{"ok":true}`; tool call native / markup text / none (HTTP 400/422 on the tool call = none). Stored on the override row with a timestamp and any errors; a failed call gives no verdict. Never run automatically. |
| UI | LLM settings → "Model capabilities": every registered model with its resolved capabilities and the source of JSON/tools/context, the last probe, Probe, and an override editor (all projects or this project; Inherit per field; Clear override). |

### 2. Performance routing

| Area | After the change |
| --- | --- |
| Score | `lib/agentPerformance.ts`: one sample per agent-assigned subtask; per (agent, capability) over 30 days (7/90 selectable on the profile): success (done ÷ finished, prior 0.8), acceptance (accepted ÷ judged — acceptance status, failed gates, requirements of the subtask left uncovered by the task's coverage check; prior 0.8), retry/fix (attempt > 1 or a later fix subtask depends on it; prior 0.2), regression (a later `fix`/`review_fix` subtask in the same task wrote a file this subtask wrote, from `executions.meta.filePaths`; prior 0.1), efficiency (median duration and tokens per accepted result vs the capability's peers, log-scaled around 0.5). Each rate is smoothed `(hits + prior·4) / (n + 4)`; weights 0.35/0.25/0.15/0.15/0.10. Below 3 finished samples the score **is** the prior score (0.785), so a new agent starts neutral. |
| Cache | Computed on read with caps — no table, no cron. `agentPerformance.scoresForProject` reads ≤ 2000 subtasks in the window and ≤ 150 tasks (executions, token usage ≤ 200 each, plus the task's coverage); the worker fetches once per `runNodes` batch when routing is on and keeps it 10 minutes per run. Caps hit are reported as `truncated`. |
| Setting | `projects.performanceRouting` (optional boolean; unset = env `ORCHESTRATOR_PERFORMANCE_ROUTING`, default off). Toggle on /team (Capacity, next to load-aware routing). |
| Router | `orchestrator/performanceRouting.ts#pickByPerformance`, only when the normal pick is an exact capability match, among agents declaring the capability exactly: availability (below concurrency limit; live load as load-aware reads it; all full → keep the normal pick) → score (gap > 0.02 wins) → model fit (the agent's resolved executor model satisfies the subtask's needs) → budget fit (its tokens per accepted result ≤ the task's remaining token budget) → original order (normal pick first). When on it supersedes load-aware routing (it includes the capacity rule). |
| Record | `subtask.routed.payload.performance = {from, to, fromRole, toRole, changed, reason, scores[]}` with each candidate's score, samples, prior flag, load, model fit and budget fit; recorded even when the pick is kept. Routing Inspector shows the reason and a candidate table. |
| Profile | /team/[agentId] "Routing score": per capability the score, sample count, prior flag and each factor (smoothed rate, raw rate and n), median time, tokens per accepted result. |

## Decisions that must not change during execution

1. Routing never picks an agent that lacks the capability, and never
   changes a fallback (non-exact) pick.
2. Capability needs never hard-fail a working setup: no satisfying model
   means the old pick plus a warning.
3. No automatic probe and no LLM call in routing.
4. Schema changes are additive (`projects.performanceRouting`, table
   `modelCapabilityOverrides`).

## Budget note

There is no project-level token budget in the schema; "remaining budget"
is the task's `BudgetTracker` (max token budget − tokens used).

## Steps

1. Pure registry + needs + probe verdicts; validators; table; overrides
   CRUD and probe action; overrides in `getRunContext`.
2. Resolver needs filtering, routing info, fallback warning sink; call
   sites (planner, decision, executor); `subtask.routed.model`.
3. Pure scoring; worker-facing scores action; `performanceRouting`
   setting + env; router; `subtask.routed.performance`.
4. UI: LLM settings capabilities section, Routing Inspector, profile,
   Capacity toggle.
5. Tests: `packages/worker/tests/modelCapabilities.test.ts`,
   `packages/worker/tests/performanceRouting.test.ts`,
   `apps/api/convex/modelCapabilities.test.ts`,
   `apps/api/convex/agentPerformance.test.ts`.

## Completion criteria

- Registry: resolution order, needs filtering, fallback warning, markup
  tool calling — covered by tests.
- Scoring: smoothing and minimum sample size — covered by tests.
- Router: off leaves picks unchanged; on, a better score wins; capability
  never violated; capacity respected; ties keep order — covered by tests.
- Live: a run with performance routing on shows the decision in the
  Routing Inspector; a probe against the `nous` connection records
  `toolCalling: markup` (pending; not verified live).
