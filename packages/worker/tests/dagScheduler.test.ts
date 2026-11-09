import { describe, expect, it, vi } from "vitest";
import {
  isPermanentSubtaskError,
  runScheduler,
  shouldRetrySubtask,
  type NodeOutcome,
  type SchedulerNode,
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

describe("DAG scheduler dynamic nodes (Phase 3)", () => {  it("schedules nodes returned by onOutcome within the same run", async () => {
    const order: string[] = [];
    const result = await runScheduler(
      nodes([["a", []]]),
      async (node) => {
        order.push(node.id);
        return { status: "completed" };
      },
      {
        maxConcurrency: 1,
        timeoutMs: 2000,
        retries: 0,
        onStart: async () => undefined,
        onOutcome: async (node) => {
          if (node.id === "a") return [{ id: "extra", dependencies: ["a"] }];
          return undefined;
        },
      }
    );
    expect(result.status).toBe("completed");
    expect(order).toEqual(["a", "extra"]);
    expect(result.outcomes.get("extra")?.status).toBe("completed");
  });

  it("never schedules a returned node whose id already exists", async () => {
    const counts = new Map<string, number>();
    const result = await runScheduler(
      nodes([
        ["a", []],
        ["b", []],
      ]),
      async (node) => {
        counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
        return { status: "completed" };
      },
      {
        maxConcurrency: 1,
        timeoutMs: 2000,
        retries: 0,
        onStart: async () => undefined,
        onOutcome: async (node) => {
          // Both outcomes try to (re)add an existing key.
          if (node.id === "a") return [{ id: "b", dependencies: [] }];
          return [{ id: "a", dependencies: [] }];
        },
      }
    );
    expect(result.status).toBe("completed");
    expect(counts.get("a")).toBe(1);
    expect(counts.get("b")).toBe(1);
  });

  it("drops returned nodes whose dependencies do not exist", async () => {
    const executed: string[] = [];
    const result = await runScheduler(
      nodes([["a", []]]),
      async (node) => {
        executed.push(node.id);
        return { status: "completed" };
      },
      {
        maxConcurrency: 1,
        timeoutMs: 2000,
        retries: 0,
        onStart: async () => undefined,
        onOutcome: async (node) => {
          if (node.id === "a") return [{ id: "orphan", dependencies: ["ghost"] }];
          return undefined;
        },
      }
    );
    expect(result.status).toBe("completed");
    expect(executed).toEqual(["a"]);
    expect(result.outcomes.has("orphan")).toBe(false);
  });

  it("caps dynamically added nodes at maxAddedNodes", async () => {
    const executed: string[] = [];
    let seq = 0;
    const result = await runScheduler(
      nodes([["a", []]]),
      async (node) => {
        executed.push(node.id);
        return { status: "completed" };
      },
      {
        maxConcurrency: 1,
        timeoutMs: 2000,
        retries: 0,
        maxAddedNodes: 2,
        onStart: async () => undefined,
        onOutcome: async (node) => {
          // Every outcome tries to extend the chain forever; the cap
          // must bound the run to 1 initial + 2 added nodes.
          seq += 1;
          return [{ id: `n${seq}`, dependencies: [node.id] }];
        },
      }
    );
    expect(result.status).toBe("completed");
    expect(executed).toHaveLength(3);
  });

  it("reports completed when the halt latches only after the final node settles", async () => {
    const executed: string[] = [];
    let halt = false;
    const result = await runScheduler(
      nodes([
        ["a", []],
      ]),
      async (node) => {
        executed.push(node.id);
        return { status: "completed" };
      },
      {
        maxConcurrency: 1,
        timeoutMs: 2000,
        retries: 0,
        shouldHaltNewNodes: () => halt,
        onStart: async () => undefined,
        onOutcome: async (node) => {
          if (node.id === "a") halt = true;
          return undefined;
        },
      }
    );
    expect(executed).toEqual(["a"]);
    expect(result.failed).toEqual([]);
    expect(result.status).toBe("completed");
  });

  it("halts new scheduling gracefully: running work drains, pending nodes are blocked", async () => {
    const executed: string[] = [];
    const blocked: string[] = [];
    let halt = false;
    const result = await runScheduler(
      nodes([
        ["a", []],
        ["b", []],
        ["c", ["b"]],
      ]),
      async (node) => {
        executed.push(node.id);
        return { status: "completed" };
      },
      {
        maxConcurrency: 1,
        timeoutMs: 2000,
        retries: 0,
        shouldHaltNewNodes: () => halt,
        onStart: async () => undefined,
        onOutcome: async (node) => {
          if (node.id === "a") halt = true;
          return undefined;
        },
        onBlocked: async (node) => {
          blocked.push(node.id);
        },
      }
    );
    expect(executed).toEqual(["a"]);
    expect(blocked.sort()).toEqual(["b", "c"]);
    expect(result.failed.sort()).toEqual(["b", "c"]);
    expect(result.outcomes.get("b")?.status).toBe("failed");
  });
});

describe("DAG scheduler per-agent concurrency gate (Phase 4)", () => {
  /**
   * Mirrors the runner's wiring: nodes belong to agents, onStart /
   * onOutcome maintain the live per-agent in-flight counts, and
   * canStartNode defers a node whose agent is at its limit.
   */
  function agentGate(agentOf: Record<string, string>, limits: Record<string, number>) {
    const active = new Map<string, number>();
    return {
      canStartNode: (node: SchedulerNode) => {
        const agent = agentOf[node.id];
        if (!agent) return true;
        const limit = limits[agent] ?? 1;
        return (active.get(agent) ?? 0) < limit;
      },
      onStart: async (node: SchedulerNode) => {
        const agent = agentOf[node.id];
        if (agent) active.set(agent, (active.get(agent) ?? 0) + 1);
      },
      onOutcome: async (node: SchedulerNode) => {
        const agent = agentOf[node.id];
        if (agent) active.set(agent, Math.max(0, (active.get(agent) ?? 1) - 1));
      },
    };
  }

  it("agent maxConcurrency 1 serializes two parallel subtasks (start/finish order)", async () => {
    const events: string[] = [];
    const gate = agentGate({ a: "solo", b: "solo" }, { solo: 1 });
    const result = await runScheduler(
      nodes([
        ["a", []],
        ["b", []],
      ]),
      async (node) => {
        events.push(`start:${node.id}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push(`end:${node.id}`);
        return { status: "completed" };
      },
      {
        // The scheduler-wide cap is 2: only the per-agent gate can
        // be responsible for the serialization asserted below.
        maxConcurrency: 2,
        timeoutMs: 2000,
        retries: 0,
        canStartNode: gate.canStartNode,
        onStart: gate.onStart,
        onOutcome: gate.onOutcome,
      }
    );
    expect(result.status).toBe("completed");
    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("agent maxConcurrency 2 lets two subtasks of the same agent run at once, never three", async () => {
    let active = 0;
    let peak = 0;
    const gate = agentGate({ a: "team", b: "team", c: "team" }, { team: 2 });
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
        maxConcurrency: 3,
        timeoutMs: 2000,
        retries: 0,
        canStartNode: gate.canStartNode,
        onStart: gate.onStart,
        onOutcome: gate.onOutcome,
      }
    );
    expect(result.status).toBe("completed");
    expect(peak).toBe(2);
  });

  it("deferred nodes are not deadlocked: all complete once slots free up", async () => {
    const done: string[] = [];
    const gate = agentGate(
      { a: "solo", b: "solo", c: "solo", d: "other" },
      { solo: 1, other: 1 }
    );
    const result = await runScheduler(
      nodes([
        ["a", []],
        ["b", []],
        ["c", []],
        ["d", []],
      ]),
      async (node) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        done.push(node.id);
        return { status: "completed" };
      },
      {
        maxConcurrency: 4,
        timeoutMs: 5000,
        retries: 0,
        canStartNode: gate.canStartNode,
        onStart: gate.onStart,
        onOutcome: gate.onOutcome,
      }
    );
    expect(result.status).toBe("completed");
    expect(done.sort()).toEqual(["a", "b", "c", "d"]);
    expect(result.failed).toEqual([]);
  });

  it("shouldRetryNode veto stops a retry the task can no longer pay for", async () => {
    let attempts = 0;
    const result = await runScheduler(
      nodes([["a", []]]),
      async () => {
        attempts += 1;
        return { status: "failed", error: "transient boom" } as NodeOutcome;
      },
      {
        maxConcurrency: 1,
        timeoutMs: 2000,
        retries: 3,
        retryDelayMs: 1,
        shouldRetryNode: () => false,
        onStart: async () => undefined,
        onOutcome: async () => undefined,
      }
    );
    expect(result.status).toBe("failed");
    expect(attempts).toBe(1);
  });

  it("a retryable failure that latches a halt keeps its own error (no 'Scheduling halted' overwrite) (e2e ULTRA)", async () => {
    let halt = false;
    let attempts = 0;
    const blocked: string[] = [];
    const result = await runScheduler(
      nodes([["a", []], ["b", ["a"]]]),
      async (node) => {
        if (node.id === "a") attempts += 1;
        return { status: "failed", error: "Subtask timed out after 300000ms" } as NodeOutcome;
      },
      {
        maxConcurrency: 1,
        timeoutMs: 2000,
        retries: 2,
        retryDelayMs: 1,
        shouldHaltNewNodes: () => halt,
        onStart: async () => undefined,
        // The decision hook chooses replan for the failure: halt latches.
        onOutcome: async () => {
          halt = true;
          return undefined;
        },
        onBlocked: async (node) => {
          blocked.push(node.id);
        },
      }
    );
    expect(attempts).toBe(1);
    expect(result.status).toBe("halted");
    expect(result.outcomes.get("a")).toMatchObject({ status: "failed", error: "Subtask timed out after 300000ms" });
    expect(blocked).not.toContain("a");
  });

  it("shouldRetryNode approval keeps the normal retry behavior", async () => {
    let attempts = 0;
    const result = await runScheduler(
      nodes([["a", []]]),
      async () => {
        attempts += 1;
        return attempts < 2
          ? ({ status: "failed", error: "transient boom" } as NodeOutcome)
          : ({ status: "completed" } as NodeOutcome);
      },
      {
        maxConcurrency: 1,
        timeoutMs: 2000,
        retries: 2,
        retryDelayMs: 1,
        shouldRetryNode: () => true,
        onStart: async () => undefined,
        onOutcome: async () => undefined,
      }
    );
    expect(result.status).toBe("completed");
    expect(attempts).toBe(2);
  });

  it("defers a node while a running node owns overlapping paths", async () => {
    let active = 0;
    let peak = 0;
    const result = await runScheduler(
      [
        { id: "a", dependencies: [], paths: ["apps/web"] },
        { id: "b", dependencies: [], paths: ["apps/web/features"] },
        { id: "c", dependencies: [], paths: ["apps/api"] },
      ],
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { status: "completed" };
      },
      {
        maxConcurrency: 3,
        timeoutMs: 2000,
        retries: 0,
        onStart: async () => undefined,
        onOutcome: async () => undefined,
      }
    );
    expect(result.status).toBe("completed");
    expect(peak).toBe(2);
  });

  it("classifies ownership refusals as permanent", () => {
    expect(isPermanentSubtaskError("Refusing to modify path outside declared ownership: x.ts")).toBe(true);
  });
});
