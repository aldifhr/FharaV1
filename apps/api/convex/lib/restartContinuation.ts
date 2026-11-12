// Adapted from GOAT (https://github.com/goat-si/goat) apps/server/src/orchestration-v2/RestartContinuation.ts @ 718f5b11,
// MIT License, Copyright (c) 2026 T3 Tools Inc. and goat-si contributors. See THIRD_PARTY_NOTICES.md.
/**
 * G4 restart continuation (pure; used by the worker's subtask recovery).
 *
 * A run cut off by a worker crash, shutdown or lost lease is not started
 * over: it gets ONE continuation that carries the steps it already
 * recorded plus `CONTINUE_PROMPT`. A loop guard allows at most
 * `MAX_CONTINUATIONS_IN_WINDOW` continuations of the same run inside
 * `CONTINUATION_LOOP_WINDOW_MS`; the next one is refused with a reason and
 * the run fails or holds the normal way. Copied from GOAT: the prompt text
 * and the window. The rest (step records, read-only command list,
 * formatting) is Fhara's own.
 */

export const CONTINUE_PROMPT =
  "Continue where you left off. Your last turn was cut short, so a command or other action it started may have finished or may still be running. Before you repeat one that changes state, confirm it did not take effect and is not still running; if you cannot tell, say so instead of repeating it.";

export const CONTINUATION_LOOP_WINDOW_MS = 5 * 60 * 1_000;
export const MAX_CONTINUATIONS_IN_WINDOW = 3;

/** Event type that records one continuation (the guard counts these). */
export const SUBTASK_CONTINUED_EVENT = "subtask.continued";

/** taskEvents types that are tool steps of an orchestrated subtask. */
export const SUBTASK_STEP_EVENT_TYPES = [
  "shell.command",
  "fileChanges.updated",
  "fileChanges.discarded",
  "native.tool",
  "agent.mcp_tools",
] as const;

/** One recorded step, trimmed to what a continuation needs (no outputs). */
export interface RecordedStep {
  type: string;
  subtaskKey?: string;
  sequence?: number;
  createdAt?: number;
  command?: string;
  args?: string[];
  filePaths?: string[];
  title?: string;
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const strs = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 50) : undefined;

/** Trim a taskEvents row to a RecordedStep (payload fields only, clipped). */
export function toRecordedStep(event: {
  type: string;
  subtaskKey?: string;
  sequence?: number;
  createdAt?: number;
  _creationTime?: number;
  payload?: unknown;
}): RecordedStep {
  const p = (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
  const path = str(p.path) ?? str(p.filePath);
  const title = str(p.title) ?? str(p.name) ?? [str(p.tool), str(p.target)].filter(Boolean).join(" ");
  const step: RecordedStep = { type: event.type };
  if (event.subtaskKey) step.subtaskKey = event.subtaskKey;
  if (typeof event.sequence === "number") step.sequence = event.sequence;
  const at = event.createdAt ?? event._creationTime;
  if (typeof at === "number") step.createdAt = at;
  if (str(p.command)) step.command = str(p.command);
  const args = strs(p.args);
  if (args) step.args = args;
  const filePaths = strs(p.filePaths) ?? (path ? [path] : undefined);
  if (filePaths) step.filePaths = filePaths;
  if (title) step.title = title.slice(0, 200);
  return step;
}

/** The shell line of a recorded command step, or null. */
export function stepCommandLine(step: Pick<RecordedStep, "command" | "args">): string | null {
  if (!step.command) return null;
  return [step.command, ...(step.args ?? [])].join(" ").trim();
}

// Commands that only read: running one again after a cut-off changes nothing.
const READ_ONLY_HEADS = new Set(["ls", "cat", "head", "tail", "wc", "pwd", "echo", "grep", "rg", "find", "stat", "tsc", "vitest", "jest", "pytest", "eslint", "oxlint"]);
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "ls-remote", "branch", "blame"]);
const READ_ONLY_NPM_SCRIPTS = new Set(["test", "lint", "typecheck", "check", "build"]);

/** Whether a command only reads (safe to run again in a continuation). */
export function isReadOnlyCommand(command: string, args: readonly string[]): boolean {
  const head = command.split("/").pop() ?? command;
  if (READ_ONLY_HEADS.has(head)) return !(head === "find" && args.some((arg) => arg === "-delete" || arg === "-exec"));
  if (head === "git") return READ_ONLY_GIT.has(args[0] ?? "") && !(args[0] === "branch" && args.some((arg) => /^-[dDmM]|^--(delete|move)/.test(arg)));
  if (head === "npm" || head === "pnpm" || head === "yarn") {
    if (args[0] === "test" || args[0] === "t") return true;
    return args[0] === "run" && READ_ONLY_NPM_SCRIPTS.has(args[1] ?? "");
  }
  if (head === "npx") return READ_ONLY_HEADS.has(args[0] ?? "");
  return false;
}

