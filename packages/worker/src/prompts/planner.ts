import type { Classification } from "@/types";
import { isReadOnlyTaskKind } from "@/api/convex/lib/planValidation";
import { assemblePrompt } from "@/api/convex/lib/assemblePrompt";
import { routingHintPromptLines, type RoutingHintFacts } from "./routingHint";

/** What the planning prompt is built from (neutral planner, no persona). */
export interface PlanningPromptInput {
  command: string;
  classification: Classification;
  policy: {
    maxReplans: number;
    maxSubtasks: number;
    reviewMode?: string;
    qaMode?: string;
  };
  feedback?: string;
  sharedInstructions?: string;
  workspaceLayout?: string[];
  /** R7: ranked repository map (files most relevant to the request, with key definitions). */
  repoMap?: string;
  /** describeCapabilities(agents): one line per available agent. */
  capabilityList: string;
  /**
   * Plan 025: requirements already fixed for this task (a replan). When
   * absent the planner extracts them itself in the same response.
   */
  requirements?: Array<{ id: string; text: string }>;
  /** D4: the AGENTS.md chain (root + user-global), stable part of the prompt. */
  projectInstructions?: string;
  /** D4: the time line, appended last (the volatile tail). */
  timeLine?: string;
  /** P1a: chat's routing decision for this task (a prior; orchestrator/planningHint.ts). */
  routingHint?: RoutingHintFacts | null;
}

/**
 * The planning prompt (strict-JSON execution plan). O1: the planner is
 * system code with no persona; the CTO is a role it can route to, and only
 * for an architecture-level decision it flags.
 */
