import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  classifyFailure,
  decideRetry,
  isPermanentSubtaskError,
  isRetryableClass,
  shouldRetrySubtask,
  type FailedObservation,
  type StalledObservation,
} from "@/orchestrator/decisionEngine";
import * as scheduler from "@/scheduler/dagScheduler";

/** L8: every branch of decisionEngine/retry.ts. */

const failed = (fields: Partial<FailedObservation> = {}): FailedObservation => ({
  kind: "failed",
  nodeKey: "a",
  errorClass: "unknown",
  attempt: 1,
  maxAttempts: 2,
  cancelled: false,
  retryDelayMs: 250,
  ...fields,
});

const stalled = (fields: Partial<StalledObservation> = {}): StalledObservation => ({
  kind: "stalled",
  nodeKey: "a",
  attempt: 1,
  maxAttempts: 1,
  cancelled: false,
  error: "Agent stalled: no output or heartbeat progress for 1000ms",
  ...fields,
});

describe("classifyFailure", () => {
  it.each([
    ["Refusing to modify protected path .env", "permanent"],
    ["Blocked: No agent available for capability \"x\": no enabled agents", "permanent"],
    ["Escalated (needs_decision): pick a database", "escalation"],
    ["LLM request failed (400): bad request", "permanent"],
    ["LLM request failed (429): slow down", "transient"],
    ["LLM request failed (503): upstream unavailable", "transient"],
    ["LLM request failed: socket hang up", "transient"],
    ["Subtask timed out after 300000ms", "unknown"],
    ["Budget exhausted: max LLM calls reached", "unknown"],
    ["transient boom", "unknown"],
  ] as const)("%s → %s", (error, expected) => {
    expect(classifyFailure(error)).toBe(expected);
    expect(shouldRetrySubtask(error)).toBe(expected === "transient" || expected === "unknown");
  });

  it("only transient and unknown are retryable; budget never comes from the text", () => {
    expect(["permanent", "transient", "budget", "escalation", "unknown"].filter((c) => isRetryableClass(c as never))).toEqual(["transient", "unknown"]);
  });

  it("the scheduler re-exports the same functions", () => {
    expect(scheduler.isPermanentSubtaskError).toBe(isPermanentSubtaskError);
    expect(scheduler.shouldRetrySubtask).toBe(shouldRetrySubtask);
    expect(scheduler.classifyFailure).toBe(classifyFailure);
  });
});

describe("decideRetry: failed", () => {
  it("blocks a permanent or escalation class without reading any fact", () => {
    expect(decideRetry(failed({ errorClass: "permanent" }))).toEqual({ kind: "block", reason: "permanent" });
    expect(decideRetry(failed({ errorClass: "escalation" }))).toEqual({ kind: "block", reason: "permanent" });
    expect(decideRetry(failed({ errorClass: "budget" }))).toEqual({ kind: "block", reason: "permanent" });
  });

  it("asks for the halt fact first, then blocks on a halt", () => {
    expect(decideRetry(failed())).toEqual({ kind: "check", fact: "halted" });
    expect(decideRetry(failed({ halted: true }))).toEqual({ kind: "block", reason: "halted" });
  });

  it("asks for the budget only when a retry is otherwise allowed", () => {
    expect(decideRetry(failed({ halted: false }))).toEqual({ kind: "check", fact: "budgetLeft" });
    expect(decideRetry(failed({ halted: false, attempt: 3 }))).toEqual({ kind: "block", reason: "exhausted", exhausted: true });
    expect(decideRetry(failed({ halted: false, cancelled: true }))).toEqual({ kind: "block", reason: "exhausted", exhausted: true });
  });

  it("vetoes on budget, otherwise retries with linear backoff", () => {
    expect(decideRetry(failed({ halted: false, budgetLeft: false }))).toEqual({ kind: "block", reason: "budget" });
    expect(decideRetry(failed({ halted: false, budgetLeft: true }))).toEqual({ kind: "retry", afterMs: 250 });
    expect(decideRetry(failed({ halted: false, budgetLeft: true, attempt: 2, errorClass: "transient" }))).toEqual({ kind: "retry", afterMs: 500 });
    expect(decideRetry(failed({ halted: false, budgetLeft: true, retryDelayMs: 0 }))).toEqual({ kind: "retry", afterMs: 0 });
  });

  it("the last allowed attempt still retries; one past it is exhausted", () => {
    expect(decideRetry(failed({ halted: false, budgetLeft: true, attempt: 2 })).kind).toBe("retry");
    expect(decideRetry(failed({ halted: false, budgetLeft: true, attempt: 3 })).kind).toBe("block");
    expect(decideRetry(failed({ halted: false, budgetLeft: true, maxAttempts: 0 })).kind).toBe("block");
  });
});

