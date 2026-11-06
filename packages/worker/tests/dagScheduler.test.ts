import { describe, expect, it, vi } from "vitest";
import {
  isPermanentSubtaskError,
  runScheduler,
  shouldRetrySubtask,
  type NodeOutcome,
} from "@/scheduler/dagScheduler";

const nodes = (definitions: Array<[string, string[]]>) =>
  definitions.map(([id, dependencies]) => ({ id, dependencies }));

describe("DAG scheduler", () => {
  it("runs dependencies before dependents", async () => {
    const order: string[] = [];
    const result = await runScheduler(
      nodes([
        ["b", ["a"]],
        ["a", []],
      ]),
      async (node) => {
        order.push(node.id);
        return { status: "completed" };
      },
      {
        maxConcurrency: 2,
        timeoutMs: 2000,
        retries: 0,
        onStart: async () => undefined,
        onOutcome: async () => undefined,
      }
    );
    expect(result.status).toBe("completed");
    expect(order).toEqual(["a", "b"]);
  });

  it("respects the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const result = await runScheduler(
      nodes([
        ["a", []],
        ["b", []],
        ["c", []],
      ]),
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { status: "completed" };
      },
      {
        maxConcurrency: 2,
        timeoutMs: 2000,
        retries: 0,
        onStart: async () => undefined,
        onOutcome: async () => undefined,
      }
    );
    expect(result.status).toBe("completed");
    expect(peak).toBe(2);
  });

  it("blocks dependents after a failure", async () => {
    const outcomes: Record<string, string> = {};
    const result = await runScheduler(
      nodes([
        ["a", []],
        ["b", ["a"]],
        ["c", ["b"]],
      ]),
      async (node): Promise<NodeOutcome> =>
        node.id === "a"
          ? { status: "failed", error: "boom" }
          : { status: "completed" },
      {
        maxConcurrency: 2,
        timeoutMs: 2000,
        retries: 0,
        onStart: async () => undefined,
        onOutcome: async (node, outcome) => {
          outcomes[node.id] = outcome.status;
        },
        onBlocked: async (node) => {
          outcomes[node.id] = "failed";
        },
      }
    );
    expect(result.status).toBe("failed");
    expect(result.failed).toContain("a");
    expect(outcomes.b).toBe("failed");
    expect(outcomes.c).toBe("failed");
  });

  it("retries failed nodes up to the configured limit", async () => {
    let attempts = 0;
    const result = await runScheduler(
      nodes([["a", []]]),
      async () => {
        attempts += 1;
        return attempts < 2
          ? { status: "failed", error: "transient" }
          : { status: "completed" };
      },
      {
        maxConcurrency: 1,
        timeoutMs: 2000,
        retries: 1,
        retryDelayMs: 1,
        onStart: async () => undefined,
        onOutcome: async () => undefined,
      }
    );
    expect(result.status).toBe("completed");
    expect(attempts).toBe(2);
  });

  it("enforces per-subtask timeouts", async () => {
    const result = await runScheduler(
      nodes([["a", []]]),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { status: "completed" };
      },
      {
        maxConcurrency: 1,
        timeoutMs: 20,
        retries: 0,
        onStart: async () => undefined,
        onOutcome: async () => undefined,
      }
    );
    expect(result.status).toBe("failed");
    expect(result.failed).toContain("a");
  });

  it("stops timed-out work before retrying", async () => {
    const events: string[] = [];
    const result = await runScheduler(
      nodes([["a", []]]),
      async (node, signal) => {
        events.push(`start:${node.id}`);
        await new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            resolve(undefined);
          });
        });
        events.push(`settled:${node.id}`);
        return { status: "completed" };
      },
      {
        maxConcurrency: 1,
        timeoutMs: 20,
        retries: 0,
        onStart: async () => undefined,
        onOutcome: async () => undefined,
      }
    );
    expect(result.status).toBe("failed");
    expect(events).toEqual(["start:a", "settled:a"]);
  });

  it("stops scheduling when the task is cancelled", async () => {
    const executed: string[] = [];
    const shouldCancel = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const result = await runScheduler(
      nodes([
        ["a", []],
        ["b", []],
        ["c", []],
      ]),
      async (node) => {
        executed.push(node.id);
        return { status: "completed" };
      },
      {
        maxConcurrency: 1,
        timeoutMs: 2000,
        retries: 0,
        shouldCancel,
        onStart: async () => undefined,
        onOutcome: async () => undefined,
      }
    );
    expect(result.status).toBe("cancelled");
    expect(executed.length).toBeLessThan(3);
  });

  it("halts after a waiting-approval outcome", async () => {
    const executed: string[] = [];
    const result = await runScheduler(
      nodes([
        ["implement", []],
        ["qa", ["implement"]],
      ]),
      async (node) => {
        executed.push(node.id);
        return node.id === "implement"
          ? { status: "waiting_approval" }
          : { status: "completed" };
      },
      {
        maxConcurrency: 1,
        timeoutMs: 2000,
        retries: 0,
        onStart: async () => undefined,
        onOutcome: async () => undefined,
      }
    );
    expect(result.status).toBe("halted");
    expect(executed).toEqual(["implement"]);
  });
});