export function planningPromptParts(input: PlanningPromptInput): PlanningPromptParts {
  const { command, classification, policy } = input;
  const lines = (items: string[]) => items.filter((line) => line !== "");
  // D5 prompt order: the stable prefix is the same for every planner call of
  // one task (first plan and replans), so a provider prompt cache can hit.
  // Per-call content (layout, repo map, the request, feedback, fixed
  // requirements) follows it; the time line is the volatile tail.
  const stable = lines([
    "You plan work for a team of specialist roles in Fhara. You do not do the work.",
    ...(input.sharedInstructions
      ? [`Durable shared instructions for this project (must follow): ${input.sharedInstructions}`]
      : []),
    ...(input.projectInstructions ? [input.projectInstructions] : []),
    "The team's roles: CTO (architecture decisions, only when flagged), Designer, Frontend, Backend, QA, Support, DevOps, Reviewer, Researcher.",
    "Analyze the user task, identify which agents are strictly relevant, and produce an execution plan as STRICT JSON.",
    "Do NOT force all agents into every task. Only assign agents whose capabilities match the requirements.",
    "For simple or single-discipline tasks, use strategy 'single' with 1 subtask and empty dependencies [].",
    "For multi-agent work, independent subtasks must have empty dependencies [] so they can run concurrently in parallel.",
    "Dependent subtasks must declare dependencies on the earlier subtask keys they wait for.",
    "Role collaboration patterns:",
    "- When design, visual layout, or pricing directions are needed:",
    "  Designer (ui-ux-design) drafts layout options / proposals (Option A vs Option B) as an analysis subtask. The Designer never writes files; Frontend implements.",
    "- Reviewer (code-review, security-audit): independent code review of implementation diffs and security audits. Read-only.",
    "- CTO (architecture): decides architecture-level questions only, through the architecture flag below. Never give the CTO implementation, review, QA or coordination subtasks. Read-only.",
    "- Technical-debt findings must include evidence, root cause, impact, and a durable remediation owner. The implementer agent coordinates cross-agent fixes; do not hide debt behind a local patch or add a second orchestration path.",
    "- Frontend (frontend-development): UI components, tokens, styling, client implementation, and Next.js app code including src/lib types and utils (lib/resume is frontend unless it contains Convex/api routes).",
    "- Backend (backend-development): Convex/API routes, database schema, server logic. A plain Next.js lib/ file with TypeScript types is frontend, not backend.",
    "- DevOps (github, shell-execution): repositories, issues/PRs, CI, infra commands. May edit only .github/**, Dockerfile*, docker-compose*, infra/**.",
    "- QA (browser-testing): perform only the verification explicitly requested. Structural QA checks HTML, browser reachability, console, and network errors. Responsive viewport and screenshot-baseline checks are opt-in only; never add them when the user says not to.",
    "- Support (documentation-support): documentation guidance, customer communication, release notes. Support may write only Markdown files (*.md, e.g. README.md) and docs/**, never code; a docs-file change for Support is a code_change node scoped to those paths.",
    "- Researcher (research): technical research, evidence gathering, fact vs assumption separation. Read-only.",
    "Agents available (only use capabilities listed here):",
    input.capabilityList,
    "",
    "Rules:",
    `- 1 to ${policy.maxSubtasks} subtasks.`,
    "- Each subtask: key (lowercase slug), title, description, kind, capability, dependencies (keys), order, requirementIds.",
    "- Each subtask also carries a CONTRACT: objective (ONE concrete outcome), constraints (what must not change), deliverable (what it hands back), and acceptance: a list of gates {id, criterion, check, target?}.",
    "  check is one of: typecheck, test, file_exists (target = workspace path that must exist), command (target = a package script such as lint or build), review (reviewer verdict; target \"output\" = the subtask's own answer is non-empty, \"output:sources\" = it cites files/URLs), manual (a person checks it; optional).",
    "  Every code_change needs at least one gate (usually typecheck + test). Research gates: the answer is non-empty and cites sources. Omit acceptance only when the defaults for the kind fit.",
    "- The scope of a subtask is its allowedPaths. Executors stop and escalate (instead of expanding scope) on a schema change, a new dependency, a security-sensitive choice, a file outside scope, or an ambiguous requirement — so list schema files and package.json explicitly in allowedPaths when the change needs them.",
    "- code_change subtasks must declare allowedPaths: the tightest workspace-relative file/directory scope they may modify (e.g. [\"apps/web\"]). Omit only when the scope is genuinely unknown; the executor refuses files outside the declared scope.",
    "- kind is one of: analysis, code_change, review, qa, research, audit, shell.",
    "- kind shell is ONLY for git read-only commands. File creation/write and",
    "  running tests/build must use code_change, never shell.",
    "- Framework requests (React/Vue/Next.js) MUST scaffold a real project:",
    "  package.json, vite/next config, index.html, src/main + src/App (or equivalent).",
    "  Never return a single index.html with CDN <script> tags as a 'migration'.",
    "- Dependencies must reference earlier subtasks and must not form cycles.",
    // Plan 013 step 6: the prompt follows reviewMode/qaMode like the
    // hints layer does, instead of mandating a review for every change.
    ...(policy.reviewMode === "always"
      ? [
          "- Add a review node served by the Reviewer agent for every code change. (policy reviewMode=always).",
        ]
      : policy.reviewMode === "never"
        ? [
            "- Do NOT add a review node: policy reviewMode=never forbids it. The plan carries no review subtask.",
          ]
        : [
            "- Add a review node served by the Reviewer agent only for risky changes: auth, security, payments, migrations, concurrency, multi-domain, or multi-capability work. Simple single-capability changes get no review node. (policy reviewMode=auto: risk signal, not a mandate.)",
          ]),
    ...(policy.qaMode === "always"
      ? [
          "- Add a QA node for every code change: the app must be validated in the browser (policy qaMode=always).",
        ]
      : policy.qaMode === "never"
        ? [
            "- Do NOT add a QA node: policy qaMode=never forbids it. The plan carries no browser-validation subtask.",
          ]
        : [
            "- Add a QA node only when the change touches UI (frontend/design files) or the user explicitly asks for QA / e2e / browser testing (policy qaMode=auto). Backend-only, docs, config or unit-test-only changes get no QA node.",
          ]),
    "- UI changes: a subtask that creates a new component must name its integration file (the existing page / layout / entry point that renders it) in the description and include it in allowedPaths. A component nothing renders is not done.",
    "- ARCHITECTURE FLAG: set architecture.needed=true ONLY when the plan makes an architecture-level decision: a new dependency or framework (new_dependency), a database schema / data-model change (schema_change), an auth or security boundary (auth_boundary), a new cross-component API contract (api_contract), or an infra change that alters the architecture such as splitting services (infra_deploy). Give the reasons, the one-line question the CTO must decide, and gatedKeys (the subtasks that must wait for the decision). Do NOT add a CTO subtask yourself; the system adds the decision node.",
    "- Small decisions inside one role's scope (a button colour, a typo, a UI-only table column, a CI fix, a refactor inside one module) are NOT architecture: leave architecture.needed=false.",
    "- Do NOT invent capabilities that are not listed above.",
    "- Keep the plan minimal; do not add decorative steps.",
    "",
    'Schema: {"goal":"...","strategy":"single"|"dag","requiresApproval":true,"maxConcurrency":1,"requirements":[{"id":"r1","text":"...","quote":"..."}],"architecture":{"needed":false,"reasons":[],"question":"","gatedKeys":[]},"subtasks":[{"key":"implement","requirementIds":["r1"],"title":"...","description":"...","kind":"code_change","capability":"frontend-development","dependencies":[],"order":0,"allowedPaths":["apps/web"],"objective":"...","constraints":["..."],"deliverable":"...","acceptance":[{"id":"typecheck","criterion":"Typecheck passes","check":"typecheck"},{"id":"tests","criterion":"Relevant tests pass","check":"test"}]}]}',
  ]);
  const task = lines([
    ...(input.workspaceLayout && input.workspaceLayout.length > 0
      ? [
          `Workspace layout (real paths; directories end with "/"): ${input.workspaceLayout.join(", ")}`,
          "Declare allowedPaths only from this layout (or new files/directories inside it). A shared root file a subtask may edit (e.g. a stylesheet, index.html, README.md) must be listed explicitly.",
        ]
      : []),
    ...(input.repoMap
      ? [
          `Repository map (source files ranked by relevance to this request, with their key definitions):\n${input.repoMap}`,
          "Use the map to pick the files a subtask should touch; it lists only the most relevant part of the repository.",
        ]
      : []),
    "",
    `User task: ${command}`,
    `Classification: ${classification.kind} (${classification.reasons.join("; ")})`,
    `Suggested capabilities: ${classification.suggestedCapabilities.join(", ")}`,
    ...routingHintPromptLines(input.routingHint),
    policy.maxReplans > 0 && input.feedback
      ? `A previous attempt failed. Feedback to address:\n${input.feedback}`
      : "",
    ...(classification.complexity === "high" || classification.complexity === "ultra"
      ? [
          `Complexity: ${classification.complexity}.${
            classification.concerns && classification.concerns.length > 1
              ? ` The request has ${classification.concerns.length} separate concerns: ${classification.concerns
                  .map((concern, index) => `(${index + 1}) ${concern.category}: "${concern.text}"`)
                  .join("; ")}.`
              : ""
          }`,
          "- Split multi-concern changes: one code_change subtask per concern / file group (e.g. dark-mode styles, header component refactor, tests, README docs), never one subtask that does everything. Each subtask's answer must stay small (only its own files).",
          "- Concerns that edit the same files run in request order: each depends on the previous one.",
        ]
      : []),
    ...(input.feedback && /Subtask timed out/.test(input.feedback)
      ? [
          "- A subtask TIMED OUT in the previous attempt: do not plan it again as-is. Split it into smaller subtasks (one per concern or per file group) so every step finishes well inside the time limit.",
        ]
      : []),
    ...(isReadOnlyTaskKind(classification.kind)
      ? [
          "",
          `READ-ONLY TASK (classification: ${classification.kind}). The user asked for research / an answer, not a change.`,
          "- Use ONLY read-only kinds: research, analysis (audit for a code inspection). NEVER emit code_change, shell, review or qa subtasks: nothing is written, applied, committed, reviewed as a diff or browser-tested.",
          "- Do not add allowedPaths. Gates: the answer is non-empty and cites its sources.",
          "- Requirements are what the user asked to learn or decide, not changes to make.",
          "- If changes would help, the final research subtask ends its answer with a short plain-text \"Suggested follow-up tasks\" list. Do NOT plan those tasks here; the user starts them.",
          "- requiresApproval is false.",
          ...(classification.investigation
            ? [
                "- This is a vague bug hunt with no symptom: plan exactly ONE research subtask with capability code-review (the Reviewer) that reads the code and reports concrete bugs as findings with file:line evidence, or says none were found and what was checked. No browser QA.",
              ]
            : []),
        ]
      : []),
    ...(classification.kind === "command"
      ? [
          "",
          `RUN-COMMAND TASK (classification: command). The user asked to RUN: ${(classification.commands ?? []).join(", ")}.`,
          "- Emit one subtask per command: kind \"shell\", capability \"shell-execution\", description \"Run exactly: <command line>\". Commands run in request order (each depends on the previous one).",
          "- NEVER emit code_change, review or qa subtasks and do not write report files: the worker runs the command (after command approval) and its output is the result.",
          "- requiresApproval is false (each command is approved when it runs).",
        ]
      : []),
    "Requirements (this call):",
    ...(input.requirements && input.requirements.length > 0
      ? [
          `- The user's requirements are fixed for this task: ${input.requirements
            .map((requirement) => `${requirement.id} "${requirement.text}"`)
            .join("; ")}. Do not add a "requirements" field. Every subtask lists the requirement ids it serves in requirementIds, and every requirement must be served by at least one implementing subtask.`,
        ]
      : [
          "- REQUIREMENTS: first list every distinct thing the user asked for as requirements: [{id: \"r1\", text, quote}], where quote is the exact words of the user task it came from (one entry per list item, e.g. \"login, register, logout and refresh token\" is four requirements). Every subtask lists the requirement ids it serves in requirementIds, and every requirement must be served by at least one implementing subtask.",
        ]),
  ]);
  return { stable, task, volatile: input.timeLine ? [input.timeLine] : [] };
}