describe("decideRetry: stalled", () => {
  const escalation = "Escalated (agent_stalled): Agent stalled: no output or heartbeat progress for 1000ms on 2 attempt(s); not retried again";

  it("escalates once the stall retries are spent or the run is cancelled, without reading facts", () => {
    expect(decideRetry(stalled({ attempt: 2 }))).toEqual({ kind: "escalate", error: escalation });
    expect(decideRetry(stalled({ cancelled: true })).kind).toBe("escalate");
    expect(decideRetry(stalled({ maxAttempts: 0 })).kind).toBe("escalate");
  });

  it("reads halt then budget, and retries at once when both allow it", () => {
    expect(decideRetry(stalled())).toEqual({ kind: "check", fact: "halted" });
    expect(decideRetry(stalled({ halted: true })).kind).toBe("escalate");
    expect(decideRetry(stalled({ halted: false }))).toEqual({ kind: "check", fact: "budgetLeft" });
    expect(decideRetry(stalled({ halted: false, budgetLeft: false })).kind).toBe("escalate");
    expect(decideRetry(stalled({ halted: false, budgetLeft: true }))).toEqual({ kind: "retry", afterMs: 0 });
  });
});

describe("decideRetry: runNodes observations", () => {
  it("prerequisite_missing blocks with the historical message; none missing executes", () => {
    expect(decideRetry({ kind: "prerequisite_missing", nodeKey: "b", missing: ["a"] })).toEqual({
      kind: "block",
      reason: "prerequisite",
      error: 'Prerequisite for "b" has not completed',
    });
    expect(decideRetry({ kind: "prerequisite_missing", nodeKey: "b", missing: [] })).toEqual({ kind: "execute" });
  });

  it("unroutable is BLOCKED with the routing reason (and stays permanent for the scheduler)", () => {
    const step = decideRetry({ kind: "unroutable", nodeKey: "db", capability: "dba", reason: 'No agent available for capability "dba": no enabled agents' });
    expect(step).toEqual({ kind: "block", reason: "unroutable", error: 'Blocked: No agent available for capability "dba": no enabled agents' });
    expect(step.kind === "block" && classifyFailure(step.error!)).toBe("permanent");
  });

  it("runtime_unavailable falls back to the API runtime with the gate's reason", () => {
    expect(decideRetry({ kind: "runtime_unavailable", nodeKey: "a", runtime: "native-provider", reason: "OpenCode CLI not detected on this worker" })).toEqual({
      kind: "fallback",
      runtime: "api",
      reason: "OpenCode CLI not detected on this worker",
    });
    expect(decideRetry({ kind: "runtime_unavailable", nodeKey: "a", runtime: "native-provider" })).toEqual({
      kind: "fallback",
      runtime: "api",
      reason: "OpenCode is unavailable",
    });
  });
});

describe("retries are not rounds", () => {
  it("retry.ts never reads or decides a fix round or a replan", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../src/orchestrator/decisionEngine/retry.ts"), "utf8");
    const imports = source.split("\n").filter((line) => line.startsWith("import "));
    expect(imports).toEqual(['import { isTransientLlmError } from "@/effects/llmCall";']);
    expect(source).not.toMatch(/\b(round|rounds|replansLeft|fixRoundsExhausted)\b\s*[:=]/);
  });
});