/**
 * Recorded commands that changed (or may have changed) state. A
 * continuation never runs one of these again.
 */
export function recordedSideEffects(steps: readonly RecordedStep[]): string[] {
  const lines = new Set<string>();
  for (const step of steps) {
    const line = stepCommandLine(step);
    if (line && !isReadOnlyCommand(step.command!, step.args ?? [])) lines.add(line);
  }
  return [...lines];
}

export type ContinuationDecision =
  | { allowed: true; attempt: number }
  | { allowed: false; reason: string };

/**
 * The loop guard: `previous` are the times earlier continuations of the
 * same run started. At most MAX_CONTINUATIONS_IN_WINDOW inside the window.
 */
export function decideContinuation(previous: readonly number[], now: number): ContinuationDecision {
  const recent = previous.filter((at) => at > now - CONTINUATION_LOOP_WINDOW_MS && at <= now);
  if (recent.length >= MAX_CONTINUATIONS_IN_WINDOW) {
    const minutes = Math.round(CONTINUATION_LOOP_WINDOW_MS / 60_000);
    return {
      allowed: false,
      reason: `Continuation refused: this run was already continued ${recent.length} times in the last ${minutes} minutes after being cut off (limit ${MAX_CONTINUATIONS_IN_WINDOW}). It keeps getting interrupted, so it is not continued again automatically.`,
    };
  }
  return { allowed: true, attempt: recent.length + 1 };
}

/** One line per recorded step, oldest first. */
export function describeStep(step: RecordedStep): string | null {
  const line = stepCommandLine(step);
  if (line) return `ran \`${line}\``;
  if (step.type === "fileChanges.updated") return step.filePaths?.length ? `edited ${step.filePaths.join(", ")}` : null;
  if (step.type === "fileChanges.discarded") return step.filePaths?.length ? `withdrew the edit to ${step.filePaths.join(", ")}` : null;
  return step.title ? `used ${step.title}` : null;
}

const MAX_LISTED_STEPS = 40;

/**
 * The continuation text: CONTINUE_PROMPT, the steps the cut-off turn
 * recorded, and the commands that must not be run again.
 */
export function buildContinuationText(steps: readonly RecordedStep[]): string {
  const lines = steps.map(describeStep).filter((line): line is string => !!line);
  const listed = lines.slice(-MAX_LISTED_STEPS);
  const effects = recordedSideEffects(steps);
  const parts = [CONTINUE_PROMPT];
  if (listed.length > 0) {
    parts.push(
      `Steps already recorded before the cut-off${lines.length > listed.length ? ` (last ${listed.length} of ${lines.length})` : ""}:\n${listed.map((line) => `- ${line}`).join("\n")}`
    );
  } else {
    parts.push("No tool step was recorded before the cut-off.");
  }
  if (effects.length > 0) {
    parts.push(`These recorded commands may have changed state and will not be run again:\n${effects.map((line) => `- ${line}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/** Subtask statuses that are settled: never continued. */
const SETTLED_SUBTASK = new Set(["completed", "waiting_approval", "skipped"]);

/**
 * Subtasks a dead worker cut off: not settled, and their latest execution
 * was ended by lease recovery (`leaseLost`) or is still marked running.
 */
export function interruptedSubtaskKeys(
  subtasks: ReadonlyArray<{ key: string; status: string }>,
  executions: ReadonlyArray<{ subtaskKey?: string; status?: string; leaseLost?: boolean; attempt?: number; createdAt?: number }>
): string[] {
  const latest = new Map<string, (typeof executions)[number]>();
  for (const execution of executions) {
    if (!execution.subtaskKey) continue;
    const seen = latest.get(execution.subtaskKey);
    const rank = (row: (typeof executions)[number]) => [row.attempt ?? 0, row.createdAt ?? 0];
    if (!seen || rank(execution)[0] > rank(seen)[0] || (rank(execution)[0] === rank(seen)[0] && rank(execution)[1] >= rank(seen)[1])) {
      latest.set(execution.subtaskKey, execution);
    }
  }
  return subtasks
    .filter((subtask) => !SETTLED_SUBTASK.has(subtask.status))
    .filter((subtask) => {
      const row = latest.get(subtask.key);
      return !!row && (row.leaseLost === true || row.status === "running");
    })
    .map((subtask) => subtask.key);
}
