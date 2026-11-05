import { describe, expect, it, vi } from "vitest";
import { runScheduler, type NodeOutcome } from "../src/scheduler/dagScheduler";

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