describe("subtask retry classification", () => {
  it("classifies deterministic failures as permanent", () => {
    const permanent = [
      // Plan validation (planValidator messages)
      "plan.goal is required",
      "plan.subtasks must be a non-empty array",
      "plan has 9 subtasks; limit is 8",
      "duplicate subtask key: implement",
      "subtask qa depends on unknown subtask review",
      "subtask a depends on itself",
      "dependency cycle detected: a -> b -> a",
      "subtask x: kind must be one of code_change, review",
      "subtask x: capability is required",
      // Forbidden / protected paths
      "Refusing to modify protected path: .env",
      "Refusing to modify protected path (file-path-forbidden): ../secret.txt",
      // No agent for the capability
      'No enabled agent can serve capability "browser-testing"',
      "No enabled agent for capability browser-testing",
      // Unparseable final JSON from the model
      "The implementation agent did not return valid file changes JSON",
      "The review agent returned an unparseable review; refusing to proceed",
    ];
    for (const error of permanent) {
      expect(isPermanentSubtaskError(error), error).toBe(true);
      expect(shouldRetrySubtask(error), error).toBe(false);
    }
  });

  it("classifies permanent LLM failures as non-retryable via the LLM classifier", () => {
    const permanentLlm = [
      "LLM request failed (404): model not found",
      "LLM request failed (401): invalid api key",
      "LLM request failed (400): bad request",
    ];
    for (const error of permanentLlm) {
      // Not a scheduler pattern — the decision comes from isTransientLlmError.
      expect(isPermanentSubtaskError(error), error).toBe(false);
      expect(shouldRetrySubtask(error), error).toBe(false);
    }
  });

  it("keeps transient failures retryable", () => {
    const transient = [
      "transient",
      "boom",
      "Subtask timed out after 2000ms",
      "LLM request failed (429): rate limited",
      "LLM request failed (503): upstream unavailable",
      "LLM request failed: network unreachable",
      "QA failed: desktop viewport: Page returned HTTP 500",
      "The research agent returned an empty response",
      "Could not stage src/index.ts: ENOSPC: no space left on device",
      "Execution cancelled",
    ];
    for (const error of transient) {
      expect(isPermanentSubtaskError(error), error).toBe(false);
      expect(shouldRetrySubtask(error), error).toBe(true);
    }
  });

  it("does not retry a permanent subtask failure", async () => {
    let attempts = 0;
    const result = await runScheduler(
      nodes([["a", []]]),
      async () => {
        attempts += 1;
        return {
          status: "failed",
          error: 'No enabled agent can serve capability "browser-testing"',
        } as NodeOutcome;
      },
      {
        maxConcurrency: 1,
        timeoutMs: 2000,
        retries: 3,
        retryDelayMs: 1,
        onStart: async () => undefined,
        onOutcome: async () => undefined,
      }
    );
    expect(result.status).toBe("failed");
    expect(result.failed).toContain("a");
    expect(attempts).toBe(1);
  });

  it("does not retry a permanent LLM failure (404) at scheduler level", async () => {
    let attempts = 0;
    const result = await runScheduler(
      nodes([["a", []]]),
      async () => {
        attempts += 1;
        return {
          status: "failed",
          error: "LLM request failed (404): model not found",
        } as NodeOutcome;
      },
      {
        maxConcurrency: 1,
        timeoutMs: 2000,
        retries: 2,
        retryDelayMs: 1,
        onStart: async () => undefined,
        onOutcome: async () => undefined,
      }
    );
    expect(result.status).toBe("failed");
    expect(attempts).toBe(1);
  });

  it("still retries a transient LLM failure (503) until it succeeds", async () => {
    let attempts = 0;
    const result = await runScheduler(
      nodes([["a", []]]),
      async () => {
        attempts += 1;
        return attempts < 2
          ? ({
              status: "failed",
              error: "LLM request failed (503): upstream unavailable",
            } as NodeOutcome)
          : ({ status: "completed" } as NodeOutcome);
      },
      {
        maxConcurrency: 1,
        timeoutMs: 2000,
        retries: 2,
        retryDelayMs: 1,
        onStart: async () => undefined,
        onOutcome: async () => undefined,
      }
    );
    expect(result.status).toBe("completed");
    expect(attempts).toBe(2);
  });
});