export interface PlanningPromptParts {
  stable: string[];
  task: string[];
  volatile: string[];
}

/**
 * The planning prompt (one user turn, no system message): the stable prefix,
 * then the call's task part, then the volatile tail (lib/assemblePrompt.ts).
 */
export function planningPrompt(input: PlanningPromptInput): string {
  const parts = planningPromptParts(input);
  const [turn] = assemblePrompt({
    stable: parts.stable,
    history: [{ role: "user", content: parts.task.join("\n") }],
    volatile: parts.volatile,
    stableAs: "user",
  });
  return turn.content;
}

/** Instructions carried by the nodes the planner adds itself (hints, heuristic plans). */
export const PLAN_NODE_INSTRUCTIONS = {
  archDecision:
    "Architecture decision (CTO). Decide only the architecture question below for this plan: the approach, the constraints the implementing roles must follow, and the main risk, in 2-3 plain sentences. Do not plan, implement or review the work. End with exactly one line: \"Decision: go\" (the plan may proceed), \"Decision: revise\" (the plan must change; say how), or \"Decision: stop\" (the work must not be done; say why).",
  review:
    "Reviewer must inspect the completed implementation diff and either approve it or request revision. Check code quality, security, regression risk, performance, contract compatibility, project conventions, duplication, scalability, maintainability, and whether architectural changes are justified. Do NOT run verification commands (tsc, lint, test, build) — those are executed by the runtime verification loop, not by the reviewer (read-only). For every finding, identify the root cause, define the smallest durable fix, and direct the implementer agent to coordinate the remediation when it spans agents or subsystems.",
  qaVisual:
    "Run the app after changes are applied and verify responsive visuals, console errors and network failures.",
  qaStructural:
    "Validate the HTML structure, open the page in a browser, and check console and network errors; do not compare visual baselines.",
  reply:
    "Respond briefly and ask for the concrete change the user wants. Do not modify files.",
  auditFrontend:
    "Read-only audit of frontend (components, pages, styles, a11y, state). Report findings with file refs. No code changes.",
  auditBackend:
    "Read-only audit of backend (API routes, Convex/DB, auth, validation, errors). Report findings with file refs. No code changes.",
  auditSecurity:
    "Read-only security audit (auth, secrets, injection, CORS, deps). Report findings with severity + file refs. No code changes.",
  auditConsolidate:
    "Consolidate frontend/backend/security findings into prioritized report with severity, impact, recommendation. No code changes.",
  audit:
    "Read-only audit. Report concrete findings with file references. Do not modify files.",
  investigation:
    "Read-only bug investigation. Read the code the user pointed at (or the main entry points) and report concrete bugs as findings: file:line, what goes wrong, and how to reproduce it. Only report what the code you read shows. If you find no real bug, say so and list what you checked. Do not modify files and do not invent features; end with a short \"Suggested follow-up tasks\" list only when a fix is worth doing.",
} as const;
